"""A routine's answer, delivered into a chat as the bot's own message (ADR 0081, spec #788).

Gots is a **delivery platform**, the shape ntfy already has. Hermes's own cron path carries the
text, retries it, and honours ``[SILENT]``, ``deliver: local``, ``failure_deliver`` and
``cron.delivery.notify``; this module is only what turns that delivery into a message in a chat:
Hermes's cron wrapper is stripped, and the words are written as an assistant row at the chat's
compression tip, with the display kind ``routine_message``, so the thread draws it as the bot's own
and the model reads it in its history.

The row is the one place Hermes has no writer to borrow. ``mirror_to_session`` drops the display
kind at the SQLite boundary, and the fenced, idempotent writers (``append_completion_note``,
``append_delegation_delivery``) write *user* rows, which would make the model read the routine's
words as the user's. So the write goes through ``SessionDB.append_message`` and this module owns the
fence: it takes the chat's turn lease at its compression-lineage root, waits briefly, and queues the
message when the chat is busy, writing it once the lease clears — a row written mid-turn splits a
streaming reply.

Nothing here imports Hermes at module load: the plugin has to import cleanly outside a host, so the
adapter's base class and the session store are reached at call time.
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
import re
import secrets
import sqlite3
import time
from contextlib import closing
from pathlib import Path
from typing import Any, Dict, List, NamedTuple, Optional, Tuple

from . import attachments, chats, events, push, sessions, ticker
from .store import connect, current_path, home_of

logger = logging.getLogger(__name__)

NAME = "gots"
LABEL = "Gots"
# Declared so `deliver: gots:main` is a legal cron target, and never set: with no home channel a bare
# `deliver: gots` resolves to no target and fails loudly, and `deliver: all` skips the platform, so
# every routine names the chat it speaks in.
HOME_ENV_VAR = "GOTS_HOME_CHANNEL"
# The display kind the row carries, and the feature `info` advertises for the route beside it.
KIND = "routine_message"
FEATURE = "routine_message"
OBJECT = "gots.routines"
SECTION = "gots_routines"
TARGET_MAIN = "main"
MAIN_PREFIX = "main-"
# Up to five files ride one message; the sixth is dropped and named in the delivery's warnings.
MAX_ATTACHMENTS = 5
MAX_ATTACHMENT_BYTES = attachments.MAX_BYTES
# A chat active this recently reads the delivery as an aside even with no turn running.
ASIDE_WINDOW_SECONDS = 15 * 60
# How long a delivery waits for a live turn before it queues instead.
WAIT_SECONDS = 8.0
POLL_SECONDS = 0.5
TICK_SECONDS = 20.0
LEASE_TTL_SECONDS = 60.0
# How many words a message may hold before it is cut: the app draws a message, not a document.
MAX_TEXT = 100_000

# The openers a delivery takes when the chat is in a turn or was active moments ago. Chosen once,
# when the message is taken, and stored with it: a queued message and a retry keep the same words.
# The provider merges consecutive assistant messages, so this opener is the only signal the model
# gets that the words are not a continuation of the reply above them (ADR 0081).
ASIDE_OPENERS: Tuple[str, ...] = (
    "On a side note, ",
    "As a quick aside, ",
    "While you were busy, ",
    "A quick note in passing, ",
    "Meanwhile, ",
    "One thing worth mentioning, ",
    "Separately, ",
    "Just so you know, ",
    "A small update from the background, ",
    "Coming back to something else, ",
    "Also, out of the blue, ",
    "A stray finding, ",
    "By the way, ",
    "Something came up, ",
    "A note from the wings, ",
)

_HEADER = re.compile(
    r"\ACronjob Response:[ \t]*(?P<title>[^\n]*)\n"
    r"\(job_id:[ \t]*(?P<job>[^)\n]*)\)\n"
    r"-{3,}\n\n"
)
_FOOTER = re.compile(
    r"\n\nTo stop or manage this job, send me a new message \(e\.g\. \"stop reminder [^\n]*\"\)\.\s*\Z"
)
_MEDIA_TAG = re.compile(r"MEDIA:\s*(?P<path>[^\s]+)")

# The writer's own wake-up: a message queued mid-turn is written as soon as that turn lets go.
_ticker = ticker.Ticker("routine messages")


def available() -> Optional[str]:
    """Why this host can't deliver a routine's message, or None when it can.

    The platform is registered by ``register``, and the row is written through Hermes's own session
    store; a host without either gets no route advertised rather than a chip that opens nothing.
    """
    if not _has_session_store():
        return "This Hermes version has no session store this plugin can write a message with."
    return None


def _has_session_store() -> bool:
    try:
        from hermes_state_registry import acquire  # noqa: F401
    except Exception:
        return False
    return True


# -- The cron wrapper ---------------------------------------------------------


def strip_wrapper(content: str) -> Tuple[str, Optional[str], Optional[str]]:
    """``(text, job_id, title)`` from a delivery: Hermes's framing for a channel, removed.

    The header names the routine and its job id — which is what the standalone lane has to attribute
    a message by, since it carries no routing metadata at all. A delivery Hermes didn't wrap
    (``cron.wrap_response: false``) comes back whole, with nothing to attribute it to.
    """
    text = content or ""
    job_id: Optional[str] = None
    title: Optional[str] = None
    header = _HEADER.match(text)
    if header:
        job_id = (header.group("job") or "").strip() or None
        title = (header.group("title") or "").strip() or None
        text = text[header.end():]
    text = _FOOTER.sub("", text)
    return text.strip(), job_id, title


# -- The chat a ref names -----------------------------------------------------


def _chat_of(entry: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    value = (entry or {}).get("value")
    if not isinstance(value, dict) or chats.closed(entry):
        return None
    session = value.get("hermesSessionId")
    if not isinstance(session, str) or not session:
        return None
    title = value.get("title")
    return {"session": session, "title": title if isinstance(title, str) and title else None}


def resolve_chat(path: Path, ref: str) -> Optional[Dict[str, Any]]:
    """The chat a delivery ref names — ``main`` being the bot's Main thread — or None.

    A ref reaches the adapter raw (no ``parse_target_ref_fn`` is declared, since declaring one makes
    cron strict and drops what it cannot parse), so this is the only place a ref becomes a chat.
    """
    wanted = (ref or "").strip()
    if not wanted:
        return None
    if wanted == TARGET_MAIN or wanted.startswith(MAIN_PREFIX):
        # Main is the one chat whose id the app derives, so it is found by that id and never guessed.
        for chat_id, entry in chats.read(path).items():
            if not chat_id.startswith(MAIN_PREFIX):
                continue
            found = _chat_of(entry)
            if found:
                return {"id": chat_id, **found}
        return None
    found = _chat_of(chats.one(path, wanted))
    return {"id": wanted, **found} if found else None


def chat_title(path: Path, ref: str) -> Optional[str]:
    found = resolve_chat(path, ref)
    return found.get("title") if found else None


# -- The chat's session, as Hermes holds it -----------------------------------


def _exists(home: Path, session_id: str) -> bool:
    conn = sessions._open_state(home)
    if conn is None:
        return False
    try:
        with closing(conn):
            return conn.execute("SELECT 1 FROM sessions WHERE id = ?", (session_id,)).fetchone() is not None
    except sqlite3.Error:
        return False


def recency(home: Path, session_id: str) -> Optional[float]:
    """When the chat last said anything: its last-activity stamp, its newest row, or its start."""
    conn = sessions._open_state(home)
    if conn is None:
        return None
    try:
        with closing(conn):
            row = conn.execute(
                "SELECT last_activity_at, started_at FROM sessions WHERE id = ?", (session_id,)
            ).fetchone()
            newest = conn.execute(
                "SELECT MAX(timestamp) FROM messages WHERE session_id = ?", (session_id,)
            ).fetchone()
    except sqlite3.Error:
        return None
    stamps = [value for value in (*(row or ()), (newest or (None,))[0]) if isinstance(value, (int, float))]
    return max(stamps) if stamps else None


def _store():
    """Hermes's session store for this profile, or None."""
    try:
        from hermes_state_registry import acquire

        return acquire()
    except Exception:
        logger.debug("gots: couldn't reach Hermes's session store", exc_info=True)
        return None


