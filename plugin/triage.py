"""Triage: whether a message sent from a bot's Main thread stays there or continues an older thread.

The host decides (docs/adr/0029), so a message reaches the right thread with the app closed and
every device sees the same decision. Unsure means Main: an unparseable answer, an unknown thread, a
host with no model facility and any error all resolve to ``main``, and nothing here raises.

Candidates are the bot's plain threads only: never a project session, a deleted or discarded
chat, or Main itself, the 15 most recently active, each as id, title, last line and last-active.
"""

from __future__ import annotations

import logging
import sqlite3
import time
from collections import OrderedDict
from contextlib import closing
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import chats, research

logger = logging.getLogger(__name__)

MAX_CANDIDATES = 15
# How much of Main the decision sees besides the message.
MAIN_TURNS = 4
LINE_CHARS = 160
TURN_CHARS = 400
MAX_TEXT = 2000
# The decision is given up on after this long; the app waits a little longer than this for the answer.
DEADLINE_S = 3.0
MAIN = "main"
THREAD = "thread"

SYSTEM = (
    "You sort one message a person sent to their assistant's main conversation. Say whether it "
    "belongs in an older thread, or stays in the main conversation."
)
INSTRUCTIONS = (
    "Answer decision: continue only when the message clearly carries on one thread's subject, and "
    "name that thread's id in thread. Answer stay, with no thread, for everything else: a new "
    "subject, a one-off question, small talk, or anything you are not sure of. When in doubt, stay."
)
SCHEMA = {
    "type": "object",
    "properties": {
        "decision": {"type": "string", "enum": ["stay", "continue"]},
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
    lines.append("")
    lines.append("Main's latest turns:")
    for turn in turns:
        lines.append(f'{turn["role"]}: {_line(turn["text"], TURN_CHARS)}')
    if not turns:
        lines.append("(none)")
    lines.append("")
    lines.append(f"The message: {_line(text, MAX_TEXT)}")
    return "\n".join(lines)


def decide(
    text: str,
    options: List[Dict[str, Any]],
    turns: List[Dict[str, str]],
    deadline: Optional[float] = None,
) -> Optional[str]:
    """The id of the thread the message continues, or None to stay in Main."""
    if not options or not isinstance(text, str) or not text.strip():
        return None
    llm = _llm()
    # Past the deadline nobody is waiting for the answer, so the model isn't asked at all.
    if llm is None or (deadline is not None and time.monotonic() > deadline):
        return None
    try:
        result = llm.complete_structured(
            instructions=INSTRUCTIONS,
            input=[{"type": "text", "text": _prompt(text, options, turns)}],
            json_schema=SCHEMA,
            system_prompt=SYSTEM,
            max_tokens=200,
            temperature=0,
            purpose="memento.triage",
        )
    except Exception:
        logger.debug("memento: triage's model call failed", exc_info=True)
        return None
    parsed = getattr(result, "parsed", None)
    if not isinstance(parsed, dict) or parsed.get("decision") != "continue":
        return None
    thread = parsed.get("thread")
    return thread if isinstance(thread, str) and any(o["id"] == thread for o in options) else None


# Answers already given, by the id the app sent with the message: a request the app repeats after a
# dropped response gets the same answer back, and the message is queued once.
_given: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()
GIVEN_CAP = 64


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
    """``{ decision: "main" }`` or ``{ decision: "thread", thread, session_id, model_choice }``.

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
        thread = decide(text, options, turns, deadline)
        if thread is None:
            return {"decision": MAIN}
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
