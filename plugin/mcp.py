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
defaults an absent key to true. Every row carries that flag as its own ``enabled`` boolean beside
the word, and the app's switch is driven by the flag rather than by the word: the word is cached
runtime and can still read ``connecting`` for a server the config has just switched off. Nothing
about the tools a server brings is reported.

**A live connection outranks Server access, and Server access outranks a failure.** A server Hermes
reports connected is working, token or not, so it reads **on**: the stored-access check is applied
only where Hermes does not report that server connected. Where it does not, a server whose
configuration declares ``auth: oauth`` and has no stored access is **needs_access** — Hermes reports
one as ``failed`` (an auth error) until the flow lands, and ``needs_access`` is the word that says
why it is not working yet and offers the way to grant it. Any other server carries a failure's
reason: Hermes's own ``error`` text rides along whatever the state word, so a server a Hermes plugin
provides keeps the word ``plugin`` and still says why it failed.

This module owns every verb of the ``/mcp`` routes (#249): the read, the toggle and the removal are
written, and ``catalogue``, ``install`` and ``start_access`` belong here too — the Catalogue with
installed/enabled per entry, adding one from it through Hermes's connection-card path (never
``install_entry``, which can prompt on stdin and open a curses checklist in the host process), and
starting the Server access flow. The read takes
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

``remove`` takes a server away the way ``hermes mcp remove`` does, and answers what the profile has
left so the app's list is the Host's own answer rather than the row it guessed was gone: the
catalogue's own uninstall (``uninstall_entry`` — the configuration entry and the directory Hermes
cloned for it) and Hermes's OAuth manager, which drops the stored Server access and evicts the
provider cached in this process. The values in the profile's ``.env`` stay, because Hermes reuses one
when the same server is added again. Reconcile follows, so the removed server's live connection is
torn down and the bot's next turn can't use it. It refuses a server a Hermes plugin provides for the
same reason the toggle does, and an unknown one.

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

    An import of the config read and write, the config write scope (the read scope plus Hermes's
    config-mutation lock) and the reconcile that makes a change live. They are imported separately
    from ``_hermes``'s readers, so a host that can list servers but lacks the writers still lists
    them; a host missing any of these raises ``McpError`` with a 501, and the app advertises no
    switch on it.
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


def _hermes_remove() -> Dict[str, Any]:
    """The writers plus the two calls a removal needs beside them, imported at call time.

    A removal takes a server away the way ``hermes mcp remove`` does, so it needs two more of
    Hermes's own: the catalogue's uninstall, which drops the configuration entry and the directory
    Hermes cloned for it, and the process-wide OAuth manager, which drops the server's stored Server
    access. Both are older than the writers, but a host can have the writers without them, so they
    are their own set and ``removable`` advertises it apart from the switch.
    """
    hermes = _hermes_write()
    try:
        from hermes_cli.mcp_catalog import uninstall_entry
        from tools.mcp_oauth_manager import get_manager
    except ImportError as error:
        raise McpError(UNAVAILABLE, 501) from error
    return {**hermes, "uninstall": uninstall_entry, "oauth": get_manager}


def available() -> Optional[str]:
    """Why this host's MCP servers can't be read from here, or None when they can."""
    try:
        _hermes()
    except McpError as error:
        return str(error)
    return None


def writable() -> Optional[str]:
    """Why this host's MCP servers can't be switched from here, or None when they can.

    The switch needs Hermes's config read and write, the config write scope and the reconcile, which
    is a different set from the read's: the scope and the reconcile arrived with the dashboard's MCP
    routes, where the cached status read is newer. ``info`` advertises this as its own feature, so a
    host that can list servers but not switch one offers no switch.
    """
    try:
        _hermes_write()
    except McpError as error:
        return str(error)
    return None


def removable() -> Optional[str]:
    """Why this host's MCP servers can't be removed from here, or None when they can.

    A removal needs the switch's writers plus the catalogue's uninstall and the OAuth manager, and a
    host can have the first without the second — the plugin that first shipped the switch is exactly
    that host — so this is its own gate rather than part of ``writable``'s. ``info`` advertises it as
    its own feature too, so a bot whose plugin predates the removal offers no removal rather than one
    whose every tap is a 404.
    """
    try:
        _hermes_remove()
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
        return _all_rows(hermes)


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
        _writable_server(hermes, name)
        _write_flag(hermes, name, enabled)
        hermes["reconcile"]()
        servers, owners = hermes["sources"](hermes["servers"]())
        return _rows(hermes, servers, owners, only=name)[0]


