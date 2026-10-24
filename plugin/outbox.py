"""Messages the user sent while a session's run was going (``sessions/{id}/queue``).

They wait here, on the host, rather than on the phone: when the run ends, the plugin starts the next
one itself, so a queue the user leaves behind still goes with the app closed. Each item carries the
``POST /v1/runs`` body the app would have sent (model, provider, instructions and the message), and
the plugin posts it to its own API server, as Hermes's wake does, so the run is an ordinary one that
every device can follow. A run that was stopped or failed pauses the queue until the user sends an
item again.

An item can also steer the run that's going (``POST /v1/runs/{id}/steer``). Hermes hands back a
steer the agent never read (``pending_steer``, when it came during the last reply), and the plugin
puts it first in the queue, as Hermes's own messaging gateway does.
"""

from __future__ import annotations

import asyncio
import json
import logging
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from . import events
from .store import connect, db_path

logger = logging.getLogger(__name__)

ACTIVE = {"queued", "running", "waiting_for_approval", "stopping"}
STOPPED = {"cancelled", "failed", "interrupted"}
# Sent items stay listed this long, so a device that opens the chat can follow the run they started.
KEEP_SENT_MS = 60 * 60 * 1000
FORGET_SENT_MS = 24 * 60 * 60 * 1000
TICK_SECONDS = 1.0
MAX_TEXT = 100_000
POST_TIMEOUT_SECONDS = 30

_lock = threading.Lock()
# Sessions with something to send, or a steer whose leftover may come back: profile and database.
_watched: Dict[str, Tuple[Optional[str], Path]] = {}
# The key each profile's requests came with, for posting its runs ("" is the default profile).
_keys: Dict[str, str] = {}
_loop: Optional[asyncio.AbstractEventLoop] = None
_event: Optional[asyncio.Event] = None


class StartError(Exception):
    def __init__(self, message: str, permanent: bool) -> None:
        super().__init__(message)
        self.permanent = permanent


def watch(session_id: str, profile: Optional[str], path: Path, authorization: Optional[str] = None) -> None:
    with _lock:
        _watched[session_id] = (profile, path)
        if authorization and authorization.startswith("Bearer "):
            _keys[profile or ""] = authorization[len("Bearer ") :]
    wake()


def wake() -> None:
    """Has the dispatcher look again now; safe from any thread (Hermes's hooks run in others)."""
    events.poke(_loop, _event)


def _item(row: Any) -> Dict[str, Any]:
    return {
        "id": row["id"],
        "text": row["text"],
        "attachments": _files(row["attachments"]),
        "created_at": row["created_at"],
        "run_id": row["run_id"],
        "sent_at": row["sent_at"],
        "error": row["error"],
    }


def _open(path: Path):
    conn = connect(path)
    conn.row_factory = sqlite3.Row
    return conn


def clean_body(session_id: str, body: Any) -> Dict[str, Any]:
    """The run request an item starts: the app's own ``POST /v1/runs`` body, for this session."""
    if not isinstance(body, dict):
        raise ValueError("body must be the run request")
    run = {key: body[key] for key in ("model", "provider", "instructions", "input") if key in body}
    run["session_id"] = session_id
    return run


def clean_files(files: Any) -> List[Dict[str, Any]]:
    """The attachment fields a queued item keeps, for at most 20 files."""
    return [
        {key: file[key] for key in ("name", "type", "size", "path") if key in file}
        for file in _objects(files)[:20]
    ]


def _remember_body(conn: Any, session_id: str, profile: Optional[str], body: Dict[str, Any]) -> None:
    # What a steer handed back needs to start a run of its own: everything but the message.
    template = {key: value for key, value in body.items() if key != "input"}
    conn.execute(
        """INSERT INTO outbox_sessions (session_id, profile, body) VALUES (?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET profile = excluded.profile, body = excluded.body""",
        (session_id, profile, json.dumps(template)),
    )


