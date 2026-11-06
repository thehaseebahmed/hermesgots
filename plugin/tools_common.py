"""The one ``_create_agent`` wrap left: ``afk_gate`` and ``afk_findings`` still wire through it.

Hermes enables a plugin's toolset on every platform by default (``_enabled_plugin_toolsets``), the
API server included, so the plugin's tools reach its agents without any wrap; ``pull_request``,
``library_add`` and ``claim_add`` no longer use it. ``gate.py`` and ``findings.py`` are being
reworked apart from this change and still call ``wire_tool``, so it stays for them alone until that
work drops the call — after which this module goes. It rebinds an attribute of the adapter Hermes
hands the plugin, which the catalog's rule 9 forbids, so nothing new may use it.
"""

from __future__ import annotations

import logging
from typing import Any, Dict

logger = logging.getLogger(__name__)


def wire_tool(adapter: Any, tool: str, schema: Dict[str, Any], label: str) -> bool:
    """Makes every agent the API server builds carry the tool when this profile registered it,
    since a saved ``platform_toolsets.api_server`` would otherwise leave the plugin's toolset out."""
    original = getattr(adapter, "_create_agent", None)
    if not callable(original):
        return False

    def create_agent(*args: Any, **kwargs: Any) -> Any:
        agent = original(*args, **kwargs)
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
