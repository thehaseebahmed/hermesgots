"""A routine's delivery is a row of the bot's chat list: one per run (G4).

Gots is a **delivery platform**, the shape ntfy already has: registered with ``ctx.register_platform``,
outbound only, with a ``standalone_sender_fn`` for a scheduler running without a gateway. Hermes's own
cron path already carries the text, retries it, and honours ``[SILENT]``, ``deliver: local``,
``failure_deliver`` and ``cron.delivery.notify``; this module is only what turns a delivery into
something the app lists.

``gots`` is the only channel a routine delivers to, and a ref is a **channel** rather than an address:
whatever target a stored job named is handed over and ignored, so a job stored with
``deliver: gots:main`` keeps delivering although this plugin has no chats to address.

Nothing is written into a transcript. The run already wrote its own answer, in a session of its own,
so the delivery publishes one chat record — ``routine-<job>-<run>`` — carrying the routine's name, the
run's session as the chat's session, the answer's first line and the delivery's time. Opening the row
opens the run's transcript; a second delivery of the same execution finds the record and writes
nothing, and a record the reader deleted is still a record, so a replay doesn't resurrect it.

Nothing here imports Hermes at module load: the plugin has to import cleanly outside a host, so the
adapter's base class and the run ledger are reached at call time.
"""

from __future__ import annotations

import asyncio
import logging
import re
import sqlite3
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from . import chats, link, push
from .store import connect, current_path, db_path, home_of

logger = logging.getLogger(__name__)

NAME = "gots"
LABEL = "Gots"
# The home channel a bare `deliver: gots` resolves to, written into the profile's `.env` at register
# (`link.set_env`): Hermes resolves a platform's cron target through this var, and a bare `gots` has no
# legal target without one. Its value is the channel itself — a ref names no address here.
HOME_ENV_VAR = "GOTS_HOME_CHANNEL"
HOME_CHANNEL = NAME
# The push a delivery sends, and the kind the registry and the app know it by.
KIND = "routine_message"
SECTION = "gots_routines"
# The id prefix a routine's row carries: what tells a list it wears the routine's icon rather than a
# chat's, and what the app derives its address from.
ROW_PREFIX = "routine-"
# How much of the answer a row shows as its line: the app draws a list row, not a document.
LINE_MAX = 200

_HEADER = re.compile(
    r"\ACronjob Response:[ \t]*(?P<title>[^\n]*)\n"
    r"\(job_id:[ \t]*(?P<job>[^)\n]*)\)\n"
    r"-{3,}\n\n"
)
_FOOTER = re.compile(
    r"\n\nTo stop or manage this job, send me a new message \(e\.g\. \"stop reminder [^\n]*\"\)\.\s*\Z"
)


# -- The cron wrapper ---------------------------------------------------------


def strip_wrapper(content: str) -> Tuple[str, Optional[str], Optional[str]]:
    """``(text, job_id, title)`` from a delivery: Hermes's framing for a channel, removed.

    The header names the routine and its job id — which is what the standalone lane has to attribute
    a delivery by, since it carries no routing metadata at all. A delivery Hermes didn't wrap
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


# -- The run a delivery belongs to --------------------------------------------


def _has_session_store() -> bool:
    try:
        from hermes_state_registry import acquire  # noqa: F401
    except Exception:
        return False
    return True


def _store() -> Any:
    """Hermes's session store for this profile, or None."""
    try:
        from hermes_state_registry import acquire

        return acquire()
    except Exception:
        logger.debug("gots: couldn't reach Hermes's session store", exc_info=True)
        return None


def _let_go(db: Any) -> None:
    try:
        from hermes_state_registry import release_or_close

        release_or_close(db)
    except Exception:
        logger.debug("gots: couldn't let go of the session store", exc_info=True)


def run_session(job_id: str) -> Optional[str]:
    """The session the job's newest run wrote in, or None when the host can't name it.

    The run's own session is what the row opens: a delivery nothing can attribute to one has nothing
    to publish, since a row whose session is unknown would open an empty chat.
    """
    db = _store()
    if db is None:
        return None
    try:
        lister = getattr(db, "list_cron_job_runs", None)
        if not callable(lister):
            return None
        rows = lister(job_id, limit=1) or []
        first = rows[0] if rows else None
        found = first.get("id") if isinstance(first, dict) else None
        return str(found) if found else None
    except Exception:
        logger.debug("gots: couldn't read the runs of %s", job_id, exc_info=True)
        return None
    finally:
        _let_go(db)


def _job_name(job_id: str) -> Optional[str]:
    """The routine's own name, for a delivery Hermes didn't wrap one into."""
    try:
        from cron.jobs import list_jobs

        for job in list_jobs(include_disabled=True) or []:
            if job.get("id") == job_id:
                name = job.get("name")
                return name.strip() if isinstance(name, str) and name.strip() else None
    except Exception:
        logger.debug("gots: couldn't read the name of %s", job_id, exc_info=True)
    return None