def _tip(db: Any, session_id: str) -> str:
    """The chat's compression tip: where a row written now belongs."""
    resolve = getattr(db, "resolve_resume_session_id", None)
    if callable(resolve):
        try:
            return str(resolve(session_id) or session_id)
        except Exception:
            logger.debug("gots: couldn't resolve %s to its tip", session_id, exc_info=True)
    return session_id


class Run(NamedTuple):
    """What a delivery knows about the run that produced it: the session it wrote, and its facts.

    The card says what ran and how long it took, and both come from the same row the session id
    does — Hermes's run listing hands back the whole session, and this is the part worth keeping.
    """

    session: Optional[str] = None
    model: Optional[str] = None
    seconds: Optional[float] = None


def _run(db: Any, job_id: Optional[str]) -> Run:
    """The newest run of ``job_id``: the session the chip opens, and how it went."""
    lister = getattr(db, "list_cron_job_runs", None)
    if not job_id or not callable(lister):
        return Run()
    try:
        rows = lister(job_id, limit=1) or []
    except Exception:
        logger.debug("gots: couldn't read the runs of %s", job_id, exc_info=True)
        return Run()
    first = rows[0] if rows else None
    if not isinstance(first, dict):
        return Run()
    found = first.get("id")
    return Run(
        str(found) if found else None,
        _model_of(first),
        _seconds_of(first),
    )


