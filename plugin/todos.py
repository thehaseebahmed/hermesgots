"""Each Gots chat's todo list: the agent's own plan, as its ``todo_list`` tool last wrote it.

Hermes keeps the list in memory on the agent and rebuilds it from the transcript, where every call's
result is stored as a tool row (flushed after each tool round, so mid-turn too). The run stream only
carries a 500-character preview of that result, so the plugin reads the full one from the transcript,
pairing it with its call the way Hermes's own restore does, so a bare tool row can't forge a list.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

TOOL = "todo_list"

STATUSES = ("pending", "in_progress", "completed", "cancelled")
MAX_ITEMS = 256
MAX_CONTENT_CHARS = 4000
# Hermes skips bigger results when it restores a list (MAX_TODO_RESULT_CHARS).
MAX_RESULT_CHARS = 512_000
TOOL_NAMES = ("todo_list", "todo")
# How deep a subtask may indent, the same cap the app draws with.
MAX_DEPTH = 3


def _call_id(tool_call: Any) -> Optional[str]:
    if not isinstance(tool_call, dict):
        return None
    value = tool_call.get("id") or tool_call.get("call_id")
    return value if isinstance(value, str) and value else None


def _is_todo_call(tool_call: Any) -> bool:
    try:
        from tools.todo_tool import is_todo_tool_call
    except ImportError:
        function = tool_call.get("function") if isinstance(tool_call, dict) else None
        return isinstance(function, dict) and function.get("name") in TOOL_NAMES
    try:
        return bool(is_todo_tool_call(tool_call))
    except Exception:
        return False


def _answers_todo_call(history: List[Dict[str, Any]], index: int) -> bool:
    call_id = history[index].get("tool_call_id")
    if not call_id:
        return False
    for prior in reversed(history[:index]):
        role = prior.get("role")
        if role == "assistant":
            calls = prior.get("tool_calls")
            return isinstance(calls, list) and any(
                _call_id(call) == call_id and _is_todo_call(call) for call in calls
            )
        if role in ("user", "system"):
            return False
    return False


def _items(raw: List[Any]) -> List[Dict[str, str]]:
    items: List[Dict[str, str]] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        item_id, content, status = entry.get("id"), entry.get("content"), entry.get("status")
        if not isinstance(item_id, (str, int)) or not isinstance(content, str) or status not in STATUSES:
            continue
        item = {"id": str(item_id), "content": content[:MAX_CONTENT_CHARS], "status": status}
        parent = entry.get("parent")
        if isinstance(parent, (str, int)) and str(parent):
            item["parent"] = str(parent)
        items.append(item)
        if len(items) >= MAX_ITEMS:
            break
    depth_of(items)
    return items


def depth_of(items: List[Dict[str, Any]]) -> None:
    """How far each item sits under its parents, in place.

    A subtask indents by it, so it is the host's to state: the app draws the list it is given. A parent
    that isn't in the list, or a loop, stops at the root, and nothing indents past ``MAX_DEPTH``.
    """
    parents = {item["id"]: item.get("parent") for item in items}
    for item in items:
        depth = 0
        seen = {item["id"]}
        parent = item.get("parent")
        while parent and parent in parents and parent not in seen and depth < MAX_DEPTH:
            seen.add(parent)
            depth += 1
            parent = parents[parent]
        item["depth"] = depth


def progress_of(items: List[Dict[str, Any]]) -> Dict[str, int]:
    """The list's own progress: how many are done of those that still count, as the app shows it.

    A cancelled item is not work any more, so it leaves both numbers.
    """
    counted = [item for item in items if item.get("status") != "cancelled"]
    return {
        "done": len([item for item in counted if item.get("status") == "completed"]),
        "total": len(counted),
    }


def read(db: Any, session_id: str) -> Optional[Dict[str, Any]]:
    """The newest todo list in the session and the ones it was compressed from, or None."""
    load = getattr(db, "get_messages_as_conversation", None)
    if not callable(load):
        return None
    try:
        history = load(session_id, include_ancestors=True)
    except Exception:
        logger.debug("gots: couldn't load session %s", session_id, exc_info=True)
        return None
    for index in range(len(history) - 1, -1, -1):
        message = history[index]
        content = message.get("content")
        if message.get("role") != "tool" or not isinstance(content, str):
            continue
        if len(content) > MAX_RESULT_CHARS or '"todos"' not in content:
            continue
        if not _answers_todo_call(history, index):
            continue
        try:
            data = json.loads(content)
        except ValueError:
            continue
        if not isinstance(data, dict) or not isinstance(data.get("todos"), list):
            continue
        revision = data.get("revision")
        items = _items(data["todos"])
        return {
            "revision": revision if isinstance(revision, int) and revision >= 0 else 0,
            "todos": items,
            "progress": progress_of(items),
        }
    return None


def wire(adapter: Any) -> bool:
    """Whether Hermes's own ``todo_list`` is there for the API server's agents. It is part of the
    ``hermes-api-server`` toolset, so the plugin adds nothing to an agent: a profile that saved a
    ``platform_toolsets.api_server`` without ``todo`` chose to leave it out."""
    try:
        from tools.todo_tool import TODO_SCHEMA  # noqa: F401
    except Exception:
        return False
    return True