def routine_name(job_id: str, title: Optional[str]) -> str:
    """What the row is called: the delivery's own title, the routine's name, or the platform's."""
    return title or _job_name(job_id) or LABEL


# -- The row ------------------------------------------------------------------


def row_of(job_id: str, run_session: str) -> str:
    """The chat id one run's row has: its job and the execution that ran it.

    Derived rather than minted, so the same execution is always the same row — a retry finds the
    record the first delivery wrote instead of adding a second one.
    """
    return f"{ROW_PREFIX}{job_id}-{run_session}"[: chats.MAX_ID_LENGTH]


def first_line(text: str) -> str:
    """A delivery's first line, as a list row shows it: one line, bounded."""
    for line in (text or "").splitlines():
        found = " ".join(line.split())
        if found:
            return found[:LINE_MAX]
    return ""


def publish(
    path: Path,
    *,
    job_id: str,
    run_session: str,
    title: str,
    text: str,
    at: Optional[int] = None,
) -> Optional[str]:
    """Publishes the row one run gets, or None when that run already has one.

    The record is keyed by the job and the execution, so a repeat delivery of one execution writes
    nothing. A record the reader deleted is still a record — a tombstone merges like any other — so a
    replay leaves it deleted rather than resurrecting a row they are done with.
    """
    row_id = row_of(job_id, run_session)
    if chats.one(path, row_id) is not None:
        return None
    now = int(time.time() * 1000) if at is None else int(at)
    value = {
        "title": title,
        "titleEdited": True,
        "hermesSessionId": run_session,
        "createdAt": now,
        "updatedAt": now,
        # The marker a bot's list draws the routine's icon from, rather than a chat's (ADR 0137).
        "routine": True,
        "line": first_line(text),
    }
    chats.merge(path, {row_id: {"at": now, "value": value}})
    return row_id


# -- Delivery -----------------------------------------------------------------


def deliver(
    ref: str,
    content: str,
    metadata: Optional[Dict[str, Any]] = None,
    media: Optional[List[Tuple[str, bool]]] = None,
) -> Dict[str, Any]:
    """Publishes one routine answer as its run's row.

    Hermes calls this from the gateway (with ``metadata['job_id']`` and ``metadata['notify']``) or from
    the scheduler's standalone lane (with neither, so the job id comes out of the wrapper it is already
    stripping), and ``ref`` is the target half of the channel a job named: ``main`` from a job stored as
    ``deliver: gots:main``, a chat id from an older one, or the home channel's ``gots`` from a bare
    ``deliver: gots``. None of that is an address any more, so none of it is read — which is what keeps
    every stored job delivering.

    ``media`` is Hermes's own argument and carries a delivery's files: a row about a run has no message
    of its own to name them on — the run's transcript is the row — so a file is accepted and not
    carried.

    Returns Hermes's send-result shape: ``{"success": True, "message_id": …}`` or ``{"error": "…"}``.
    """
    metadata = metadata or {}
    text, job_id, title = strip_wrapper(content)
    found = metadata.get("job_id")
    job_id = job_id or (found if isinstance(found, str) and found else None)
    if not text:
        # Nothing to say: Hermes suppresses [SILENT] before delivery, so an empty one is a no-op.
        return {"success": True, "message_id": None}
    if not job_id:
        logger.warning("gots: a routine's answer to '%s' names no routine, so nothing is published", ref)
        return {"success": True, "message_id": None}
    run = run_session(job_id)
    if run is None:
        logger.warning(
            "gots: the routine %s's answer names no run, so nothing is published for it", job_id
        )
        return {"success": True, "message_id": None}
    path = current_path()
    row_id = publish(path, job_id=job_id, run_session=run, title=routine_name(job_id, title), text=text)
    if row_id is None:
        # The same execution delivered twice publishes one row (a retry, or a mirrored replay), and a
        # retry is not news: nothing is announced the second time.
        return {"success": True, "message_id": None, "chat_id": row_of(job_id, run)}
    if metadata.get("notify") is not False:
        # Inside the delivery, so [SILENT], deliver: local and cron.delivery.notify all inherit.
        push.notify(KIND, run, path=path)
    return {"success": True, "message_id": row_id, "chat_id": row_id}


# -- What an older plugin left queued -----------------------------------------