def _model_of(row: Dict[str, Any]) -> Optional[str]:
    """The model the run used, as the sheet names it: ``provider/model`` where both are known.

    A session keeps the model it ran on in its own column and the provider that billed it in another;
    a lock the app set carries both in ``model_config``. Whichever answers first wins, and a run that
    knows only half is named by that half rather than guessed at.
    """
    config = row.get("model_config")
    if isinstance(config, str) and config:
        try:
            config = json.loads(config)
        except (TypeError, ValueError):
            config = None
    config = config if isinstance(config, dict) else {}
    lock = config.get("browser_model_lock") if isinstance(config.get("browser_model_lock"), dict) else {}
    model = _named(row.get("model")) or _named(config.get("model")) or _named(lock.get("model"))
    provider = (
        _named(row.get("billing_provider"))
        or _named(config.get("provider"))
        or _named(lock.get("provider"))
    )
    if model and provider:
        return f"{provider}/{model}"
    return model


def _named(value: Any) -> Optional[str]:
    """A non-empty string, or None: an empty column names nothing."""
    return value if isinstance(value, str) and value.strip() else None


def _seconds_of(row: Dict[str, Any]) -> Optional[float]:
    """How long the run took, to a tenth of a second: a routine is often over inside one."""
    started, ended = row.get("started_at"), row.get("ended_at")
    if not isinstance(started, (int, float)) or not isinstance(ended, (int, float)):
        return None
    if ended < started:
        return None
    return round(float(ended) - float(started), 1)


def _execution(job_id: Optional[str], run_session: Optional[str]) -> str:
    """The delivery's dedupe key: one execution of one job writes one message."""
    if job_id and run_session:
        return f"{job_id}:{run_session}"
    if job_id:
        return f"{job_id}:{int(time.time() * 1000)}"
    return f"routine:{secrets.token_hex(8)}"


# -- The message --------------------------------------------------------------


def _acquire(db: Any, session_id: str, holder: str) -> bool:
    """Takes the chat's turn lease, which is the fence a row is written behind."""
    take = getattr(db, "try_acquire_session_turn_lease", None)
    if not callable(take):
        # No lease API means no turn to split: an older host writes the row at once rather than
        # queueing a message that could never be written, which is what a False here would do.
        return True
    try:
        return bool(take(session_id, holder, ttl_seconds=LEASE_TTL_SECONDS))
    except Exception:
        logger.debug("gots: couldn't take %s's turn lease", session_id, exc_info=True)
        return False


def _release(db: Any, session_id: str, holder: str) -> None:
    let_go = getattr(db, "release_session_turn_lease", None)
    if not callable(let_go):
        return
    try:
        let_go(session_id, holder)
    except Exception:
        logger.debug("gots: couldn't release %s's turn lease", session_id, exc_info=True)


def _write(db: Any, session_id: str, text: str, metadata: Dict[str, Any], holder: str) -> int:
    """Appends the assistant row at the chat's tip; returns its id.

    The row says it stopped, as a finished reply's does: the app reads a row with no finish reason as
    still streaming, so a message without one would leave the thread it landed in reading "working"
    until the next turn. Nothing about the row is unfinished — the run has already ended.
    """
    return int(
        db.append_message(
            session_id=session_id,
            role="assistant",
            content=text,
            display_kind=KIND,
            display_metadata={"routine": metadata},
            finish_reason="stop",
            turn_lease_holder=holder,
            turn_lease_ttl_seconds=LEASE_TTL_SECONDS,
        )
    )


def stage(home: Path, session_id: str, source: str) -> Optional[Path]:
    """Copies a delivered file into this profile's attachments folder, or None when it can't be.

    Hermes's media check is a denylist in default mode and an allowlist plus a recency window under
    strict, so a file left in the run's own working directory is gone — or refused — by the time the
    app asks for it. The copy is what the message names.
    """
    origin = Path(source)
    try:
        if not origin.is_file():
            return None
        if origin.stat().st_size > MAX_ATTACHMENT_BYTES:
            return None
        return attachments.save(home, session_id, origin.name, origin.read_bytes())
    except (OSError, ValueError):
        logger.warning("gots: couldn't stage %s for a routine's message", origin, exc_info=True)
        return None


def _with_media(text: str, staged: List[Path]) -> str:
    tags = "\n".join(f"MEDIA:{path}" for path in staged)
    return f"{text}\n\n{tags}" if tags else text


def _media_paths(text: str) -> List[str]:
    return [match.group("path") for match in _MEDIA_TAG.finditer(text or "")]


# -- The queue ----------------------------------------------------------------


def queued(path: Path) -> List[Dict[str, Any]]:
    """Messages waiting for their chat to be free, oldest first."""
    if not path.exists():
        return []
    conn = connect(path)
    try:
        rows = conn.execute(
            """SELECT execution, session_id, chat_id, job_id, title, run_session, model, seconds,
                      text, at, notify
               FROM routine_messages WHERE row IS NULL ORDER BY at"""
        ).fetchall()
    finally:
        conn.close()
    return [
        {
            "execution": execution,
            "session_id": session_id,
            "chat_id": chat_id,
            "job_id": job_id,
            "title": title,
            "run_session": run_session,
            "model": model,
            "seconds": seconds,
            "text": text,
            "at": at,
            "notify": bool(notify),
        }
        for execution, session_id, chat_id, job_id, title, run_session, model, seconds, text, at, notify in rows
    ]


