"""Triage: whether a message sent from a bot's Main thread stays there, continues an older thread or
opens a new one.

The host decides (docs/adr/0029), so a message reaches the right thread with the app closed and
every device sees the same decision. Unsure means Main: an unparseable answer, an unknown thread, a
host with no model facility and any error all resolve to ``main``, and nothing here raises.

Candidates are the bot's plain threads only: never a project session, a deleted or discarded
chat, or Main itself, the 15 most recently active, each as id, title, last line and last-active.
"""

from __future__ import annotations

import asyncio
import logging
import sqlite3
import time
import uuid
from collections import OrderedDict
from contextlib import closing
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from . import chats, host_model, outbox, research
from .store import get_setting, put_setting
from .sessions import MEMENTO_ID_PREFIX

logger = logging.getLogger(__name__)

MAX_CANDIDATES = 15
# How much of Main the decision sees besides the message.
MAIN_TURNS = 4
LINE_CHARS = 160
TURN_CHARS = 400
MAX_TEXT = 2000
# The decision is given up on after this long; the app waits a little longer than this for the answer.
DEADLINE_S = 3.0
# The row in ``host_settings`` that holds the triage model, as JSON ``{provider, model}``.
MODEL_KEY = "triage_model"
MAIN = "main"
THREAD = "thread"
NEW = "new"

SYSTEM = (
    "You sort one message a person sent to their assistant's main conversation. Say whether it "
    "belongs in an older thread, starts a thread of its own, or stays in the main conversation."
)
INSTRUCTIONS = (
    "Answer decision: continue only when the message clearly carries on one thread's subject, and "
    "name that thread's id in thread. Answer new, with no thread, only when the message opens a "
    "discussion of its own that will run for many turns: a project, a task or a topic to work "
    "through. Answer stay, with no thread, for everything else: a one-off question, small talk, or "
    "anything you are not sure of. When in doubt, stay."
)
SCHEMA = {
    "type": "object",
    "properties": {
        "decision": {"type": "string", "enum": ["stay", "continue", "new"]},
        "thread": {"type": ["string", "null"]},
    },
    "required": ["decision"],
    "additionalProperties": False,
}


def available() -> Optional[str]:
    """Why triage can't run on this host, or None when it can."""
    return None if getattr(research.ctx, "llm", None) is not None else "This Hermes can't make model calls."


def _llm() -> Any:
    return getattr(research.ctx, "llm", None)


def _line(text: Any, limit: int) -> str:
    if not isinstance(text, str):
        return ""
    flat = " ".join(text.split())
    return flat if len(flat) <= limit else flat[: limit - 1] + "…"


def _rows(
    home: Path, session_ids: List[str], count: int, conn: Optional[sqlite3.Connection] = None
) -> Dict[str, List[Dict[str, str]]]:
    """Each session's newest ``count`` user and assistant rows, oldest first, on one connection.

    A session that compression moved on is read through its children too, so its last line is the
    chat's latest. A session that can't be read is left out.
    """
    state = home / "state.db"
    if conn is None:
        if not state.exists():
            return {}
        try:
            with closing(sqlite3.connect(f"{state.as_uri()}?mode=ro", uri=True, timeout=2)) as opened:
                return _rows(home, session_ids, count, opened)
        except sqlite3.Error:
            return {}
    found: Dict[str, List[Dict[str, str]]] = {}
    for session_id in session_ids:
        try:
            rows = conn.execute(
                """SELECT role, content FROM messages
                   WHERE (session_id = ? OR session_id IN
                          (SELECT id FROM sessions WHERE parent_session_id = ?))
                     AND role IN ('user', 'assistant')
                     AND content IS NOT NULL AND content != ''
                   ORDER BY id DESC LIMIT ?""",
                (session_id, session_id, count),
            ).fetchall()
        except sqlite3.Error:
            continue
        found[session_id] = [{"role": role, "text": text} for role, text in reversed(rows)]
    return found


def candidates(records: Dict[str, Dict[str, Any]], main_id: str, home: Path) -> List[Dict[str, Any]]:
    """The threads a message could continue, the most recently active first."""
    main = (records.get(main_id) or {}).get("value") or {}
    profile = main.get("profileId")
    found = []
    for chat_id, record in records.items():
        value = record.get("value")
        if chat_id == main_id or record.get("deleted") or not isinstance(value, dict):
            continue
        session_id = value.get("hermesSessionId")
        if value.get("main") or value.get("projectId") or not isinstance(session_id, str):
            continue
        if value.get("discardedAt") or value.get("resolvedAt"):
            continue
        if value.get("profileId") != profile:
            continue
        active = value.get("updatedAt")
        found.append((active if isinstance(active, (int, float)) else 0, chat_id, value, session_id))
    found.sort(key=lambda row: row[0], reverse=True)
    result = []
    top = found[:MAX_CANDIDATES]
    lines = _rows(home, [session_id for _, _, _, session_id in top], 1)
    for active, chat_id, value, session_id in top:
        last = lines.get(session_id) or []
        result.append(
            {
                "id": chat_id,
                "title": _line(value.get("title"), 80),
                "last": _line(last[0]["text"], LINE_CHARS) if last else "",
                "active": int(active),
            }
        )
    return result