def publish_waiting(home: Path) -> int:
    """Publishes the deliveries an older plugin queued, then drops the table it queued them in.

    Those rows waited for a chat's turn to end; the write path that would have written them is gone, so
    each becomes the row it would be now — the run it names, published once, with the time it was
    delivered, and announced the way a delivery landing now is — rather than being lost at the upgrade.

    The table (v51's ``routine_messages``) goes only once nothing in it was left behind. A row naming no
    routine, or no run, is one nothing can publish — a row whose run is unknown would open an empty
    chat — so it is kept and logged by its execution instead: the queue is small, and dropping it would
    be the one way a delivery disappears without a trace. A row the old path already wrote into a
    chat's transcript is not queued at all: it went where the old app drew it, and the table takes that
    with it.

    Answers how many rows it published.
    """
    path = db_path(home)
    if not path.exists():
        return 0
    published = 0
    kept = 0
    for item in _waiting(path):
        if not item["job_id"] or not item["run_session"]:
            kept += 1
            logger.warning(
                "gots: a routine delivery left queued in %s (%s) names no %s, so it is kept rather "
                "than dropped",
                path,
                item["execution"] or "no execution",
                "routine" if not item["job_id"] else "run",
            )
            continue
        title = routine_name(item["job_id"], item["title"])
        if publish(
            path,
            job_id=item["job_id"],
            run_session=item["run_session"],
            title=title,
            text=item["text"],
            at=item["at"],
        ):
            published += 1
            # Inside the publishing, so a delivery announced at the upgrade reaches the device the
            # way one that lands now does (`deliver`), and a row queued as not-notifying stays quiet.
            if item["notify"]:
                push.notify(KIND, item["run_session"], path=path)
    if not kept:
        _drop_waiting(path)
    return published


def _waiting(path: Path) -> List[Dict[str, Any]]:
    """The deliveries an older plugin queued and never wrote, oldest first.

    Every unwritten row, including the ones nothing can attribute: which of them can be published is
    ``publish_waiting``'s to decide, since keeping the table is what it does with the rest.
    """
    conn = connect(path)
    try:
        rows = conn.execute(
            """SELECT execution, job_id, title, run_session, text, at, notify
               FROM routine_messages WHERE row IS NULL ORDER BY at"""
        ).fetchall()
    except sqlite3.OperationalError:
        # A store that never had the table: the write path is long gone.
        return []
    finally:
        conn.close()
    return [
        {
            "execution": execution,
            "job_id": str(job_id) if job_id else None,
            "title": title,
            "run_session": str(run_session) if run_session else None,
            "text": text,
            "at": at,
            "notify": True if notify is None else bool(notify),
        }
        for execution, job_id, title, run_session, text, at, notify in rows
    ]


def _drop_waiting(path: Path) -> None:
    """Drops v51's table: nothing reads it now that the write path is gone."""
    conn = connect(path)
    try:
        conn.execute("DROP TABLE IF EXISTS routine_messages")
    except sqlite3.Error:
        logger.debug("gots: couldn't drop the routine messages table", exc_info=True)
    finally:
        conn.close()


async def resume(homes: Iterable[Path]) -> None:
    """Publishes what an older plugin left queued, on every home this process serves.

    Not just its own: a ``/p/<profile>`` bot keeps its own store, and one home's trouble is that home's.
    """
    for home in homes:
        try:
            published = await asyncio.to_thread(publish_waiting, home)
        except Exception:
            logger.warning("gots: couldn't publish what %s had queued", home, exc_info=True)
            continue
        if published:
            logger.info("gots: published %d routine deliver%s left queued", published, "y" if published == 1 else "ies")


# -- The adapter --------------------------------------------------------------


class RoutineDelivery:
    """The adapter's own behaviour: outbound only, and every send publishes its run's row.

    A surface that cannot wake a turn must not promise one, so ``supports_async_delivery`` is false.
    """

    supports_async_delivery = False
    MAX_MESSAGE_LENGTH = 0

    def __init__(self, config: Any, platform: Any = None) -> None:
        self.config = config
        self.platform = platform

    async def connect(self, *, is_reconnect: bool = False) -> bool:
        mark = getattr(self, "_mark_connected", None)
        if callable(mark):
            mark()
        logger.info("gots: the Gots platform is connected — a routine's run is a row of this bot's chats")
        return True

    async def disconnect(self) -> None:
        return None

    async def send(self, chat_id: str, content: str, reply_to: Optional[str] = None,
                   metadata: Optional[dict[str, Any]] = None) -> Any:
        result = await asyncio.to_thread(deliver, chat_id, content, metadata or {})
        return _send_result(result)

    async def _carried(self, chat_id: str, source: str) -> Any:
        """A delivered file: accepted, and not carried — see ``deliver``'s note on ``media``."""
        logger.debug("gots: a routine's file (%s) has no row of its own to be named on", source)
        return _send_result({"success": True})

    async def send_image_file(self, chat_id: str, image_path: str, caption: Optional[str] = None,
                              reply_to: Optional[str] = None, metadata: Optional[dict[str, Any]] = None,
                              **kwargs: Any) -> Any:
        return await self._carried(chat_id, image_path)

    async def send_document(self, chat_id: str, file_path: str, caption: Optional[str] = None,
                            file_name: Optional[str] = None, reply_to: Optional[str] = None,
                            metadata: Optional[dict[str, Any]] = None, **kwargs: Any) -> Any:
        return await self._carried(chat_id, file_path)

    async def send_video(self, chat_id: str, video_path: str, caption: Optional[str] = None,
                         reply_to: Optional[str] = None, metadata: Optional[dict[str, Any]] = None,
                         **kwargs: Any) -> Any:
        return await self._carried(chat_id, video_path)

    async def send_voice(self, chat_id: str, audio_path: str, caption: Optional[str] = None,
                         reply_to: Optional[str] = None, metadata: Optional[dict[str, Any]] = None,
                         **kwargs: Any) -> Any:
        return await self._carried(chat_id, audio_path)

    async def get_chat_info(self, chat_id: str) -> dict[str, Any]:
        # A delivery names no chat any more, so there is no chat to describe: the channel's own name is
        # the only true answer.
        return {"name": LABEL, "type": "dm", "chat_id": chat_id}