def written(path: Path, execution: str) -> Optional[int]:
    """The row a delivery wrote, or None when it is queued or unknown."""
    if not path.exists():
        return None
    conn = connect(path)
    try:
        row = conn.execute("SELECT row FROM routine_messages WHERE execution = ?", (execution,)).fetchone()
    finally:
        conn.close()
    return int(row[0]) if row and row[0] is not None else None


def _remember(
    path: Path,
    *,
    execution: str,
    chat: Dict[str, Any],
    job_id: Optional[str],
    title: Optional[str],
    run: Run,
    text: str,
    row: Optional[int],
    notify: bool,
) -> None:
    conn = connect(path)
    try:
        conn.execute(
            """INSERT INTO routine_messages
                   (execution, session_id, chat_id, job_id, title, run_session, model, seconds,
                    text, at, row, notify)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(execution) DO UPDATE SET
                   row = COALESCE(excluded.row, routine_messages.row),
                   text = excluded.text""",
            (
                execution,
                chat["session"],
                chat["id"],
                job_id,
                title,
                run.session,
                run.model,
                run.seconds,
                text[:MAX_TEXT],
                int(time.time() * 1000),
                row,
                1 if notify else 0,
            ),
        )
    finally:
        conn.close()


def _message_meta(execution: str) -> Dict[str, Any]:
    """What a written row keeps of its delivery: the one fact a compaction can't restate.

    The row id moves when a chat compacts, so the row is found again by the delivery it belongs to —
    which is this. Job, title and run session are the routine_messages table's, and a second copy of
    them in the row's metadata would be a copy nothing reads and nothing can check.
    """
    return {"execution": execution}


def deliver(
    ref: str,
    content: str,
    metadata: Optional[Dict[str, Any]] = None,
    media: Optional[List[Tuple[str, bool]]] = None,
) -> Dict[str, Any]:
    """Delivers one routine answer into the chat ``ref`` names.

    Hermes calls this from the gateway (with ``metadata['job_id']`` and ``metadata['notify']``) or
    from the scheduler's standalone lane (with neither, so the job id comes out of the wrapper it is
    already stripping). Returns Hermes's send-result shape: ``{"success": True, "message_id": …}`` or
    ``{"error": "…"}``.
    """
    metadata = metadata or {}
    notify = metadata.get("notify") is not False
    path = current_path()
    home = home_of(path)
    chat = resolve_chat(path, ref)
    if chat is None:
        return {
            "error": (
                f"No chat on this bot is '{ref}'. A routine delivers to gots:main — this bot's Main "
                "thread — and only into a chat of this profile."
            )
        }
    text, job_id, title = strip_wrapper(content)
    job_id = job_id or (metadata.get("job_id") if isinstance(metadata.get("job_id"), str) else None)
    files = list(media or ())
    if not text and not files:
        # Nothing to say: Hermes suppresses [SILENT] before delivery, so an empty one is a no-op.
        return {"success": True, "message_id": None, "chat_id": chat["id"]}

    db = _store()
    if db is None:
        return {"error": "Hermes's session store isn't reachable, so a routine can't speak here."}
    try:
        tip = _tip(db, chat["session"])
        if not _exists(home, tip):
            return {
                "error": (
                    f"The chat '{ref}' has no Hermes session yet, so there is nothing to write a "
                    "message into. Open it in Gots and send one message first."
                )
            }
        run = _run(db, job_id)
        execution = _execution(job_id, run.session)
        already = written(path, execution)
        if already is not None:
            # The same execution delivered twice writes one message (a retry, or a mirrored replay).
            return {"success": True, "message_id": str(already), "chat_id": chat["id"], "execution": execution}
        return _deliver_now(path, home, db, chat, tip, text, files, execution, job_id, title, run, notify)
    except Exception as error:
        logger.warning("gots: a routine's message couldn't be delivered", exc_info=True)
        return {"error": f"Couldn't write the routine's message: {error}"}
    finally:
        try:
            from hermes_state_registry import release_or_close

            release_or_close(db)
        except Exception:
            logger.debug("gots: couldn't let go of the session store", exc_info=True)


def _deliver_now(
    path: Path,
    home: Path,
    db: Any,
    chat: Dict[str, Any],
    tip: str,
    text: str,
    files: List[Tuple[str, bool]],
    execution: str,
    job_id: Optional[str],
    title: Optional[str],
    run: Run,
    notify: bool,
) -> Dict[str, Any]:
    staged, dropped = _staged(home, chat["session"], files)
    holder = f"gots-routine-{secrets.token_hex(6)}"
    taken = _acquire(db, tip, holder)
    # A chat in a turn, or one that said something moments ago, reads the message as an aside.
    aside = (not taken) or _recent(home, tip)
    words = random.choice(ASIDE_OPENERS) + text if aside else text
    body = _with_media(words[:MAX_TEXT], staged)
    if not taken:
        deadline = time.monotonic() + WAIT_SECONDS
        while not taken and time.monotonic() < deadline:
            time.sleep(POLL_SECONDS)
            taken = _acquire(db, tip, holder)
    meta = _message_meta(execution)
    if not taken:
        # The chat is busy: the message waits, and is written once its turn lets the lease go.
        _remember(
            path, execution=execution, chat=chat, job_id=job_id, title=title, run=run,
            text=body, row=None, notify=notify,
        )
        wake()
        return {
            "success": True,
            "message_id": None,
            "chat_id": chat["id"],
            "execution": execution,
            "queued": True,
            "dropped": dropped,
        }
    try:
        row = _write(db, tip, body, meta, holder)
    finally:
        _release(db, tip, holder)
    _remember(
        path, execution=execution, chat=chat, job_id=job_id, title=title, run=run,
        text=body, row=row, notify=notify,
    )
    events.note("runs", chat["session"], path)
    if notify:
        # Inside the delivery, so [SILENT], deliver: local and cron.delivery.notify all inherit.
        push.notify(KIND, chat["session"], path=path)
    return {
        "success": True,
        "message_id": str(row),
        "chat_id": chat["id"],
        "execution": execution,
        "dropped": dropped,
    }


