"""Each Memento chat's todo list: the agent's own plan, as its ``todo_list`` tool last wrote it.

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
_definition: Any = None  # the tool's definition, looked up once; False when Hermes has none

STATUSES = ("pending", "in_progress", "completed", "cancelled")
MAX_ITEMS = 256
MAX_CONTENT_CHARS = 4000
# Hermes skips bigger results when it restores a list (MAX_TODO_RESULT_CHARS).
MAX_RESULT_CHARS = 512_000
TOOL_NAMES = ("todo_list", "todo")


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
    return items


def read(db: Any, session_id: str) -> Optional[Dict[str, Any]]:
    """The newest todo list in the session and the ones it was compressed from, or None."""
    load = getattr(db, "get_messages_as_conversation", None)
    if not callable(load):
        return None
    try:
        history = load(session_id, include_ancestors=True)
    except Exception:
        logger.debug("memento: couldn't load session %s", session_id, exc_info=True)
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
        return {
            "revision": revision if isinstance(revision, int) and revision >= 0 else 0,
            "todos": _items(data["todos"]),
        }
    return None


def wire(adapter: Any) -> bool:
    """Makes every agent the adapter builds carry ``todo_list`` as a direct tool. Hermes defers it
    behind ``tool_search`` by default, and a saved ``platform_toolsets.api_server`` without ``todo``
    leaves it out of reach even there, so the agent reports it unavailable. False when this Hermes
    has no ``_create_agent`` seam."""
    original = getattr(adapter, "_create_agent", None)
    if not callable(original):
        logger.warning("memento: this Hermes has no _create_agent; the todo_list tool may be missing")
        return False

    def create_agent(*args: Any, **kwargs: Any) -> Any:
        agent = original(*args, **kwargs)
        try:
            equip(agent)
        except Exception:
            logger.debug("memento: couldn't add the todo_list tool to an agent", exc_info=True)
        return agent

    adapter._create_agent = create_agent
    return True


def equip(agent: Any) -> None:
    """Adds the tool's definition and name to one agent that doesn't have it."""
    names = getattr(agent, "valid_tool_names", None)
    tools = getattr(agent, "tools", None)
    if not isinstance(tools, list) or not isinstance(names, set) or TOOL in names:
        return
    definition = tool_definition()
    if definition:
        tools.append(definition)
        names.add(TOOL)


def tool_definition() -> Optional[Dict[str, Any]]:
    """The tool's definition as Hermes sends it."""
    global _definition
    if _definition is None:
        try:
            from tools.todo_tool import TODO_SCHEMA

            _definition = {"type": "function", "function": TODO_SCHEMA}
        except Exception:
            logger.debug("memento: no todo_list tool definition", exc_info=True)
            _definition = False
    return _definition or None