def _send_result(result: Dict[str, Any]) -> Any:
    """Hermes's ``SendResult`` when the host has one, else the dict itself."""
    try:
        from gateway.platforms.base import SendResult

        if result.get("error"):
            return SendResult(success=False, error=result["error"])
        return SendResult(success=True, message_id=result.get("message_id"))
    except Exception:
        return result


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
    adapter is already removing. ``thread_id`` and ``force_document`` are signature parity: a Gots
    delivery has no threads and no documents.
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


def name_channel(homes: Iterable[Path]) -> List[Path]:
    """Writes the home channel a bare ``deliver: gots`` resolves to into each home's ``.env``.

    A host may serve several profiles (`link.served_homes`), and each profile's cron resolves the
    channel out of its own file: a line written into one home leaves every other profile's bare
    ``gots`` with no legal target, which is the write this exists for. The writer is the one linking
    already uses, so the file keeps the shape link leaves in it.

    Answers the homes whose file couldn't be written. A profile that refuses the line keeps working
    for every job that names a target — only a bare ``gots`` is refused by Hermes — so one unreadable
    file is a warning naming it rather than a write that gives up on the rest.
    """
    failed: List[Path] = []
    for home in homes:
        try:
            link.set_env(Path(home), HOME_ENV_VAR, HOME_CHANNEL)
        except Exception:
            logger.warning(
                "gots: couldn't write %s to %s", HOME_ENV_VAR, Path(home) / ".env", exc_info=True
            )
            failed.append(Path(home))
    return failed


def register(ctx: Any) -> bool:
    """Registers Gots as a delivery platform, and makes a bare `deliver: gots` a legal target."""
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
    # A bare `deliver: gots` has no legal target without a home channel, so registering the platform
    # is when the profile it is loaded into is given one. The homes this process serves past its own
    # are named where the adapter is in hand (`_wire_api_server`).
    failed = name_channel([home_of(current_path())])
    if failed:
        logger.warning(
            "gots: %s is missing from %s, so a bare `deliver: gots` is refused there",
            HOME_ENV_VAR,
            ", ".join(str(home) for home in failed),
        )
    logger.info("gots: a routine delivers to %s, and its run is a row of this bot's chats", NAME)
    return True


PROMPT = (
    "## Routines deliver to Gots\n\n"
    "When you create a routine with `cronjob`, pass `deliver: gots`. Each run then arrives in this "
    "bot's chats as a row of its own — the run's transcript, under the routine's name — and the user "
    "can read it there. `gots` is the only channel: a routine left on `local`, or pointed at another "
    "platform, finishes where the user will not read it. This applies to every routine you make in "
    "this chat.\n"
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
    """The ``pre_tool_call`` directive: a routine created in a Gots chat names its channel.

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
    # Only a routine asked for in one of this bot's chats is answered here: a routine created from
    # Telegram or a terminal belongs where it was asked for, and sweeping it into this bot's rows
    # would be a delivery the user never asked it for.
    if not _asked_in_a_chat(kwargs.get("session_id")):
        return None
    deliver = args.get("deliver")
    fill: Dict[str, Any] = {}
    if not (isinstance(deliver, str) and deliver.strip()):
        fill["deliver"] = NAME
        deliver = fill["deliver"]
    targets = [part.strip().lower() for part in str(deliver).split(",") if part.strip()]
    if targets and all(part == NAME or part.startswith(f"{NAME}:") for part in targets):
        if args.get("attach_to_session") is not False:
            fill["attach_to_session"] = False
    return {"action": "modify", "args": fill} if fill else None