def _staged(
    home: Path, session_id: str, files: List[Tuple[str, bool]]
) -> Tuple[List[Path], List[str]]:
    """Stages what this delivery carries: at most five files, and every drop named."""
    staged: List[Path] = []
    dropped: List[str] = []
    for source, _is_voice in files:
        if len(staged) >= MAX_ATTACHMENTS:
            dropped.append(f"{Path(str(source)).name}: a routine's message carries {MAX_ATTACHMENTS} files")
            continue
        copy = stage(home, session_id, str(source))
        if copy is None:
            dropped.append(f"{Path(str(source)).name}: couldn't be copied into this bot's attachments")
            continue
        staged.append(copy)
    if dropped:
        logger.warning("gots: a routine's message dropped %d file(s): %s", len(dropped), "; ".join(dropped))
    return staged, dropped


def _recent(home: Path, session_id: str) -> bool:
    stamp = recency(home, session_id)
    return stamp is not None and (time.time() - stamp) < ASIDE_WINDOW_SECONDS


# -- Writing what waited ------------------------------------------------------


def write_queued(home: Path, path: Path) -> int:
    """Writes every queued message whose chat is free; returns how many landed."""
    landed = 0
    for item in queued(path):
        db = _store()
        if db is None:
            return landed
        try:
            chat = {"id": item["chat_id"], "session": item["session_id"], "title": item["title"]}
            tip = _tip(db, item["session_id"])
            if not _exists(home, tip):
                continue
            holder = f"gots-routine-{secrets.token_hex(6)}"
            if not _acquire(db, tip, holder):
                # Still in a turn: the message keeps its place in the queue.
                continue
            try:
                meta = _message_meta(item["execution"])
                row = _write(db, tip, item["text"], meta, holder)
            finally:
                _release(db, tip, holder)
            _remember(
                path, execution=item["execution"], chat=chat, job_id=item["job_id"], title=item["title"],
                run=Run(item["run_session"], item["model"], item["seconds"]),
                text=item["text"], row=row, notify=item["notify"],
            )
            events.note("runs", item["session_id"], path)
            if item["notify"]:
                push.notify(KIND, item["session_id"], path=path)
            landed += 1
        except Exception:
            logger.debug("gots: a queued routine message couldn't be written", exc_info=True)
        finally:
            try:
                from hermes_state_registry import release_or_close

                release_or_close(db)
            except Exception:
                pass
    return landed


def wake() -> None:
    """Has the writer look again now; safe from any thread (Hermes's hooks run in others)."""
    _ticker.wake()


async def run(adapter: Any, home: Path) -> None:
    """Writes the routine messages that waited, for as long as this server runs."""
    await _ticker.run(
        TICK_SECONDS, lambda: asyncio.to_thread(write_queued, home, current_path())
    )


# -- The route's answer -------------------------------------------------------


def routines(path: Path, home: Path, session_id: str) -> List[Dict[str, Any]]:
    """The routine messages a chat holds, each with the row it is drawn at now.

    The row is resolved at read time: a compaction re-emits carried rows under fresh ids while the
    display metadata survives, so the id stored when the message was written is stale after one.
    """
    if not path.exists() or not session_id:
        return []
    # The chat's own ids, not the one asked with: a rotation moves a chat to a child session, and the
    # device's record of it doesn't move, so asking by one id would name nothing after a compaction.
    ids = _lineage(home, session_id)
    marks = ", ".join("?" for _ in ids)
    conn = connect(path)
    try:
        rows = conn.execute(
            f"""SELECT execution, job_id, title, run_session, model, seconds, at
                FROM routine_messages
                WHERE session_id IN ({marks}) AND row IS NOT NULL ORDER BY at""",
            tuple(ids),
        ).fetchall()
    finally:
        conn.close()
    if not rows:
        return []
    current = _current_rows(home, session_id)
    found = []
    for execution, job_id, title, run_session, model, seconds, at in rows:
        row = current.get(execution)
        if row is None:
            continue
        found.append(
            {
                "row": row,
                "at": at,
                "job_id": job_id,
                "title": title,
                "run_session": run_session,
                "model": model,
                "seconds": seconds,
            }
        )
    return found


