"""Keeps ``delegate_task`` in the turn that called it, for the agents the API server builds.

Hermes runs a top-level delegation in the background and hands the agent a handle. On a ``/v1/runs``
session that resumes server history, the finished result is saved for the next client turn and the
agent is not woken (``_resolve_async_wake_sid`` in ``tools/delegate_tool_dispatch.py``), so it never
sees the result until the user writes again. A subagent in a session left running with the app
closed would wait for a message nobody sends. Run synchronously, the child's result comes back as
the tool's own answer, and an orchestrator child still fans out as before.

Hermes keeps every delegated child as a session of its own (``platform="subagent"``, its parent's id
in ``parent_session_id`` and in ``model_config``'s ``_delegate_from``), so ``children`` lists them for
the app, which opens each one's transcript.
"""

from __future__ import annotations

import inspect
import json
import logging
import sqlite3
from pathlib import Path
from typing import Any, Collection, Dict, List, Optional

logger = logging.getLogger(__name__)

MAX_HOPS = 50
MAX_CHILDREN = 100
GOAL_CHARS = 280


def wire(adapter: Any) -> bool:
    """Makes every agent the adapter builds delegate synchronously. False when this Hermes has no
    ``_create_agent`` seam or no background delegation to turn off."""
    original = getattr(adapter, "_create_agent", None)
    if not callable(original) or _delegate() is None:
        return False

    def create_agent(*args: Any, **kwargs: Any) -> Any:
        agent = original(*args, **kwargs)
        try:
            equip(agent)
        except Exception:
            logger.debug("memento: couldn't keep an agent's delegations in its turn", exc_info=True)
        return agent

    adapter._create_agent = create_agent
    return True


def _delegate() -> Any:
    """Hermes's ``delegate_task``, when it takes a ``background`` flag."""
    try:
        from tools.delegate_tool import delegate_task
    except ImportError:
        return None
    try:
        return delegate_task if "background" in inspect.signature(delegate_task).parameters else None
    except (TypeError, ValueError):
        return None


def equip(agent: Any) -> None:
    """Swaps one agent's delegate dispatch for a synchronous one. Hermes routes the model's call
    through ``_dispatch_delegate_task``; an agent without it is left alone."""
    original = getattr(agent, "_dispatch_delegate_task", None)
    delegate = _delegate()
    if not callable(original) or getattr(original, "_memento_sync", False) or delegate is None:
        return

    def dispatch(function_args: Dict[str, Any]) -> str:
        return run(agent, delegate, function_args)

    dispatch._memento_sync = True  # type: ignore[attr-defined]
    agent._dispatch_delegate_task = dispatch


def run(agent: Any, delegate: Any, function_args: Dict[str, Any]) -> str:
    args = function_args if isinstance(function_args, dict) else {}
    tasks = args.get("tasks")
    try:
        from tools.delegate_tool import _strip_model_hidden_task_fields

        tasks = _strip_model_hidden_task_fields(tasks)
    except ImportError:
        pass
    call = {
        "goal": args.get("goal"),
        "context": args.get("context"),
        "tasks": tasks,
        "max_iterations": args.get("max_iterations"),
        "role": args.get("role"),
        "background": False,
        "images": args.get("images"),
        "action": args.get("action"),
        "subagent_id": args.get("subagent_id"),
        "message": args.get("message"),
        "output_schema": args.get("output_schema"),
        "parent_agent": agent,
    }
    accepted = inspect.signature(delegate).parameters
    return delegate(**{key: value for key, value in call.items() if key in accepted})


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
