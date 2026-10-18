"""A bot's MCP servers, read from Hermes's own in-process machinery inside that bot's profile.

Hermes keeps every MCP server a profile has in that profile's ``config.yaml`` and its live state in
the process serving it, and refuses to modify a server a Hermes *plugin* provides through its own
``mcp.json``. This module answers the app's MCP list from Hermes's own calls rather than from a
config file read by hand: the profile's config read
(``hermes_cli.mcp_config._get_mcp_servers``), the split between the profile's own servers and a
plugin's (``tui_gateway.mcp_rpc_helpers.server_configs_with_sources``) and the cached runtime state
read (``tools.mcp_tool_discovery.get_mcp_status``, whose own docstring says it never connects). So
rendering the screen cannot spawn a server or block on one.

The answer is Gots' own state words, mapped from Hermes's finer ones: ``connected``, ``configured``
and ``lazy`` are all **on** (a server configured but not yet connected is one this bot has),
``disabled`` is **off**, ``connecting`` and ``failed`` are their own, a server whose configuration
declares ``auth: oauth`` and has no stored access is **needs_access**, and a server a Hermes plugin
provides is **plugin** — the app shows that one read-only, with no control that would change it.
An absent ``enabled`` key reads as on, because Hermes's own reader
(``tools.mcp_tool_common.mcp_server_enabled``) is what computes the status word mapped here, and it
defaults an absent key to true. Nothing about the tools a server brings is reported.

**A live connection outranks Server access, and Server access outranks a failure.** A server Hermes
reports connected is working, token or not, so it reads **on**: the stored-access check is applied
only where Hermes does not report that server connected. Where it does not, a server whose
configuration declares ``auth: oauth`` and has no stored access is **needs_access** — Hermes reports
one as ``failed`` (an auth error) until the flow lands, and ``needs_access`` is the word that says
why it is not working yet and offers the way to grant it. Any other server carries a failure's
reason: Hermes's own ``error`` text rides along whatever the state word, so a server a Hermes plugin
provides keeps the word ``plugin`` and still says why it failed.

This module owns every verb of the ``/mcp`` routes (#249). Only the read is written: ``catalogue``,
``install``, ``set_enabled``, ``remove`` and ``start_access`` belong here too — the Catalogue with
installed/enabled per entry, adding one from it through Hermes's connection-card path (never
``install_entry``, which can prompt on stdin and open a curses checklist in the host process),
writing the ``enabled`` flag and reconciling, removing one the way ``hermes mcp remove`` does, and
starting the Server access flow. The writes go through Hermes's config write scope, which also
serialises against its own config lock; this read takes the profile's home-and-secrets scope
(``hermes_cli.web_server_profiles._config_profile_scope``) — deliberately not ``_profile_scope``,
which swaps the skills module's globals under a process-global lock for the whole body.

Every Hermes symbol is imported late, inside the call that needs it, because a plugin loads before
the CLI package exists. A host that moved one raises ImportError, which becomes an ``McpError`` the
route answers as a 501; ``available()`` is that same check, for the ``info`` payload's feature gate.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

# Hermes's runtime status words (``tools.mcp_tool_discovery.get_mcp_status``) in Gots' words.
# Anything else — ``connected``, ``configured``, ``lazy``, or a word a newer Hermes adds — is on.
STATES = {"disabled": "off", "connecting": "connecting", "failed": "failed"}

# What a host without those built-ins answers with: the route's 501 and the feature gate's reason.
UNAVAILABLE = "This Hermes version can't read MCP servers from here."


class McpError(Exception):
    """A refusal the route answers with ``status`` (501 when this host can't do it at all)."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def _hermes() -> Dict[str, Any]:
    """Hermes's own MCP readers, imported at call time: a plugin loads before the CLI does."""
    try:
        from hermes_cli.mcp_config import _get_mcp_servers, _oauth_tokens_present
        from hermes_cli.web_server_profiles import _config_profile_scope
        from tools.mcp_tool_discovery import get_mcp_status
        from tui_gateway.mcp_rpc_helpers import server_configs_with_sources
    except ImportError as error:
        raise McpError(UNAVAILABLE, 501) from error
    return {
        "scope": _config_profile_scope,
        "servers": _get_mcp_servers,
        "sources": server_configs_with_sources,
        "status": get_mcp_status,
        "tokens_present": _oauth_tokens_present,
    }


def available() -> Optional[str]:
    """Why this host's MCP servers can't be read from here, or None when they can."""
    try:
        _hermes()
    except McpError as error:
        return str(error)
    return None


def read(profile: Optional[str]) -> List[Dict[str, Any]]:
    """Every MCP server ``profile`` has, sorted by name, each with its state and source.

    ``profile`` is a profile name, or None for the process's own. Blocking — config I/O, and
    Hermes's plugin discovery behind the source split — so call it from a worker thread
    (``asyncio.to_thread``), never the event loop. No server is connected, started or probed, and
    a host without the built-ins raises ``McpError`` with a 501.
    """
    hermes = _hermes()
    with hermes["scope"](profile):
        servers, owners = hermes["sources"](hermes["servers"]())
        reported = {
            row.get("name"): row
            for row in hermes["status"](servers)
            if isinstance(row, dict) and row.get("name")
        }
        found = [
            _server(name, cfg, owners.get(name), reported.get(name), hermes["tokens_present"])
            for name, cfg in servers.items()
        ]
    return sorted(found, key=lambda server: server["name"])


def _server(name: str, cfg: Any, owner: Optional[str], status: Any, tokens_present: Any) -> Dict[str, Any]:
    """One server in the app's own shape: Gots' state word, where it comes from, any reason."""
    cfg = cfg if isinstance(cfg, dict) else {}
    status = status if isinstance(status, dict) else {}
    state = _state(name, cfg, owner, status, tokens_present)
    return {
        "name": name,
        "state": state,
        "source": "plugin" if owner else "config",
        "reason": _reason(state, status),
    }


def _reason(state: str, status: Dict[str, Any]) -> Optional[str]:
    """Hermes's own failure text, whatever word the server carries — except ``needs_access``.

    A server a Hermes plugin provides keeps the word ``plugin`` (where it comes from, which is what
    the app shows it read-only for) and still carries why it failed. ``needs_access`` is the one
    word that is its own answer — the server is not working yet and the app offers the way to grant
    it — so the failure behind it is left out.
    """
    failure = status.get("error")
    if state == "needs_access" or not isinstance(failure, str):
        return None
    return failure or None


def _state(
    name: str, cfg: Dict[str, Any], owner: Optional[str], status: Dict[str, Any], tokens_present: Any
) -> str:
    """Gots' word for one server, from Hermes's own status and the auth its config declares."""
    if owner:
        # A server a Hermes plugin provides: Hermes refuses to modify it, so the app shows it
        # read-only, and this word is what says where it comes from.
        return "plugin"
    word = STATES.get(status.get("status"))
    if word == "off":
        return "off"
    # A live connection wins over the stored-access check: a server Hermes reports connected is
    # working, token or not, and needs_access is the word for one that is not connected and has no
    # stored access to work with.
    if not _connected(status) and cfg.get("auth") == "oauth" and not tokens_present(name):
        return "needs_access"
    return word or "on"


def _connected(status: Dict[str, Any]) -> bool:
    """Whether Hermes reports this server live: its own ``connected`` flag, or its status word."""
    return status.get("connected") is True or status.get("status") == "connected"