def _current_rows(home: Path, session_id: str) -> Dict[str, int]:
    """``execution -> the row that carries it now``, over the chat's whole compression lineage."""
    conn = sessions._open_state(home)
    if conn is None:
        return {}
    ids = _lineage(home, session_id)
    if not ids:
        return {}
    marks = ", ".join("?" for _ in ids)
    try:
        with closing(conn):
            rows = conn.execute(
                f"""SELECT id, json_extract(display_metadata, '$.routine.execution') AS execution
                    FROM messages WHERE session_id IN ({marks}) AND display_kind = ?
                    ORDER BY id""",
                (*ids, KIND),
            ).fetchall()
    except sqlite3.Error:
        logger.debug("gots: couldn't resolve the routine messages of %s", session_id, exc_info=True)
        return {}
    found: Dict[str, int] = {}
    for row_id, execution in rows:
        if isinstance(execution, str) and execution:
            found[execution] = int(row_id)
    return found


def _lineage(home: Path, session_id: str) -> List[str]:
    """The chat's session and every compression continuation below it, oldest first.

    A chat moves on to a child session when it compacts, and the rows are re-emitted there under
    fresh ids, so the message is looked for at the tip as well as where it was written. A child that
    forks off its parent — a branch, a delegation, a reset, or a session a tool made — is another
    conversation, which is Hermes's own step (``_CHAIN_STEP_SQL``) and ``sessions.chat_session``'s.
    """
    conn = sessions._open_state(home)
    if conn is None:
        return []
    ids = [session_id]
    try:
        with closing(conn):
            current = session_id
            for _ in range(sessions.COMPRESSION_DEPTH):
                row = conn.execute(
                    """SELECT child.id AS id, child.source AS source,
                              child.model_config AS model_config
                       FROM sessions child JOIN sessions parent ON parent.id = child.parent_session_id
                       WHERE child.parent_session_id = ? AND parent.end_reason = 'compression'
                       ORDER BY child.started_at DESC LIMIT 1""",
                    (current,),
                ).fetchone()
                if row is None or row["id"] in ids or _forks(row):
                    break
                ids.append(str(row["id"]))
                current = str(row["id"])
    except sqlite3.Error:
        logger.debug("gots: couldn't walk the lineage of %s", session_id, exc_info=True)
    return ids


def _forks(row: sqlite3.Row) -> bool:
    """Whether a child forks off its parent instead of continuing it."""
    if (row["source"] or "") == "tool":
        return True
    try:
        config = json.loads(row["model_config"] or "{}")
    except ValueError:
        return False
    return isinstance(config, dict) and any(
        config.get(marker) for marker in ("_branched_from", "_delegate_from", "_reset_from")
    )


# -- The adapter --------------------------------------------------------------


class RoutineDelivery:
    """The adapter's own behaviour: outbound only, and every send is a row in a chat.

    A surface that cannot wake a turn must not promise one, so ``supports_async_delivery`` is false.
    """

    supports_async_delivery = False
    MAX_MESSAGE_LENGTH = 0

    def __init__(self, config: Any, platform: Any = None) -> None:
        self.config = config
        self.platform = platform
        # The execution this adapter last wrote, per chat: Hermes hands a delivery's files over one
        # call each, after the text, and they belong to the message that text became.
        self._wrote: Dict[str, str] = {}

    async def connect(self, *, is_reconnect: bool = False) -> bool:
        mark = getattr(self, "_mark_connected", None)
        if callable(mark):
            mark()
        logger.info("gots: the Gots platform is connected — routines deliver into this bot's chats")
        return True

    async def disconnect(self) -> None:
        return None

    async def send(self, chat_id: str, content: str, reply_to: Optional[str] = None,
                   metadata: Optional[dict[str, Any]] = None) -> Any:
        result = await asyncio.to_thread(deliver, chat_id, content, metadata or {})
        if result.get("execution"):
            self._wrote[chat_id] = result["execution"]
        return _send_result(result)

    async def _attach(self, chat_id: str, path: str) -> Any:
        """Adds one delivered file to the message this adapter just wrote in this chat."""
        result = await asyncio.to_thread(attach, chat_id, path, self._wrote.get(chat_id))
        return _send_result(result)

    async def send_image_file(self, chat_id: str, image_path: str, caption: Optional[str] = None,
                              reply_to: Optional[str] = None, metadata: Optional[dict[str, Any]] = None,
                              **kwargs: Any) -> Any:
        return await self._attach(chat_id, image_path)

    async def send_document(self, chat_id: str, file_path: str, caption: Optional[str] = None,
                            file_name: Optional[str] = None, reply_to: Optional[str] = None,
                            metadata: Optional[dict[str, Any]] = None, **kwargs: Any) -> Any:
        return await self._attach(chat_id, file_path)

    async def send_video(self, chat_id: str, video_path: str, caption: Optional[str] = None,
                         reply_to: Optional[str] = None, metadata: Optional[dict[str, Any]] = None,
                         **kwargs: Any) -> Any:
        return await self._attach(chat_id, video_path)

    async def send_voice(self, chat_id: str, audio_path: str, caption: Optional[str] = None,
                         reply_to: Optional[str] = None, metadata: Optional[dict[str, Any]] = None,
                         **kwargs: Any) -> Any:
        return await self._attach(chat_id, audio_path)

    async def get_chat_info(self, chat_id: str) -> dict[str, Any]:
        title = await asyncio.to_thread(chat_title, current_path(), chat_id)
        return {"name": title or chat_id, "type": "dm", "chat_id": chat_id}


