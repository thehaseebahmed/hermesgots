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

This module owns every verb of the ``/mcp`` routes (#249): the read and the toggle are written, and
``catalogue``, ``install``, ``remove`` and ``start_access`` belong here too — the Catalogue with
installed/enabled per entry, adding one from it through Hermes's connection-card path (never
``install_entry``, which can prompt on stdin and open a curses checklist in the host process),
removing one the way ``hermes mcp remove`` does, and starting the Server access flow. The read takes
the profile's home-and-secrets scope (``hermes_cli.web_server_profiles._config_profile_scope``) —
deliberately not ``_profile_scope``, which swaps the skills module's globals under a process-global
lock for the whole body. A write takes that scope too, under Hermes's config write scope
(``hermes_cli.web_routers._common.config_write_scope``), which also serialises the change against
Hermes's own config lock.

``set_enabled`` writes only the server's ``enabled`` flag through Hermes's own config read and write,
then runs Hermes's own reconcile so the change is live for the bot's next turn. It never invokes the
consent-gated reload (``/reload-mcp``), which tears every server down and invalidates the prompt
cache, and it refuses a server a Hermes plugin provides, because Hermes will not modify one. Nothing
else of a server's configuration — its transport, command, URL, environment, auth — is touched, so
switching a server off and back on leaves it exactly as it was.

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


def _hermes_write() -> Dict[str, Any]:
    """Hermes's own MCP writers beside the readers, imported at call time.

    Only ``set_enabled`` needs these: the config read and write, the config write scope (the read
    scope plus Hermes's config-mutation lock) and the reconcile that makes a change live. They are
    imported separately from ``_hermes``'s readers, so a host that can list servers but lacks the
    writers still lists them; a host missing any of these raises ``McpError`` with a 501.
    """
    try:
        from hermes_cli.config import load_config, save_config
        from hermes_cli.mcp_config import _get_mcp_servers, _oauth_tokens_present
        from hermes_cli.web_routers._common import config_write_scope
        from tools.mcp_tool_discovery import get_mcp_status, reconcile_mcp_servers_with_config
        from tui_gateway.mcp_rpc_helpers import server_configs_with_sources
    except ImportError as error:
        raise McpError(UNAVAILABLE, 501) from error
    return {
        "scope": config_write_scope,
        "servers": _get_mcp_servers,
        "sources": server_configs_with_sources,
        "status": get_mcp_status,
        "tokens_present": _oauth_tokens_present,
        "load": load_config,
        "save": save_config,
        "reconcile": reconcile_mcp_servers_with_config,
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
        found = _rows(hermes, servers, owners)
    return sorted(found, key=lambda server: server["name"])


def set_enabled(profile: Optional[str], name: str, enabled: bool) -> Dict[str, Any]:
    """Switch one of ``profile``'s MCP servers on or off, and answer its row once it has landed.

    Writes only the server's ``enabled`` flag, through Hermes's own config read and write inside the
    profile's config write scope, so nothing else of the server's configuration is touched. Hermes's
    own reconcile then runs for that profile, so the change is live for the bot's next turn, and a
    chat that is already built keeps the servers it had; the consent-gated reload is never invoked.
    A server the profile doesn't have, or one a Hermes plugin provides (which Hermes will not
    modify), is refused.

    ``profile`` is a profile name, or None for the process's own. Blocking — config I/O and a
    reconcile, which takes a per-home lock and can back off for minutes — so call it from a worker
    thread, never the event loop. Answers the server's row as ``read`` shapes it, so the caller sees
    the state the change lands in.
    """
    hermes = _hermes_write()
    with hermes["scope"](profile):
        servers, owners = hermes["sources"](hermes["servers"]())
        if name not in servers:
            raise McpError(f"No MCP server named {name!r} on this bot.", 400)
        if owners.get(name):
            raise McpError(f"{name} is provided by a Hermes plugin, so it can't be changed.", 400)
        _write_flag(hermes, name, enabled)
        hermes["reconcile"]()
        servers, owners = hermes["sources"](hermes["servers"]())
        return _rows(hermes, servers, owners, only=name)[0]


def _write_flag(hermes: Dict[str, Any], name: str, enabled: bool) -> None:
    """Set one server's ``enabled`` flag in the profile's config, leaving every other key alone."""
    config = hermes["load"]()
    block = config.setdefault("mcp_servers", {})
    entry = block.get(name)
    if not isinstance(entry, dict):
        entry = {}
        block[name] = entry
    entry["enabled"] = bool(enabled)
    hermes["save"](config)


def _rows(
    hermes: Dict[str, Any], servers: Dict[str, Any], owners: Dict[str, Any], only: Optional[str] = None
) -> List[Dict[str, Any]]:
    """The app's row for each server, from Hermes's own status read (which never connects)."""
    reported = {
        row.get("name"): row
        for row in hermes["status"](servers)
        if isinstance(row, dict) and row.get("name")
    }
    return [
        _server(name, cfg, owners.get(name), reported.get(name), hermes["tokens_present"])
        for name, cfg in servers.items()
        if only is None or name == only
    ]


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