def add(
    path: Path,
    session_id: str,
    profile: Optional[str],
    text: str,
    attachments: List[Dict[str, Any]],
    body: Dict[str, Any],
) -> Dict[str, Any]:
    if not isinstance(body.get("input"), list) or not body["input"]:
        raise ValueError("body.input must hold the message")
    if not isinstance(text, str) or len(text) > MAX_TEXT:
        raise ValueError("text must be a string")
    now = int(time.time() * 1000)
    item_id = f"q_{uuid.uuid4().hex[:20]}"
    conn = _open(path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        last = conn.execute(
            "SELECT MAX(position) FROM outbox WHERE session_id = ?", (session_id,)
        ).fetchone()[0]
        conn.execute(
            """INSERT INTO outbox (id, session_id, position, text, attachments, body, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                item_id,
                session_id,
                (last or 0) + 1,
                text,
                json.dumps(attachments) if attachments else None,
                json.dumps(body),
                now,
            ),
        )
        _remember_body(conn, session_id, profile, body)
        conn.execute("COMMIT")
        return _item(conn.execute("SELECT * FROM outbox WHERE id = ?", (item_id,)).fetchone())
    finally:
        conn.close()


def remember_body(path: Path, session_id: str, profile: Optional[str], body: Dict[str, Any]) -> None:
    conn = _open(path)
    try:
        _remember_body(conn, session_id, profile, body)
    finally:
        conn.close()


def read(path: Path, session_id: str) -> Dict[str, Any]:
    if not path.exists():
        return {"items": [], "sent": [], "resumed_at": 0}
    since = int(time.time() * 1000) - KEEP_SENT_MS
    conn = _open(path)
    try:
        waiting = conn.execute(
            "SELECT * FROM outbox WHERE session_id = ? AND run_id IS NULL ORDER BY position",
            (session_id,),
        ).fetchall()
        sent = conn.execute(
            """SELECT * FROM outbox WHERE session_id = ? AND run_id IS NOT NULL AND sent_at >= ?
               ORDER BY sent_at""",
            (session_id, since),
        ).fetchall()
        meta = conn.execute(
            "SELECT resumed_at FROM outbox_sessions WHERE session_id = ?", (session_id,)
        ).fetchone()
    finally:
        conn.close()
    return {
        "items": [_item(row) for row in waiting],
        "sent": [_item(row) for row in sent],
        "resumed_at": meta["resumed_at"] if meta else 0,
    }


def remove(path: Path, session_id: str, item_id: str) -> bool:
    conn = _open(path)
    try:
        cursor = conn.execute(
            "DELETE FROM outbox WHERE id = ? AND session_id = ? AND run_id IS NULL",
            (item_id, session_id),
        )
        return cursor.rowcount > 0
    finally:
        conn.close()


def remove_sent(path: Path, session_id: str, item_id: str) -> bool:
    """Forgets a sent item, so the thread no longer lists the message as one it sent."""
    conn = _open(path)
    try:
        cursor = conn.execute(
            "DELETE FROM outbox WHERE id = ? AND session_id = ? AND run_id IS NOT NULL",
            (item_id, session_id),
        )
        return cursor.rowcount > 0
    finally:
        conn.close()


def promote(path: Path, session_id: str, item_id: str) -> bool:
    """Puts an item first and lets a paused queue go again."""
    conn = _open(path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        first = conn.execute(
            "SELECT MIN(position) FROM outbox WHERE session_id = ?", (session_id,)
        ).fetchone()[0]
        cursor = conn.execute(
            """UPDATE outbox SET position = ?, error = NULL
               WHERE id = ? AND session_id = ? AND run_id IS NULL""",
            ((first or 0) - 1, item_id, session_id),
        )
        if cursor.rowcount:
            conn.execute(
                """INSERT INTO outbox_sessions (session_id, resumed_at) VALUES (?, ?)
                   ON CONFLICT(session_id) DO UPDATE SET resumed_at = excluded.resumed_at""",
                (session_id, int(time.time() * 1000)),
            )
        conn.execute("COMMIT")
        return cursor.rowcount > 0
    finally:
        conn.close()


def take(path: Path, session_id: str, item_id: str) -> Optional[Dict[str, Any]]:
    """Removes a waiting item and hands back the whole row, to steer with it."""
    conn = _open(path)
    try:
        row = conn.execute(
            "SELECT * FROM outbox WHERE id = ? AND session_id = ? AND run_id IS NULL",
            (item_id, session_id),
        ).fetchone()
        if row is None:
            return None
        conn.execute("DELETE FROM outbox WHERE id = ?", (item_id,))
        return dict(row)
    finally:
        conn.close()


def put_back(path: Path, row: Dict[str, Any]) -> None:
    conn = _open(path)
    try:
        conn.execute(
            """INSERT OR IGNORE INTO outbox
               (id, session_id, position, text, attachments, body, created_at, run_id, sent_at, error)
               VALUES (:id, :session_id, :position, :text, :attachments, :body, :created_at, :run_id,
                       :sent_at, :error)""",
            row,
        )
    finally:
        conn.close()


def requeue_steer(path: Path, session_id: str, run_id: str, text: str) -> bool:
    """Puts a steer the run handed back unread first in the queue, once per run."""
    conn = _open(path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        meta = conn.execute(
            "SELECT body FROM outbox_sessions WHERE session_id = ?", (session_id,)
        ).fetchone()
        if not meta or not meta["body"]:
            conn.execute("COMMIT")
            return False
        body = json.loads(meta["body"])
        body["input"] = [{"role": "user", "content": text.strip()}]
        first = conn.execute(
            "SELECT MIN(position) FROM outbox WHERE session_id = ?", (session_id,)
        ).fetchone()[0]
        cursor = conn.execute(
            """INSERT OR IGNORE INTO outbox (id, session_id, position, text, body, created_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (
                f"s_{run_id}",
                session_id,
                (first or 0) - 1,
                text.strip(),
                json.dumps(body),
                int(time.time() * 1000),
            ),
        )
        conn.execute("COMMIT")
        return cursor.rowcount > 0
    finally:
        conn.close()


def head(path: Path, session_id: str) -> Tuple[Optional[Dict[str, Any]], int]:
    conn = _open(path)
    try:
        row = conn.execute(
            """SELECT * FROM outbox WHERE session_id = ? AND run_id IS NULL
               ORDER BY position LIMIT 1""",
            (session_id,),
        ).fetchone()
        meta = conn.execute(
            "SELECT resumed_at FROM outbox_sessions WHERE session_id = ?", (session_id,)
        ).fetchone()
        return (dict(row) if row else None), (meta["resumed_at"] if meta else 0)
    finally:
        conn.close()


def mark(path: Path, item_id: str, run_id: Optional[str] = None, error: Optional[str] = None) -> None:
    conn = _open(path)
    try:
        if run_id:
            conn.execute(
                "UPDATE outbox SET run_id = ?, sent_at = ?, error = NULL WHERE id = ?",
                (run_id, int(time.time() * 1000), item_id),
            )
        else:
            conn.execute("UPDATE outbox SET error = ? WHERE id = ?", (error, item_id))
        conn.execute(
            "DELETE FROM outbox WHERE run_id IS NOT NULL AND sent_at < ?",
            (int(time.time() * 1000) - FORGET_SENT_MS,),
        )
    finally:
        conn.close()


def waiting_sessions(path: Path) -> List[Tuple[str, Optional[str]]]:
    if not path.exists():
        return []
    conn = _open(path)
    try:
        rows = conn.execute(
            """SELECT DISTINCT o.session_id, s.profile FROM outbox o
               LEFT JOIN outbox_sessions s ON s.session_id = o.session_id
               WHERE o.run_id IS NULL"""
        ).fetchall()
        return [(row[0], row[1]) for row in rows]
    finally:
        conn.close()


def session_runs(adapter: Any, ids: set) -> List[Dict[str, Any]]:
    statuses = getattr(adapter, "_run_statuses", None)
    if not isinstance(statuses, dict):
        return []
    return [
        status
        for status in list(statuses.values())
        if isinstance(status, dict) and status.get("session_id") in ids
    ]


def state(runs: List[Dict[str, Any]], resumed_at: int) -> str:
    """``active`` while a run is going, ``paused`` after one was stopped or failed (until the user
    sends again), else ``idle``."""
    if any(run.get("status") in ACTIVE for run in runs):
        return "active"
    latest = max(runs, key=lambda run: float(run.get("created_at") or 0), default=None)
    if latest and latest.get("status") in STOPPED:
        if float(latest.get("updated_at") or 0) * 1000 > resumed_at:
            return "paused"
    return "idle"


async def session_ids(adapter: Any, session_id: str) -> set:
    """The session and the live one compression moved it to: a run's status names the latter."""
    ids = {session_id}
    open_db = getattr(adapter, "_ensure_session_db_async", None)
    try:
        db = await open_db() if callable(open_db) else None
        resolve = getattr(db, "resolve_resume_session_id", None)
        if callable(resolve):
            tip = await asyncio.to_thread(resolve, session_id)
            if tip:
                ids.add(tip)
    except Exception:
        logger.debug("memento: couldn't resolve session %s", session_id, exc_info=True)
    return ids


def loopback(adapter: Any, profile: Optional[str]) -> str:
    """The API server's own address, as Hermes's wake reaches it."""
    host = str(getattr(adapter, "_host", "") or "127.0.0.1")
    if host in ("0.0.0.0", "::", "*"):
        host = "127.0.0.1"
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    port = int(getattr(adapter, "_port", 0) or 8642)
    prefix = f"/p/{profile}" if profile and profile != "default" else ""
    return f"http://{host}:{port}{prefix}"


def _key(adapter: Any, profile: Optional[str]) -> str:
    with _lock:
        known = _keys.get(profile or "")
    if known:
        return known
    if not profile or profile == "default":
        return str(getattr(adapter, "_api_key", "") or "")
    return ""


async def post(adapter: Any, profile: Optional[str], path: str, body: Dict[str, Any],
               authorization: Optional[str] = None, idempotency_key: Optional[str] = None) -> Dict[str, Any]:
    """POSTs to this API server as the profile's own client would."""
    import aiohttp

    if not authorization:
        key = _key(adapter, profile)
        if not key:
            raise StartError("The plugin doesn't have this bot's API key yet.", False)
        authorization = f"Bearer {key}"
    headers = {"Authorization": authorization, "Content-Type": "application/json"}
    if idempotency_key:
        headers["Idempotency-Key"] = idempotency_key
    timeout = aiohttp.ClientTimeout(total=POST_TIMEOUT_SECONDS)
    try:
        async with aiohttp.ClientSession(timeout=timeout) as client:
            async with client.post(f"{loopback(adapter, profile)}{path}", json=body, headers=headers) as resp:
                try:
                    answer = await resp.json(content_type=None)
                except Exception:
                    answer = {}
                if resp.status < 300:
                    return answer if isinstance(answer, dict) else {}
                error = answer.get("error") if isinstance(answer, dict) else None
                message = error.get("message") if isinstance(error, dict) else None
                raise StartError(
                    str(message or f"Hermes answered {resp.status}"),
                    400 <= resp.status < 500 and resp.status not in (408, 429),
                )
    except StartError:
        raise
    except Exception as error:
        raise StartError(f"Couldn't reach the API server: {error}", False) from error


def _objects(raw: Any) -> List[Dict[str, Any]]:
    """The file objects a list holds; anything else in it is not a file."""
    return [file for file in raw if isinstance(file, dict)] if isinstance(raw, list) else []


def _files(raw: Any) -> List[Dict[str, Any]]:
    """The files a row carries, as its own JSON column keeps them (or a list, already decoded)."""
    if isinstance(raw, str):
        try:
            raw = json.loads(raw) if raw else []
        except ValueError:
            return []
    return _objects(raw)


def _body_text(body: Any) -> Optional[str]:
    """The text a run body carries, its parts in the order the model reads them — or None when the
    body holds more than text, which a steer, being text, can't carry."""
    try:
        run = json.loads(body) if isinstance(body, str) else body
    except (TypeError, ValueError):
        return ""
    if not isinstance(run, dict):
        return ""
    messages = run.get("input")
    if not isinstance(messages, list) or not messages or not isinstance(messages[-1], dict):
        return ""
    content = messages[-1].get("content")
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    texts = []
    for part in content:
        if not isinstance(part, dict):
            continue
        if part.get("type") != "text":
            return None
        texts.append(str(part.get("text") or ""))
    return "\n".join(texts)


def steer_text(row: Any) -> Optional[str]:
    """What a waiting item says when it steers the run that's going, or None when it can't steer.

    A steer is text, so a message carrying files steers as the text its own body holds — the
    marker line per file, with the path the app saved it at, and the sentence about them. A
    message carrying a photo the body puts inside it can't: a steer has nowhere to put the bytes.
    """
    item = _item(row)
    said = _body_text(row["body"]) if item["attachments"] else (row["text"] or "")
    return (said or "").strip() or None


async def steer(
    adapter: Any,
    profile: Optional[str],
    path: Path,
    session_id: str,
    item_id: str,
    authorization: Optional[str] = None,
) -> Tuple[Optional[Dict[str, Any]], Optional[Tuple[str, int]]]:
    """Hands a waiting item to the session's running reply: ``(steered, None)``, else
    ``(None, (reason, status))`` with the item still waiting where it was."""
    runs = session_runs(adapter, await session_ids(adapter, session_id))
    running = [run for run in runs if run.get("status") == "running" and run.get("run_id")]
    if not running:
        return None, ("The reply isn't running, so it can't be steered.", 409)
    run_id = max(running, key=lambda run: float(run.get("created_at") or 0))["run_id"]
    row = await asyncio.to_thread(take, path, session_id, item_id)
    if row is None:
        return None, ("That message isn't waiting any more.", 404)
    said = steer_text(row)
    if said is None:
        await asyncio.to_thread(put_back, path, row)
        return None, ("Only text can steer a reply.", 409)
    try:
        await post(
            adapter, profile, f"/v1/runs/{run_id}/steer", {"input": said}, authorization=authorization
        )
    except StartError as error:
        await asyncio.to_thread(put_back, path, row)
        return None, (str(error), 409 if error.permanent else 502)
    # A steer the agent never reads comes back when the run ends; see tick.
    return {"object": "memento.queue.steered", "id": row["id"], "run_id": run_id, "text": said}, None


async def tick(adapter: Any, session_id: str, profile: Optional[str], path: Path) -> None:
    ids = await session_ids(adapter, session_id)
    runs = session_runs(adapter, ids)
    if any(run.get("status") in ACTIVE for run in runs):
        return
    latest = max(runs, key=lambda run: float(run.get("created_at") or 0), default=None)
    leftover = latest.get("pending_steer") if latest else None
    if isinstance(leftover, str) and leftover.strip() and latest.get("run_id"):
        if await asyncio.to_thread(requeue_steer, path, session_id, latest["run_id"], leftover):
            events.note("session", session_id, path, True)
    row, resumed_at = await asyncio.to_thread(head, path, session_id)
    if row is None:
        with _lock:
            _watched.pop(session_id, None)
        return
    if row["error"] or state(runs, resumed_at) == "paused":
        return
    try:
        started = await post(
            adapter, profile, "/v1/runs", json.loads(row["body"]), idempotency_key=row["id"]
        )
    except StartError as error:
        logger.warning("memento: couldn't start the queued turn for %s: %s", session_id, error)
        if error.permanent:
            await asyncio.to_thread(mark, path, row["id"], None, str(error))
            events.note("session", session_id, path, True)
        return
    run_id = started.get("run_id")
    if not isinstance(run_id, str) or not run_id:
        await asyncio.to_thread(mark, path, row["id"], None, "Hermes didn't start the run.")
        return
    await asyncio.to_thread(mark, path, row["id"], run_id)
    events.note("session", session_id, path, True)
    events.note("runs", session_id, path, True)


async def run(adapter: Any, home: Path) -> None:
    """Starts each session's next queued turn once its run is over, for as long as the server runs."""
    global _loop, _event
    _loop = asyncio.get_running_loop()
    _event = asyncio.Event()
    try:
        found = await asyncio.to_thread(waiting_sessions, db_path(home))
    except Exception:
        logger.debug("memento: couldn't read the queue", exc_info=True)
        found = []
    for session_id, profile in found:
        if not profile or profile == "default":
            watch(session_id, None, db_path(home))
    while True:
        try:
            await asyncio.wait_for(_event.wait(), TICK_SECONDS)
        except asyncio.TimeoutError:
            pass
        _event.clear()
        with _lock:
            watched = list(_watched.items())
        for session_id, (profile, path) in watched:
            try:
                await tick(adapter, session_id, profile, path)
            except Exception:
                logger.debug("memento: queue tick failed for %s", session_id, exc_info=True)