def _send_result(result: Dict[str, Any]) -> Any:
    """Hermes's ``SendResult`` when the host has one, else the dict itself."""
    try:
        from gateway.platforms.base import SendResult

        if result.get("error"):
            return SendResult(success=False, error=result["error"])
        return SendResult(success=True, message_id=result.get("message_id"))
    except Exception:
        return result


def attach(
    ref: str, source: str, execution: Optional[str] = None
) -> Dict[str, Any]:
    """Stages one file Hermes handed over after the text, and names it on that message.

    The gateway's live lane sends a delivery's files one call each (``send_image_file`` and
    friends), so the tag is added to the row the text already wrote. The adapter names the delivery
    it wrote, which is what keeps two routines delivering at once from swapping files; without one,
    the chat's newest message is the only answer there is.
    """
    path = current_path()
    home = home_of(path)
    chat = resolve_chat(path, ref)
    if chat is None:
        return {"error": f"No chat on this bot is '{ref}'."}
    conn = connect(path)
    try:
        if execution:
            last = conn.execute(
                "SELECT execution, text, row FROM routine_messages WHERE execution = ?",
                (execution,),
            ).fetchone()
        else:
            last = conn.execute(
                """SELECT execution, text, row FROM routine_messages
                   WHERE session_id = ? AND row IS NOT NULL ORDER BY at DESC LIMIT 1""",
                (chat["session"],),
            ).fetchone()
    finally:
        conn.close()
    if last is None:
        return {"error": "A routine's file arrived with no message of its own to name it on."}
    execution, text, landed = last
    carried = _media_paths(text)
    if len(carried) >= MAX_ATTACHMENTS:
        return {"error": f"A routine's message carries {MAX_ATTACHMENTS} files; this one was dropped."}
    staged = stage(home, chat["session"], source)
    if staged is None:
        return {"error": f"{Path(str(source)).name} couldn't be copied into this bot's attachments."}
    updated = _with_media(text, [staged])
    if not landed:
        # The message is still waiting for the chat: its file is named on the words it will be
        # written with, which is the only copy of them that becomes a row.
        conn = connect(path)
        try:
            conn.execute(
                "UPDATE routine_messages SET text = ? WHERE execution = ?", (updated[:MAX_TEXT], execution)
            )
        finally:
            conn.close()
        return {"success": True, "queued": True}
    row = _current_rows(home, chat["session"]).get(execution)
    if row is None:
        return {"error": "The routine's message isn't in this chat any more, so its file has nowhere to go."}
    if not _rewrite(home, row, updated):
        return {"error": "Couldn't name that file on the routine's message."}
    conn = connect(path)
    try:
        conn.execute("UPDATE routine_messages SET text = ? WHERE execution = ?", (updated[:MAX_TEXT], execution))
    finally:
        conn.close()
    return {"success": True}


def _rewrite(home: Path, row: int, text: str) -> bool:
    """Rewrites a routine message's words, which is how a delivered file is named on it.

    The row's own content is a plain string (a message, not a multimodal part), so the update is the
    one column; Hermes's FTS trigger keeps the search index in step.
    """
    state = home / "state.db"
    if not state.exists():
        return False
    try:
        with closing(sqlite3.connect(state, timeout=5, isolation_level=None)) as conn:
            return conn.execute(
                "UPDATE messages SET content = ? WHERE id = ? AND display_kind = ?",
                (text[:MAX_TEXT], row, KIND),
            ).rowcount > 0
    except sqlite3.Error:
        logger.debug("gots: couldn't add a file to a routine's message", exc_info=True)
        return False


# -- The scheduler's lane -----------------------------------------------------


async def standalone_send(
    pconfig: Any,
    chat_id: str,
    message: str,
    *,
    thread_id: Optional[str] = None,
    media_files: Optional[list] = None,
    force_document: bool = False,
) -> Dict[str, Any]:
    """Out-of-process delivery for a scheduler running without a gateway.

    No routing metadata reaches this lane at all, so the job id comes out of the wrapper line the
    adapter is already removing, and a message it cannot attribute simply has no chip. ``thread_id``
    and ``force_document`` are signature parity: a Gots chat has no threads and no documents.
    """
    result = await asyncio.to_thread(deliver, chat_id, message, {}, list(media_files or ()))
    if result.get("error"):
        return {"error": result["error"]}
    return {"success": True, "platform": NAME, "chat_id": result.get("chat_id", chat_id),
            "message_id": result.get("message_id")}