def _prompt(text: str, options: List[Dict[str, Any]], turns: List[Dict[str, str]]) -> str:
    lines = ["Threads:"]
    for option in options:
        lines.append(f'- id {option["id"]} · "{option["title"]}" · last: {option["last"] or "(nothing)"}')
    if not options:
        lines.append("(none)")
    lines.append("")
    lines.append("Main's latest turns:")
    for turn in turns:
        lines.append(f'{turn["role"]}: {_line(turn["text"], TURN_CHARS)}')
    if not turns:
        lines.append("(none)")
    lines.append("")
    lines.append(f"The message: {_line(text, MAX_TEXT)}")
    return "\n".join(lines)


class Withheld(Exception):
    """The host's config doesn't let Gots pick the model of a model call."""


def read_model(path: Path) -> Optional[Dict[str, str]]:
    """The triage model this bot's host holds, or None when the bot's own model decides."""
    held = get_setting(path, MODEL_KEY)
    if not isinstance(held, dict):
        return None
    provider, model = held.get("provider"), held.get("model")
    if isinstance(provider, str) and isinstance(model, str) and provider and model:
        return {"provider": provider, "model": model}
    return None


def set_model(
    config_path: Path, path: Path, pick: Optional[Dict[str, str]], gate: Dict[str, bool]
) -> Optional[Dict[str, str]]:
    """Makes ``pick`` the model triage decides with; None clears it, so the bot's own model decides.

    The pick overrides the model of a call, which the host's config has to allow (``gate``, from
    ``research.llm_gate``): ``Withheld`` otherwise. Hermes checks it the way it checks the main
    model, and a refusal is a ValueError with its reason; a refused or withheld pick writes nothing,
    and a pick already held isn't checked again.
    """
    if pick is None:
        put_setting(path, MODEL_KEY, None)
        return None
    if not (gate.get("model") and gate.get("provider")):
        raise Withheld(
            "This host doesn't let Gots pick the model. Allow it with `hermes plugins enable memento`."
        )
    if read_model(path) == pick:
        return pick
    from gateway.run import _load_gateway_config

    cfg = _load_gateway_config(config_path=config_path) or {}
    routed = host_model.check_pick(cfg, pick["provider"], pick["model"])
    resolved = {"provider": routed.target_provider, "model": routed.new_model}
    put_setting(path, MODEL_KEY, resolved)
    return resolved


def decide(
    text: str,
    options: List[Dict[str, Any]],
    turns: List[Dict[str, str]],
    deadline: Optional[float] = None,
    model: Optional[Dict[str, str]] = None,
) -> Optional[str]:
    """The id of the thread the message continues, ``NEW`` for a thread of its own, or None to stay.

    ``model`` is the triage model; without one the bot's own decides."""
    if not isinstance(text, str) or not text.strip():
        return None
    llm = _llm()
    # Past the deadline nobody is waiting for the answer, so the model isn't asked at all.
    if llm is None or (deadline is not None and time.monotonic() > deadline):
        return None
    ask = dict(
        instructions=INSTRUCTIONS,
        input=[{"type": "text", "text": _prompt(text, options, turns)}],
        json_schema=SCHEMA,
        system_prompt=SYSTEM,
        max_tokens=200,
        temperature=0,
        purpose="memento.triage",
    )
    try:
        try:
            result = llm.complete_structured(**ask, **(model or {}))
        except Exception as error:
            if not (model and research.override_refused(error)):
                raise
            # The host took the permission back after the pick: the bot's own model decides, if
            # there is time left for it.
            if deadline is not None and time.monotonic() > deadline:
                return None
            result = llm.complete_structured(**ask)
    except Exception:
        logger.debug("memento: triage's model call failed", exc_info=True)
        return None
    parsed = getattr(result, "parsed", None)
    if not isinstance(parsed, dict):
        return None
    if parsed.get("decision") == NEW:
        return NEW
    if parsed.get("decision") != "continue":
        return None
    thread = parsed.get("thread")
    return thread if isinstance(thread, str) and any(o["id"] == thread for o in options) else None


