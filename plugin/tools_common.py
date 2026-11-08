"""Wiring a plugin tool into the agents the API server builds, shared by the plugin's tools.

The API server builds its agents from a saved ``platform_toolsets.api_server``, which can leave
the plugin's toolset out, so each tool's module wraps the adapter's ``_create_agent`` to add its
definition to every agent — the same wrapper for every tool.

"""

from __future__ import annotations

import logging
from typing import Any, Callable, Dict, Optional

logger = logging.getLogger(__name__)


def wire_tool(
    adapter: Any,
    tool: str,
    schema: Dict[str, Any],
    label: str,
    when: Optional[Callable[[Optional[str]], bool]] = None,
) -> bool:
    """Makes every agent the API server builds carry the tool when this profile registered it,
    since a saved ``platform_toolsets.api_server`` would otherwise leave the plugin's toolset out.

    ``when`` keeps the tool to the sessions it is for — a research mission's agent, a canvas's — and
    is asked the session the agent was built for. Without it every agent carries the tool.
    """
    original = getattr(adapter, "_create_agent", None)
    if not callable(original):
        return False

    def create_agent(*args: Any, **kwargs: Any) -> Any:
        agent = original(*args, **kwargs)
        session_id = kwargs.get("session_id") or getattr(agent, "session_id", None)
        if when is not None and not when(session_id):
            return agent
        try:
            equip_tool(agent, tool, schema)
        except Exception:
            logger.debug("gots: couldn't add the %s tool to an agent", label, exc_info=True)
        return agent

    adapter._create_agent = create_agent
    return True


def equip_tool(agent: Any, tool: str, schema: Dict[str, Any]) -> None:
    names = getattr(agent, "valid_tool_names", None)
    tools = getattr(agent, "tools", None)
    if not isinstance(tools, list) or not isinstance(names, set) or tool in names:
        return
    try:
        from tools.registry import registry
    except ImportError:
        return
    # Only where this profile loaded the plugin: anywhere else the call would be an unknown tool.
    if registry.get_entry(tool) is None:
        return
    tools.append({"type": "function", "function": schema})
    names.add(tool)