# -- Registration -------------------------------------------------------------


def _configured(config: Any) -> bool:
    """A Gots platform needs no credential: enabled is configured, and Hermes checks that."""
    return True


def adapter_factory(config: Any) -> Any:
    """Builds the adapter Hermes runs: the host's base class, this module's behaviour."""
    from gateway.config import Platform
    from gateway.platforms.base import BasePlatformAdapter

    cls = type("RoutineAdapter", (RoutineDelivery, BasePlatformAdapter), {})
    return cls(config=config, platform=Platform(NAME))


def register(ctx: Any) -> bool:
    """Registers Gots as a delivery platform, or leaves the plugin running without one."""
    register_platform = getattr(ctx, "register_platform", None)
    if not callable(register_platform):
        logger.warning("gots: this Hermes version can't add a delivery platform; routines stay local")
        return False
    try:
        from gateway.platforms.send_targets import parse_nonempty
    except Exception:
        logger.warning("gots: this Hermes version can't add a delivery platform; routines stay local")
        return False
    try:
        register_platform(
            name=NAME,
            label=LABEL,
            adapter_factory=adapter_factory,
            check_fn=_has_session_store,
            validate_config=_configured,
            is_connected=_configured,
            cron_deliver_env_var=HOME_ENV_VAR,
            standalone_sender_fn=standalone_send,
            # A hint, never an authority: declaring `parse_target_ref_fn` makes cron strict and drops
            # a ref it cannot parse, and `gots:main` reaches the adapter raw.
            target_ref_syntax_fn=parse_nonempty,
            emoji="💬",
            pii_safe=True,
            allow_update_command=False,
            platform_hint="",
        )
    except Exception:
        logger.warning("gots: this Hermes refused the Gots platform; routines stay local", exc_info=True)
        return False
    logger.info("gots: routines deliver into this bot's chats (%s:%s)", NAME, TARGET_MAIN)
    return True


PROMPT = (
    "## Routines deliver into this chat\n\n"
    "When you create a routine with `cronjob`, pass `deliver: gots:main`. Its answer then arrives in "
    "this bot's Main thread as your own message, and the user can reply to it there. `gots:main` is "
    "the only Gots target: a routine left on `local`, or pointed anywhere else, finishes where the "
    "user will not read it. This applies to every routine you make in this chat.\n"
)


def content(_session: Any = None) -> str:
    """The system-prompt section telling the model where a routine's answer goes."""
    return PROMPT


def register_section(ctx: Any) -> bool:
    """Tells a new session's prompt where a routine's answer is delivered."""
    register = getattr(ctx, "register_system_prompt_section", None)
    if not callable(register):
        return False
    try:
        register(SECTION, content, position="after_memory")
    except Exception:
        logger.warning("gots: couldn't tell the model where routines deliver", exc_info=True)
        return False
    return True


def fill_deliver(**kwargs: Any) -> Optional[Dict[str, Any]]:
    """The ``pre_tool_call`` directive: a routine created in a Gots chat names where it speaks.

    ``deliver`` is filled only when the model omitted it, so an explicit choice always wins, and
    ``attach_to_session`` is turned off for a Gots target because Hermes would otherwise mirror the
    same delivery into the chat a second time, as a user row. The directive rewrites the arguments
    before the tool records them; a ``post_tool_call`` rewrite would be a second write after the
    model was already told something else, and its return value is ignored anyway.
    """
    try:
        return _fill_deliver(kwargs)
    except Exception:
        logger.debug("gots: couldn't name where a routine delivers", exc_info=True)
        return None


def _asked_in_a_chat(session_id: Any) -> bool:
    """Whether this tool call is happening in one of this bot's chats, by its Hermes session."""
    if not isinstance(session_id, str) or not session_id:
        return False
    try:
        found = chats.read(current_path())
    except Exception:
        return False
    return any(
        ((chat.get("value") or chat).get("hermesSessionId")) == session_id
        for chat in (found.values() if isinstance(found, dict) else found)
    )


def _fill_deliver(kwargs: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    if kwargs.get("tool_name") != "cronjob":
        return None
    args = kwargs.get("args")
    if not isinstance(args, dict) or args.get("action") != "create":
        return None
    # Only a routine asked for in one of this bot's chats is answered in it: a routine created from
    # Telegram or a terminal belongs where it was asked for, and sweeping it into Main would be a
    # delivery the user never asked this bot for.
    if not _asked_in_a_chat(kwargs.get("session_id")):
        return None
    deliver = args.get("deliver")
    fill: Dict[str, Any] = {}
    if not (isinstance(deliver, str) and deliver.strip()):
        fill["deliver"] = f"{NAME}:{TARGET_MAIN}"
        deliver = fill["deliver"]
    targets = [part.strip().lower() for part in str(deliver).split(",") if part.strip()]
    if targets and all(part == NAME or part.startswith(f"{NAME}:") for part in targets):
        if args.get("attach_to_session") is not False:
            fill["attach_to_session"] = False
    return {"action": "modify", "args": fill} if fill else None