def remove(profile: Optional[str], name: str) -> List[Dict[str, Any]]:
    """Take one of ``profile``'s MCP servers away, and answer the servers it has left.

    Matches ``hermes mcp remove``: the server's configuration entry and the directory Hermes cloned
    for it go through the catalogue's own uninstall, and its stored Server access is dropped through
    Hermes's OAuth manager, which evicts the provider cached in this process too. The values in the
    profile's ``.env`` stay, because Hermes reuses one when the same server is added again. Hermes's
    own reconcile then runs for that profile, so the server's live connection is torn down and the
    bot's next turn can't use it; the consent-gated reload is never invoked. A server the profile
    doesn't have, or one a Hermes plugin provides (which Hermes will not modify), is refused.

    ``profile`` is a profile name, or None for the process's own. Blocking — config I/O, a directory
    removal and a reconcile, which takes a per-home lock and can back off for minutes — so call it
    from a worker thread, never the event loop. Answers the profile's remaining servers as ``read``
    shapes them, so the app's list is the Host's own answer rather than the row it dropped.
    """
    hermes = _hermes_remove()
    with hermes["scope"](profile):
        _writable_server(hermes, name)
        hermes["uninstall"](name, purge_install_dir=True)
        hermes["oauth"]().remove(name)
        hermes["reconcile"]()
        return _all_rows(hermes)


def _writable_server(hermes: Dict[str, Any], name: str) -> None:
    """Refuse a server the profile doesn't have, or one a Hermes plugin provides.

    Hermes will not modify a server a plugin provides, so neither a switch nor a removal can land on
    one; both writes ask this the same way, and answer the same 400 for each.
    """
    servers, owners = hermes["sources"](hermes["servers"]())
    if name not in servers:
        raise McpError(f"No MCP server named {name!r} on this bot.", 400)
    if owners.get(name):
        raise McpError(f"{name} is provided by a Hermes plugin, so it can't be changed.", 400)


def _write_flag(hermes: Dict[str, Any], name: str, enabled: bool) -> None:
    """Set one server's ``enabled`` flag in the profile's config, leaving every other key alone.

    A bare ``mcp_servers:`` in the YAML reads as null, so a block that isn't a mapping is made into
    one rather than failing; an entry that is neither null nor a mapping is refused, because writing
    the flag would mean dropping whatever it holds.
    """
    config = hermes["load"]()
    if not isinstance(config, dict):
        raise McpError("This bot's config couldn't be read, so its MCP servers can't be changed.")
    block = config.get("mcp_servers")
    if not isinstance(block, dict):
        block = {}
        config["mcp_servers"] = block
    entry = block.get(name)
    if entry is None:
        entry = {}
        block[name] = entry
    if not isinstance(entry, dict):
        raise McpError(f"{name}'s configuration isn't a mapping, so it can't be changed.", 400)
    entry["enabled"] = bool(enabled)
    hermes["save"](config)


def _all_rows(hermes: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Every one of the profile's servers as a row, in name order — what a read answers.

    Both the read and a removal answer this shape, so the order the app's list is in lives here
    rather than in each of them. Call it inside the profile's scope.
    """
    servers, owners = hermes["sources"](hermes["servers"]())
    return sorted(_rows(hermes, servers, owners), key=lambda server: server["name"])


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
    """One server in the app's own shape: Gots' state word, whether it is on, where it comes from."""
    cfg = cfg if isinstance(cfg, dict) else {}
    status = status if isinstance(status, dict) else {}
    state = _state(name, cfg, owner, status, tokens_present)
    return {
        "name": name,
        "state": state,
        "enabled": _enabled(cfg),
        "source": "plugin" if owner else "config",
        "reason": _reason(state, status),
    }


def _enabled(cfg: Dict[str, Any]) -> bool:
    """Whether a server's configuration leaves it on.

    Hermes's own reader (``tools.mcp_tool_common.mcp_server_enabled``) defaults an absent, null or
    unparseable ``enabled`` key to true, and so does this. The app drives a row's switch from this
    rather than from the state word: the word is Hermes's cached runtime, which can still read
    ``connecting`` or ``failed`` for a server the config has just switched off, while the flag is
    what a toggle writes and so what the switch has to agree with.
    """
    return cfg.get("enabled", True) is not False


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