def open_thread(
    path: Path, profile_id: Optional[str], model_choice: Optional[Dict[str, str]] = None
) -> Tuple[str, str]:
    """Makes the chat record a new chat on the bot would have, and returns its id and session id.

    The id is the app's own kind (a UUID) and the session is ``memento-<id>``, so every device and
    the dashboard label treat it as any chat. The title is Hermes's to give once the first turn runs.
    """
    chat_id = str(uuid.uuid4())
    session_id = f"{MEMENTO_ID_PREFIX}{chat_id}"
    now = int(time.time() * 1000)
    value = {
        "id": chat_id,
        "profileId": profile_id,
        "title": "New chat",
        "hermesSessionId": session_id,
        "createdAt": now,
        # Past createdAt, so the daily cleanup doesn't read a thread whose first message is still
        # waiting in the queue as one nothing happened in.
        "updatedAt": now + 1,
        "changedAt": now,
        **({"modelChoice": model_choice} if model_choice else {}),
    }
    chats.merge(path, {chat_id: {"at": now, "value": value}})
    return chat_id, session_id


def start_thread(
    path: Path,
    profile: Optional[str],
    profile_id: Optional[str],
    text: str,
    files: List[Dict[str, Any]],
    body: Any,
) -> Dict[str, Any]:
    """A new thread with the message queued as its first turn: ``{ thread, session_id, item }``.

    The queued body is the app's own run request for the message, rebound to the new session, so the
    dispatcher starts the thread with just the message (and the attachments it names, already saved
    on the host) with the app closed. A failure after the record was made takes the record back and
    raises, so the caller leaves the message in Main.
    """
    # The run goes out on the model it names, so the thread says so too.
    run = body if isinstance(body, dict) else {}
    choice = (
        {"provider": run["provider"], "model": run["model"]}
        if isinstance(run.get("model"), str) and isinstance(run.get("provider"), str)
        else None
    )
    chat_id, session_id = open_thread(path, profile_id, choice)
    try:
        item = outbox.add(path, session_id, profile, text, files, outbox.clean_body(session_id, body))
    except Exception:
        discard(path, chat_id)
        raise
    return {"thread": chat_id, "session_id": session_id, "item": item}


def discard(path: Path, chat_id: str) -> None:
    """Takes back a thread whose first message never got queued, as a tombstone every device keeps."""
    try:
        chats.merge(path, {chat_id: {"at": int(time.time() * 1000) + 1, "deleted": True}})
    except Exception:
        logger.debug("memento: triage couldn't take back a thread", exc_info=True)


# Answers already given, by the id the app sent with the message: a request the app repeats after a
# dropped response gets the same answer back, and the message is queued once.
_given: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()
GIVEN_CAP = 64


_locks: "Dict[str, List[Any]]" = {}


class lock:
    """Serialises asks that share a key, so a repeat waits for the first and reads its answer."""

    def __init__(self, key: Optional[str]) -> None:
        self.key = key
        self.entry: List[Any] = [asyncio.Lock(), 0]

    async def __aenter__(self) -> None:
        if self.key is not None:
            self.entry = _locks.setdefault(self.key, self.entry)
        self.entry[1] += 1
        await self.entry[0].acquire()

    async def __aexit__(self, *exc: Any) -> None:
        self.entry[0].release()
        self.entry[1] -= 1
        if self.key is not None and not self.entry[1]:
            _locks.pop(self.key, None)


def given(key: Optional[str]) -> Optional[Dict[str, Any]]:
    return _given.get(key) if key else None


def remember(key: Optional[str], answer: Dict[str, Any]) -> None:
    if not key:
        return
    _given[key] = answer
    while len(_given) > GIVEN_CAP:
        _given.popitem(last=False)


def triage(
    path: Path, home: Path, session_id: str, text: str, deadline: Optional[float] = None
) -> Dict[str, Any]:
    """``{ decision: "main" }``, ``{ decision: "thread", thread, session_id, model_choice }`` or
    ``{ decision: "new", profile_id }``, where the caller makes the thread once it knows it is still wanted.

    Only a Main thread's session is triaged; any other session, and any failure, is Main.
    """
    try:
        records = chats.read(path)
        main_id = next(
            (
                chat_id
                for chat_id, record in records.items()
                if not record.get("deleted")
                and isinstance(record.get("value"), dict)
                and record["value"].get("main")
                and record["value"].get("hermesSessionId") == session_id
            ),
            None,
        )
        if main_id is None:
            return {"decision": MAIN}
        options = candidates(records, main_id, home)
        turns = _rows(home, [session_id], MAIN_TURNS).get(session_id) or []
        chosen = decide(text, options, turns, deadline, read_model(path))
        if chosen is None:
            return {"decision": MAIN}
        if chosen == NEW:
            return {"decision": NEW, "profile_id": records[main_id]["value"].get("profileId")}
        thread = chosen
        value = records[thread]["value"]
        return {
            "decision": THREAD,
            "thread": thread,
            "session_id": value["hermesSessionId"],
            "model_choice": value.get("modelChoice"),
        }
    except Exception:
        logger.debug("memento: triage failed", exc_info=True)
        return {"decision": MAIN}
