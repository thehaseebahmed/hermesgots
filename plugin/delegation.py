"""The sessions a session delegated to, for the app's view of a chat's subagents.

Hermes dispatches ``delegate_task`` in the background on a keyed ``/v1/runs`` turn and hands the model
a handle, so the turn carries on and a question or an approval raised in it reaches the user while the
subagents still work. Nothing here touches that dispatch: the plugin leaves it to core.

Hermes keeps every delegated child as a session of its own (``platform="subagent"``, its parent's id
in ``parent_session_id`` and in ``model_config``'s ``_delegate_from``), so ``children`` lists them for
the app, which opens each one's transcript.
"""

from __future__ import annotations

import json
import logging
import sqlite3
from pathlib import Path
from typing import Any, Collection, Dict, List, Optional

logger = logging.getLogger(__name__)

MAX_HOPS = 50
MAX_CHILDREN = 100
GOAL_CHARS = 280


def children(hermes_home: Path, session_id: str, live: Collection[str]) -> List[Dict[str, Any]]:
    """The sessions ``session_id`` delegated to, oldest first: its own and those of its compression
    continuations, since a delegation made after a compression comes from the live tip. ``live`` holds
    the sessions with a run in flight: a child that never ended is only running while its parent's
    run is, and stopped otherwise (a stop, or a gateway restart, left its row open)."""
    state = hermes_home / "state.db"
    if not state.exists():
        return []
    try:
        # Read-only, so a lookup can never lock the gateway out of its own store.
        with sqlite3.connect(f"{state.as_uri()}?mode=ro", uri=True, timeout=2) as conn:
            conn.row_factory = sqlite3.Row
            parents = _lineage(conn, session_id)
            marks = ", ".join("?" for _ in parents)
            rows = conn.execute(
                f"""SELECT id, model, started_at, ended_at, end_reason, tool_call_count, model_config,
                    (SELECT content FROM messages m WHERE m.session_id = s.id AND m.role = 'user'
                     ORDER BY m.id LIMIT 1) AS goal
                FROM sessions s WHERE parent_session_id IN ({marks})
                ORDER BY started_at LIMIT {MAX_CHILDREN}""",
                parents,
            ).fetchall()
            running = any(parent in live for parent in parents)
            found = []
            for row in rows:
                if _delegated_from(row["model_config"]) not in parents:
                    continue
                tip = _tip(conn, row)
                found.append(_child(row, tip, running))
            return found
    except sqlite3.Error:
        logger.debug("memento: couldn't read %s's delegations", session_id, exc_info=True)
        return []


def _delegated_from(model_config: Any) -> Optional[str]:
    try:
        value = json.loads(model_config).get("_delegate_from") if model_config else None
    except (TypeError, ValueError, AttributeError):
        return None
    return value if isinstance(value, str) and value else None


def _lineage(conn: sqlite3.Connection, session_id: str) -> List[str]:
    """The session and every compression continuation after it."""
    ids = [session_id]
    current = session_id
    for _ in range(MAX_HOPS):
        row = conn.execute(
            "SELECT end_reason FROM sessions WHERE id = ?", (current,)
        ).fetchone()
        if not row or row["end_reason"] != "compression":
            break
        child = _continuation(conn, current)
        if not child or child in ids:
            break
        ids.append(child)
        current = child
    return ids


def _continuation(conn: sqlite3.Connection, session_id: str) -> Optional[str]:
    """The session compression moved ``session_id`` on to: a child that isn't a delegation."""
    for row in conn.execute(
        "SELECT id, model_config FROM sessions WHERE parent_session_id = ? ORDER BY started_at DESC",
        (session_id,),
    ):
        if _delegated_from(row["model_config"]) != session_id:
            return row["id"]
    return None


def _tip(conn: sqlite3.Connection, row: sqlite3.Row) -> Dict[str, Any]:
    """A child's live end, its last compression continuation (where it ended, or still runs), with
    the tool calls of every part."""
    current: Dict[str, Any] = dict(row)
    calls = current["tool_call_count"] or 0
    for _ in range(MAX_HOPS):
        if current["end_reason"] != "compression":
            break
        nxt = _continuation(conn, current["id"])
        found = nxt and conn.execute(
            "SELECT id, ended_at, end_reason, tool_call_count FROM sessions WHERE id = ?", (nxt,)
        ).fetchone()
        if not found:
            break
        current = dict(found)
        calls += current["tool_call_count"] or 0
    return {**current, "tool_calls": calls}


def _child(row: sqlite3.Row, tip: Dict[str, Any], live: bool) -> Dict[str, Any]:
    reason = tip["end_reason"] or ""
    if tip["ended_at"] is None:
        status = "running" if live else "stopped"
    elif "interrupt" in reason or reason in ("cancelled", "stopped"):
        status = "stopped"
    else:
        status = "done"
    goal = " ".join(str(row["goal"] or "").split())
    return {
        "id": row["id"],
        "goal": goal[:GOAL_CHARS],
        "model": row["model"],
        "started_at": row["started_at"],
        "ended_at": tip["ended_at"],
        "end_reason": reason or None,
        "tool_calls": tip["tool_calls"],
        "status": status,
    }
