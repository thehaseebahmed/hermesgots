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

This module owns every verb of the ``/mcp`` routes (#249): the read, the toggle, the removal, the
Catalogue and adding from it are written, and ``start_access`` — starting the Server access flow for
a server that is waiting on it — belongs here too. The read takes
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

``catalogue`` answers what Hermes's own Catalogue offers this bot — every entry Hermes's own
``list_catalog`` returns, each marked with whether the profile already has it (Hermes's own
``installed_servers``, read once for the whole list, inside the profile's scope). It is a read of the
browsing half of adding a server: it connects nothing, writes nothing and never touches a value an
entry declares, so opening it cannot change the bot. A host whose Hermes has no catalogue module
raises ``McpError`` with a 501, and ``browsable()`` is that same check for the ``info`` payload's
gate, so an older Host is a Bot with no Add action rather than an error.

Adding one is ``entry`` (what an entry declares) and ``install`` (write it). ``entry`` answers one
Catalogue entry with the values it declares — each with whether it is required, whether it is secret,
the default its manifest pins and whether this bot already has a value for it — and never a value the
bot holds: a stored secret is reported as **set** and nothing else, which is the whole of what the
screen may know about it. ``install`` takes the values the user typed and writes the server the way
Hermes's own connection card does, minus everything a terminal owns: Hermes's own
``card_install_config`` builds the ``mcp_servers.<name>`` block in memory (never ``install_entry``,
which can prompt on stdin and open a curses checklist in the host process), a value the manifest
declares non-secret is inlined into that block through Hermes's own ``_inline_non_secret_value`` so
the file holds the value the server needs, a secret stays a ``${NAME}`` reference and goes to the
profile's ``.env`` through Hermes's own ``save_env_value`` (behind its own name guard, so configuring
one server is not a general environment-writing primitive), and Hermes's own ``_save_mcp_server``
writes it — refusing, with its validator's own sentence, a configuration it considers suspicious.
Nothing is written before every value checks out, so a refused add leaves the bot exactly as it was;
the reconcile follows, so the server is live for the bot's next turn. Granting Server access is its
own step (``start_access``): an entry whose auth is OAuth is added with its marker and reads
``needs_access`` until the row's flow lands.

Every Hermes symbol is imported late, inside the call that needs it, because a plugin loads before
the CLI package exists. A host that moved one raises ImportError, which becomes an ``McpError`` the
route answers as a 501; ``available()`` is that same check, for the ``info`` payload's feature gate,
and so are ``writable``, ``removable``, ``browsable`` and ``addable`` — each control's own built-ins,
so no control is offered whose every tap could only fail.
"""

from __future__ import annotations

import importlib
import re
import threading
from typing import Any, Callable, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, urlparse

# Hermes's runtime status words (``tools.mcp_tool_discovery.get_mcp_status``) in Gots' words.
# Anything else — ``connected``, ``configured``, ``lazy``, or a word a newer Hermes adds — is on.
STATES = {"disabled": "off", "connecting": "connecting", "failed": "failed"}

# What a host without those built-ins answers with: the route's 501 and the feature gate's reason.
UNAVAILABLE = "This Hermes version can't read MCP servers from here."
UNAVAILABLE_ACCESS = "This Hermes version can't start Server access from here."

# The flows this plugin started, by (profile, server), so a second tap reopens the same URL instead
# of minting a new one: Hermes's own start cancels the older attempt and binds a new port, which would
# kill a URL the user may already be pasting into a browser.
_flows: Dict[Tuple[str, str], Any] = {}
_flows_lock = threading.Lock()


class McpError(Exception):
    """A refusal the route answers with ``status`` (501 when this host can't do it at all)."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


# Where Hermes's own MCP built-ins live, by the name this module asks for them. Each group is declared
# once and each flow states the groups it actually touches: a flow that writes needs the writers, and
# a host can have the readers without them — which is why the gates are apart rather than one list. A
# missing built-in answers 501 for that flow alone, so a gate must never name something its own work
# never calls: a host that moved an unused symbol would lose a feature that would have worked.
_PROFILE_SCOPE: Dict[str, Tuple[str, str]] = {
    "read_scope": ("hermes_cli.web_server_profiles", "_config_profile_scope"),
}
_CONFIG_SCOPE: Dict[str, Tuple[str, str]] = {
    "write_scope": ("hermes_cli.web_routers._common", "config_write_scope"),
}
_SERVERS: Dict[str, Tuple[str, str]] = {
    "servers": ("hermes_cli.mcp_config", "_get_mcp_servers"),
    "sources": ("tui_gateway.mcp_rpc_helpers", "server_configs_with_sources"),
}
# What a row's own state costs: the status word, and whether an OAuth access is stored.
_STATUS: Dict[str, Tuple[str, str]] = {
    "status": ("tools.mcp_tool_discovery", "get_mcp_status"),
    "tokens_present": ("hermes_cli.mcp_config", "_oauth_tokens_present"),
}
# Landing one server's block: Hermes's writer and validator, and the environment write with its name
# guard, so a configuration never holds a credential of its own.
_BLOCK: Dict[str, Tuple[str, str]] = {
    "save_server": ("hermes_cli.mcp_config", "_save_mcp_server"),
    "validate": ("hermes_cli.mcp_security", "validate_mcp_server_entry"),
    "get_env": ("hermes_cli.config", "get_env_value"),
    "save_env": ("hermes_cli.config", "save_env_value"),
    "check_name": ("hermes_cli.config", "validate_env_var_name_for_write"),
}
_RECONCILE: Dict[str, Tuple[str, str]] = {
    "reconcile": ("tools.mcp_tool_discovery", "reconcile_mcp_servers_with_config"),
}

# The tab's own read: the rows, and the state each one is drawn from.
_READ: Dict[str, Tuple[str, str]] = {
    **_PROFILE_SCOPE,
    **_SERVERS,
    **_STATUS,
}

# The switch's set: the config write scope, the config read and write that sets one flag, and the
# reconcile that makes the change live for the bot's next turn.
_WRITE: Dict[str, Tuple[str, str]] = {
    **_READ,
    **_CONFIG_SCOPE,
    **_RECONCILE,
    "load": ("hermes_cli.config", "load_config"),
    "save": ("hermes_cli.config", "save_config"),
}

# A removal is the way ``hermes mcp remove`` takes one away: the writers, the catalogue's uninstall
# (the config entry and the directory Hermes cloned) and the process-wide OAuth manager.
_REMOVE: Dict[str, Tuple[str, str]] = {
    **_WRITE,
    "uninstall": ("hermes_cli.mcp_catalog", "uninstall_entry"),
    "oauth": ("tools.mcp_oauth_manager", "get_manager"),
}

_CATALOGUE: Dict[str, Tuple[str, str]] = {
    **_PROFILE_SCOPE,
    "list": ("hermes_cli.mcp_catalog", "list_catalog"),
    "installed": ("hermes_cli.mcp_catalog", "installed_servers"),
}

# Adding an entry: the writes that land it, the adding half of the catalogue — its entry read, the
# block Hermes builds from a manifest (never ``install_entry``, which owns a terminal's prompts,
# probe and curses checklist), the inlining that turns a non-secret value into the value the
# manifest's ``${NAME}`` refs stand for — and the profile's environment write, so a secret only lands
# once the block has.
_INSTALL: Dict[str, Tuple[str, str]] = {
    **_PROFILE_SCOPE,
    **_CONFIG_SCOPE,
    **_SERVERS,
    **_STATUS,
    **_BLOCK,
    **_RECONCILE,
    "installed": ("hermes_cli.mcp_catalog", "installed_servers"),
    "entry": ("hermes_cli.mcp_catalog", "get_entry"),
    "card": ("hermes_cli.mcp_catalog", "card_install_config"),
    "catalog_error": ("hermes_cli.mcp_catalog", "CatalogError"),
    "inline": ("hermes_cli.mcp_catalog", "_inline_non_secret_value"),
}

# One server's block, as its sheet reads it and writes it: the catalogue is deliberately not among
# them, since a server typed in by hand has no entry.
_CONFIGURE: Dict[str, Tuple[str, str]] = {
    **_PROFILE_SCOPE,
    **_CONFIG_SCOPE,
    **_SERVERS,
    **_STATUS,
    **_BLOCK,
    **_RECONCILE,
    "bearer": ("hermes_cli.mcp_config", "_save_bearer_auth_token"),
}

# The Tools tab: Hermes's schema cache, which connects nothing, and the probe a tap asks for. No
# status and no stored access: reading a tool list never needs either.
_TOOLS: Dict[str, Tuple[str, str]] = {
    **_PROFILE_SCOPE,
    **_SERVERS,
    "fingerprint": ("tools.mcp_schema_cache", "config_fingerprint"),
    "cached": ("tools.mcp_schema_cache", "get_cached_entry"),
    "from_cache": ("tools.mcp_schema_cache", "tools_from_cache_entry"),
    "probe": ("hermes_cli.mcp_config", "_probe_single_server"),
    "redact": ("hermes_cli.mcp_config", "redact_mcp_probe_text"),
}

# Server access: Hermes's non-blocking card start, which is newer than the read and the writers.
_ACCESS: Dict[str, Tuple[str, str]] = {
    **_PROFILE_SCOPE,
    **_SERVERS,
    "start": ("tools.connectors.mcp_oauth", "start"),
}


def _load(needs: Dict[str, Tuple[str, str]], message: str = UNAVAILABLE) -> Dict[str, Any]:
    """Hermes's own built-ins, imported at call time: a plugin loads before the CLI does.

    A host whose Hermes has moved or dropped any of them raises ``McpError`` with a 501 carrying
    ``message`` — what its route answers with, and what the feature gate tells the app.
    """
    found: Dict[str, Any] = {}
    for key, (module, attribute) in needs.items():
        try:
            found[key] = getattr(importlib.import_module(module), attribute)
        except (ImportError, AttributeError) as error:
            raise McpError(message, 501) from error
    return found


def _hermes() -> Dict[str, Any]:
    """Hermes's own MCP readers (see ``_READ``)."""
    return _load(_READ)


def _hermes_write() -> Dict[str, Any]:
    """The readers plus Hermes's config read and write, its write scope and the reconcile."""
    return _load(_WRITE)


def _hermes_remove() -> Dict[str, Any]:
    """The writers plus the calls a removal needs (see ``_REMOVE``)."""
    return _load(_REMOVE)


def _hermes_catalogue() -> Dict[str, Any]:
    """Hermes's own Catalogue and its read of the profile's servers (see ``_CATALOGUE``)."""
    return _load(_CATALOGUE)


def _hermes_install() -> Dict[str, Any]:
    """Everything adding a Catalogue entry needs (see ``_INSTALL``)."""
    return _load(_INSTALL)


def _gate(needs: Dict[str, Tuple[str, str]], message: str = UNAVAILABLE) -> Optional[str]:
    """Why a host can't offer a flow, or None when it can: whether its built-ins are all there."""
    try:
        _load(needs, message)
    except McpError as error:
        return str(error)
    return None


def available() -> Optional[str]:
    """Why this host's MCP servers can't be read from here, or None when they can."""
    return _gate(_READ)


def writable() -> Optional[str]:
    """Why this host's MCP servers can't be switched from here, or None when they can.

    The switch needs Hermes's config read and write, the config write scope and the reconcile, which
    is a different set from the read's: the scope and the reconcile arrived with the dashboard's MCP
    routes, where the cached status read is newer. ``info`` advertises this as its own feature, so a
    host that can list servers but not switch one offers no switch.
    """
    return _gate(_WRITE)


def removable() -> Optional[str]:
    """Why this host's MCP servers can't be removed from here, or None when they can.

    A removal needs the switch's writers plus the catalogue's uninstall and the OAuth manager, and a
    host can have the first without the second — the plugin that first shipped the switch is exactly
    that host — so this is its own gate rather than part of ``writable``'s. ``info`` advertises it as
    its own feature too, so a bot whose plugin predates the removal offers no removal rather than one
    whose every tap is a 404.
    """
    return _gate(_REMOVE)


def read(profile: Optional[str]) -> List[Dict[str, Any]]:
    """Every MCP server ``profile`` has, sorted by name, each with its state and source.

    ``profile`` is a profile name, or None for the process's own. Blocking — config I/O, and
    Hermes's plugin discovery behind the source split — so call it from a worker thread
    (``asyncio.to_thread``), never the event loop. No server is connected, started or probed, and
    a host without the built-ins raises ``McpError`` with a 501.
    """
    hermes = _hermes()
    with hermes["read_scope"](profile):
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
    with hermes["write_scope"](profile):
        _writable_server(hermes, name)
        _write_flag(hermes, name, enabled)
        hermes["reconcile"]()
        servers, owners = _blocks(hermes)
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
    with hermes["write_scope"](profile):
        _writable_server(hermes, name)
        hermes["uninstall"](name, purge_install_dir=True)
        hermes["oauth"]().remove(name)
        hermes["reconcile"]()
        return _all_rows(hermes)


def browsable() -> Optional[str]:
    """Why this host's Catalogue can't be browsed from here, or None when it can.

    Browsing needs Hermes's catalogue module and the profile's read scope, which is a different set
    from the read's: a host can list a bot's servers without offering the Catalogue at all. ``info``
    advertises this as its own feature, so that host's Bot gets no Add action rather than one whose
    every tap is a 501.
    """
    return _gate(_CATALOGUE)


def addable() -> Optional[str]:
    """Why this host can't add a Catalogue entry to a bot from here, or None when it can.

    Adding one needs Hermes's catalogue (its entry read and the block it builds) and the writes that
    land it — the config write, the validator behind it, the environment writer and its name guard,
    and the reconcile. That is its own set again: a host can list a bot's servers, switch one and
    browse the Catalogue with the catalogue's own built-ins alone. ``info`` advertises this as its
    own feature, so that host's Bot gets no Add action rather than one whose every tap is a 501.
    """
    return _gate(_INSTALL)


def accessible() -> Optional[str]:
    """Why this host's Server access can't be started from here, or None when it can.

    Starting one is a different set of built-ins again — Hermes's non-blocking card start, which is
    newer than the read and the writers — so a host that lists its servers but predates that start
    offers no Grant access rather than a button whose every tap is a 501.
    """
    return _gate(_ACCESS, UNAVAILABLE_ACCESS)


def configurable() -> Optional[str]:
    """Why one server's own configuration can't be read or written from here, or None when it can.

    Reading a block and writing it back is the writers' set plus Hermes's validator, its environment
    writer and that writer's name guard — and the catalogue is *not* one of them: a server typed in by
    hand has no entry, so the Config screen works on a host with no Catalogue at all. ``info``
    advertises it as its own feature, so a host without these offers no Config tab rather than one
    whose save could only fail.
    """
    return _gate(_CONFIGURE)


def tool_readable() -> Optional[str]:
    """Why a server's tools can't be listed from here, or None when they can.

    The cache read and the one-server probe are a newer set than the block writers — a host can list,
    switch and edit servers without the schema cache — so the Tools tab has its own gate, and a host
    without it offers no Tools tab.
    """
    return _gate(_TOOLS)


def detail(profile: Optional[str], name: str) -> Dict[str, Any]:
    """One of ``profile``'s servers as the Config screen is built from it, never a value it holds.

    The transport and what it runs — a URL, or a command and its arguments — plus one row per
    environment name the block holds, masked, saying whether the bot already holds it. The content of
    a value is never answered, whether it sits in the profile's ``.env`` behind a ``${NAME}``
    reference or inline in the block; ``set`` is the whole of what the screen may know.

    A server a Hermes plugin provides is answered too, with ``editable`` false: Hermes refuses to
    modify those, and the screen shows what the plugin's own ``mcp.json`` runs without a Save.

    ``profile`` is a profile name, or None for the process's own. Blocking — the profile's config
    and ``.env`` are read — so call it from a worker thread, never the event loop. Nothing is
    connected, started or written.
    """
    hermes = _hermes_configure()
    with hermes["read_scope"](profile):
        servers, owners = _blocks(hermes)
        cfg = _server_block(servers, name)
        return _detail(name, cfg, bool(owners.get(name)), hermes)


def edit(profile: Optional[str], name: str, body: Dict[str, Any]) -> Dict[str, Any]:
    """Save the Config screen's edit of one of ``profile``'s servers, and answer the servers left.

    The body carries the transport the form ended on and its fields: ``url`` or ``command``/``args``
    for a stdio server, ``auth`` (``none``/``header``/``oauth``) and an optional ``token`` for an
    HTTP one, and ``values`` — the environment values typed over, by name. An empty value is left as
    it is, so a value the bot holds is never asked for again; a typed one is written to the
    profile's ``.env`` and the block keeps Hermes's ``${NAME}`` reference, so the configuration never
    holds a credential. Switching transport drops the old one's fields, since a URL and a command are
    never both.

    The block is built from the one the profile has, so every key this screen doesn't manage — a
    server's ``enabled`` flag, its OAuth client block, a connect timeout — is left exactly as it was.
    Hermes's own validator has the last word: a block it refuses is a 400 carrying its own sentence,
    and a server a Hermes plugin provides, or one the profile doesn't have, is refused the same way.
    Hermes's own reconcile follows, so the change is live for the bot's next turn.

    Answers the servers left and this one's block as it landed, so the screen that saved needs no
    second read. ``profile`` is a profile name, or None for the process's own. Blocking — config
    I/O, the environment write and a reconcile — so call it from a worker thread, never the event
    loop.
    """
    hermes = _hermes_configure()
    with hermes["write_scope"](profile):
        servers, _ = _writable_server(hermes, name)
        typed = _typed(hermes, body.get("values"))
        block = _edited(hermes, name, _server_block(servers, name), body, typed)
        return _write_block(hermes, name, block, typed)


def _write_block(
    hermes: Dict[str, Any], name: str, block: Dict[str, Any], values: Dict[str, str]
) -> Dict[str, Any]:
    """Write one server's block and the values typed into it, then answer what the write left.

    Call it inside the profile's write scope, after the name is known to be one this bot may change
    and after ``_typed`` has checked the values it is given. Hermes's validator has the last word on
    the block; the values a form typed are the only ones written, and each lands in the profile's
    ``.env`` while the block keeps its ``${NAME}`` reference, so no credential is ever part of a
    configuration. Shared by the Config save and a custom add, because both land a block the same way
    (ADR 0014).
    """
    return _land(hermes, name, block, values)


def _land(
    hermes: Dict[str, Any], name: str, block: Dict[str, Any], values: Dict[str, str]
) -> Dict[str, Any]:
    """Write one validated block and its checked values, reconcile, and answer what the write left.

    Call it inside the profile's write scope, after the block is built and the values are checked.
    Hermes's validator has the last word on the block; the values land in the profile's ``.env`` while
    the block keeps its ``${NAME}`` reference, so no credential is ever part of a configuration. Both
    the Config save and a Catalogue add land a block this way, so the order — the block first, and no
    value written under a block Hermes refused — is stated once.
    """
    if not hermes["save_server"](name, block):
        raise McpError(_refusal(hermes, name, block))
    for key, value in values.items():
        hermes["save_env"](key, value)
    hermes["reconcile"]()
    # The servers left, and the block as the write landed it: the sheet that saved is looking at
    # this server, and reading it again would be a second round trip for a fact this call holds.
    return {"servers": _all_rows(hermes), "server": _detail(name, block, False, hermes)}


def custom(profile: Optional[str], body: Dict[str, Any]) -> Dict[str, Any]:
    """Add a server the Catalogue doesn't offer, from what the form collected, and answer the list.

    ``body`` is a name and exactly one transport — ``url``, or ``command`` with ``args`` — plus an
    HTTP server's ``auth`` and optional ``token``, and the environment ``values`` a stdio one needs.
    It is the Dashboard's own create contract (``hermes mcp add``, ``POST /api/mcp/servers``) with one
    deliberate difference: a value goes to the profile's ``.env`` and the block holds Hermes's
    ``${NAME}`` reference, as a Catalogue add already does, rather than inline — so a credential
    never lands in ``config.yaml`` (ADR 0014).

    The write is the same one an add from the Catalogue takes — Hermes's validator, then its own
    ``_save_mcp_server``, then the reconcile — so a configuration it refuses is a 400 carrying its
    own sentence and nothing is half-added. A name the profile already has, or one a Hermes plugin
    provides, is refused before anything is built: a custom add never overwrites.

    ``profile`` is a profile name, or None for the process's own. Blocking — config I/O, the
    environment write and a reconcile — so call it from a worker thread, never the event loop.
    """
    hermes = _hermes_install()
    with hermes["write_scope"](profile):
        name = _new_name(hermes, body.get("name"))
        if body.get("url") and body.get("command"):
            raise McpError("A server has either an address or a command, never both.", 400)
        typed = _typed(hermes, body.get("values"))
        block = _edited(hermes, name, {}, body, typed)
        return _write_block(hermes, name, block, typed)


def tools(profile: Optional[str], name: str) -> Dict[str, Any]:
    """The tools ``profile``'s server ``name`` offers, from Hermes's own schema cache.

    Hermes writes that cache on every successful registration — the tools' names, descriptions and
    input schemas, keyed by the configuration it read them from — so this answers a connected or
    lazily registered server's tools without connecting anything, and an empty answer with
    ``cached`` false for one that has never connected (or whose configuration has changed since).
    The screen offers ``probe`` for that case rather than connecting on its own (ADR 0014).

    A server a Hermes plugin provides is answered like any other: its tools are the plugin's, and
    reading them changes nothing.

    ``profile`` is a profile name, or None for the process's own. Blocking — the cache is a file read
    and the profile's config is read for the fingerprint — so call it from a worker thread, never the
    event loop.
    """
    hermes = _hermes_tools()
    with hermes["read_scope"](profile):
        servers, _ = _blocks(hermes)
        cfg = _server_block(servers, name)
        entry = hermes["cached"](name, hermes["fingerprint"](cfg))
        if not entry:
            return {"cached": False, "items": []}
        return {"cached": True, "items": _tool_rows(hermes["from_cache"](entry))}


def probe_tools(profile: Optional[str], name: str) -> Dict[str, Any]:
    """List ``profile``'s server ``name``'s tools by connecting it once, then disconnecting it.

    This is the one read here that reaches the server, so it is never on a screen's open: the app
    asks for it when the user taps Load tools, given a long timeout, and Hermes's own one-server probe
    connects with the server's own ``connect_timeout``, lists what it offers and shuts it down
    without registering anything. A failure is Hermes's own sentence, redacted of anything its
    transport may have printed, and is a 400 rather than a 500.

    ``profile`` is a profile name, or None for the process's own. Blocking, for as long as the
    server takes to answer, so call it from a worker thread, never the event loop.
    """
    hermes = _hermes_tools()
    with hermes["read_scope"](profile):
        servers, _ = _blocks(hermes)
        cfg = _server_block(servers, name)
        try:
            found = hermes["probe"](name, cfg)
        except Exception as error:  # noqa: BLE001 - Hermes raises whatever its transport did
            raise McpError(_probe_reason(hermes, name, error), 400) from error
        return {"cached": False, "items": _tool_rows(found)}


def _hermes_configure() -> Dict[str, Any]:
    """The writers plus what one server's block needs (see ``_CONFIGURE``)."""
    return _load(_CONFIGURE)


def _hermes_tools() -> Dict[str, Any]:
    """The readers plus the schema cache and the one-server probe (see ``_TOOLS``)."""
    return _load(_TOOLS)


# A value's content, when the block holds a reference rather than the value itself.
_REFERENCE = re.compile(r"^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$")


def _blocks(hermes: Dict[str, Any]) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """The profile's servers and who provides each one: two calls, read as one.

    Hermes's ``servers()`` answers the merged configuration and ``sources()`` says which of them a
    plugin provides; nothing here wants one without the other, and reading them apart cost a second
    config load and a second plugin discovery on every request.
    """
    servers, owners = hermes["sources"](hermes["servers"]())
    return servers, owners


def _server_block(servers: Dict[str, Any], name: str) -> Dict[str, Any]:
    """One server's own block, or a 400 for one this bot doesn't have."""
    if name not in servers:
        raise McpError(f"No MCP server named {name!r} on this bot.", 400)
    block = servers[name]
    return block if isinstance(block, dict) else {}


def _detail(
    name: str, cfg: Dict[str, Any], plugin: bool, hermes: Dict[str, Any]
) -> Dict[str, Any]:
    """One server as the Config screen is built from it. Call it inside the profile's scope."""
    transport = "http" if cfg.get("url") else "stdio"
    return {
        "name": name,
        "source": "plugin" if plugin else "config",
        "transport": transport,
        "url": str(cfg.get("url") or ""),
        "command": str(cfg.get("command") or ""),
        "args": [str(argument) for argument in (cfg.get("args") or [])],
        "auth": _auth(cfg),
        "editable": not plugin,
        "values": _value_rows(cfg, hermes),
    }


def _auth(cfg: Dict[str, Any]) -> str:
    """What the server's configuration declares about how it authenticates."""
    if cfg.get("auth") == "oauth":
        return "oauth"
    return "header" if cfg.get("headers") else "none"


def _value_rows(cfg: Dict[str, Any], hermes: Dict[str, Any]) -> List[Dict[str, Any]]:
    """One row per environment name the block holds, A to Z, masked and marked set or not.

    Only the block's own names. A row says what this server's configuration has, never what a
    catalogue entry that happens to share the server's name declares — a server the form added by
    hand is described by nothing but itself. Every value is masked, since a block cannot tell a
    credential from a setting and masking is the harmless side to guess wrong on.
    """
    block = cfg.get("env") if isinstance(cfg.get("env"), dict) else {}
    return [
        {"name": key, "set": _holds(block, key, hermes)}
        for key in sorted(str(key) for key in block)
    ]


def _holds(block: Dict[str, Any], key: str, hermes: Dict[str, Any]) -> bool:
    """Whether this bot holds a value for ``key`` — in the block, or where a reference points."""
    value = block.get(key)
    if isinstance(value, str):
        reference = _REFERENCE.match(value.strip())
        if reference:
            return bool(hermes["get_env"](reference.group(1)))
        if value.strip():
            return True
    return bool(hermes["get_env"](key))


def _edited(
    hermes: Dict[str, Any],
    name: str,
    cfg: Dict[str, Any],
    body: Dict[str, Any],
    values: Dict[str, str],
) -> Dict[str, Any]:
    """The block the Config screen's body describes, built on the one the profile has.

    Every key the screen doesn't manage is carried over as it was, so a server's ``enabled`` flag, its
    OAuth client block and any tuning the Host holds survive an edit. Only the keys that belong to the
    transport being left are dropped, since a URL and a command are never both. ``values`` is what
    ``_typed`` made of the body's typed values: a name typed over becomes the ``${NAME}`` reference
    Hermes resolves at load, and the value itself lands in the profile's ``.env`` after the block has.
    """
    transport = str(
        body.get("transport") or ("http" if (body.get("url") or cfg.get("url")) else "stdio")
    )
    if transport not in ("http", "stdio"):
        raise McpError(f"{transport!r} is not a transport Gots can write.", 400)
    edited = dict(cfg)
    if transport == "http":
        url = str(body.get("url") or "").strip()
        if not url:
            raise McpError("An HTTP server needs an address.", 400)
        for key in ("command", "args", "env"):
            edited.pop(key, None)
        edited["url"] = url
        auth = str(body.get("auth") or "none").strip().lower()
        if auth not in ("none", "header", "oauth"):
            raise McpError(f"{auth!r} is not an authentication Gots can write.", 400)
        edited.pop("auth", None)
        if auth == "oauth":
            edited["auth"] = "oauth"
        if auth == "header":
            token = str(body.get("token") or "").strip()
            if token:
                edited["headers"] = _bearer(hermes)(name, token)
            elif not edited.get("headers"):
                raise McpError("A header needs a token.", 400)
        else:
            edited.pop("headers", None)
    else:
        command = str(body.get("command") or "").strip()
        if not command:
            raise McpError("A stdio server needs a command.", 400)
        for key in ("url", "headers", "auth"):
            edited.pop(key, None)
        edited["command"] = command
        arguments = body.get("args")
        if isinstance(arguments, list) and arguments:
            edited["args"] = [str(argument) for argument in arguments]
        else:
            edited.pop("args", None)
        env = dict(edited["env"]) if isinstance(edited.get("env"), dict) else {}
        # A value typed over becomes the reference Hermes resolves at load; the value itself goes to
        # the profile's .env after the block has landed, so a refused block writes nothing.
        for key in values:
            env[key] = "${%s}" % key
        if env:
            edited["env"] = env
        else:
            edited.pop("env", None)
    return edited


def _bearer(hermes: Dict[str, Any]) -> Any:
    """Hermes's header-token writer, which a custom add's own set doesn't carry (see ``_INSTALL``).

    Only a token typed into an HTTP server's header field needs it, so it is loaded at that point
    rather than up front: a Host without it keeps the whole custom form — a stdio add and an address
    with no header both work — and answers its own 501 for the one field it can't honour.
    """
    return hermes.get("bearer") or _load({"bearer": _CONFIGURE["bearer"]})["bearer"]


def _typed(hermes: Dict[str, Any], values: Any) -> Dict[str, str]:
    """The environment values a body typed over, each name checked the way Hermes writes one.

    An empty value is nothing typed, so a value the bot already holds stands untouched. A name
    Hermes's own writer would refuse is a 400 for the whole save before anything is written.
    """
    if values is None:
        return {}
    if not isinstance(values, dict) or not all(
        isinstance(key, str) and isinstance(value, str) for key, value in values.items()
    ):
        raise McpError('Values must be {"NAME": "value"}.', 400)
    typed: Dict[str, str] = {}
    for key, value in values.items():
        if not value.strip():
            continue
        try:
            hermes["check_name"](key)
        except ValueError as error:
            raise McpError(str(error), 400) from error
        typed[key] = value
    return typed


# The path segments the MCP routes answer before they reach one server's own name. A server named
# one of these would be shadowed by that route — `GET mcp/catalogue` is the Catalogue, not a server —
# so a custom add may not take one.
_RESERVED = ("catalogue", "custom", "install")


def _new_name(hermes: Dict[str, Any], raw: Any) -> str:
    """The name a custom add will use, or the 400 that refuses it before anything is built."""
    name = raw.strip() if isinstance(raw, str) else ""
    if not name:
        raise McpError("A server needs a name.", 400)
    if name in _RESERVED:
        raise McpError(f"{name!r} is a word this plugin's own routes answer, so it can't name a server.", 400)
    servers, owners = _blocks(hermes)
    if owners.get(name):
        raise McpError(f"{name} is provided by a Hermes plugin, so it can't be added.", 400)
    if name in servers:
        raise McpError(f"This bot already has an MCP server named {name}.", 400)
    return name


def _tool_rows(found: Any) -> List[Dict[str, Any]]:
    """A tool list as the app draws it — a name and what it does — from either answer Hermes gives.

    The schema cache hands back dicts and the probe hands back ``(name, description)`` pairs, so the
    one rule about a tool with no name (it is dropped) and the one row shape live here rather than in
    each reader.
    """
    rows = []
    for tool in found or []:
        if isinstance(tool, dict):
            name, description = tool.get("name"), tool.get("description")
        elif isinstance(tool, (list, tuple)) and tool:
            name, description = tool[0], tool[1] if len(tool) > 1 else ""
        else:
            continue
        if not isinstance(name, str) or not name:
            continue
        rows.append({"name": name, "description": description if isinstance(description, str) else ""})
    return rows


def _probe_reason(hermes: Dict[str, Any], name: str, error: Exception) -> str:
    """Why a probe failed, in Hermes's own words where it has any, redacted of what it printed."""
    try:
        text = hermes["redact"](error)
    except Exception:  # noqa: BLE001 - a redactor that can't read an error is no reason at all
        text = ""
    return str(text) if text else f"Couldn't reach {name}."


def start_access(profile: Optional[str], name: str) -> Dict[str, Any]:
    """Start (or resume) a Server access flow for ``name``, answering the URL to open and its life.

    Hermes's own start binds a one-shot 127.0.0.1 receiver on this host and hands back the provider's
    URL, so the browser that finishes it has to be one that can reach this machine — on the host
    itself, or on a phone whose callback is pasted back through ``deliver_access``. The flow is held
    per (profile, server) so a second tap answers the same URL: Hermes's start cancels the older
    attempt and binds a new port, which would invalidate a URL already being pasted into a browser.
    ``expires`` is the server's own callback window, in seconds, so the app can stop waiting.

    The URL is ``None`` when the access already stored for the server still works: there is nothing
    to open, and the row's next read is what says so.

    Only a server this bot's own configuration declares — a URL and ``auth: oauth`` — is started for.
    A row's *state* is deliberately not a gate here: a stored access that still works answers
    ``url: None`` rather than an error, and that path reads ``on``, so refusing anything but
    ``needs_access``/``failed`` would refuse the recovery this route exists for. The app offers the
    action only where ``_grantable`` says so, which is the same rule the row carries.
    """
    hermes = _hermes_access()
    with hermes["read_scope"](profile):
        servers, owners = _blocks(hermes)
        cfg = servers.get(name)
        if not isinstance(cfg, dict):
            raise McpError(f"No MCP server named {name!r} on this bot.", 400)
        if owners.get(name):
            raise McpError(f"{name} is provided by a Hermes plugin, so it can't be changed.", 400)
        if cfg.get("auth") != "oauth" or not cfg.get("url"):
            raise McpError(f"{name} doesn't use Server access.", 400)
        key = (profile or "", name)
        held = _held(key)
        if held is not None:
            return {"name": name, "url": held.auth_url, "expires": _expiry(cfg)}
        try:
            attempt = hermes["start"](name)
        except TimeoutError as error:
            raise McpError("This bot's host took too long to start Server access.", 504) from error
        except Exception as error:  # Hermes's own refusals are sentences for the user
            raise McpError(str(error) or "Server access couldn't be started.", 400) from error
        if not attempt.auth_url:
            # The stored access still works: nothing to open, and the row's read will say on.
            return {"name": name, "url": None, "expires": 0}
        with _flows_lock:
            _flows[key] = attempt
        return {"name": name, "url": attempt.auth_url, "expires": _expiry(cfg)}


def deliver_access(profile: Optional[str], name: str, url: str) -> Dict[str, Any]:
    """Hand a browser's redirect back to the running flow, after checking it is that flow's own.

    The URL is the address the browser ended on — on the host, or on a phone that could not reach
    the host's loopback. Only the flow's own redirect is accepted, and the flow itself enforces the
    ``state`` (constant-time) and refuses a second delivery, so a pasted address can't land in a
    different flow or grant the same code twice. The authorization code is exchanged on this host and
    is never kept here or on the device.
    """
    key = (profile or "", name)
    held = _held(key)
    if held is None:
        raise McpError(f"No Server access is running for {name}. Start it again from its row.", 400)
    redirect = getattr(held.flow, "redirect_uri", "") or ""
    if not _names_redirect(url, redirect):
        raise McpError("That address isn't the one this Server access ends on.", 400)
    query = parse_qs(urlparse(url).query)
    try:
        held.flow.deliver_callback(
            code=(query.get("code") or [None])[0],
            state=(query.get("state") or [None])[0],
            error=(query.get("error") or [None])[0],
            iss=(query.get("iss") or [None])[0],
        )
    except ValueError as error:
        raise McpError(str(error) or "This Server access can't take that answer.", 400) from error
    return {"name": name, "delivered": True}


def _hermes_access() -> Dict[str, Any]:
    """Hermes's non-blocking card start, which is newer than the read (see ``_ACCESS``)."""
    return _load(_ACCESS, UNAVAILABLE_ACCESS)

def _held(key: Tuple[str, str]) -> Any:
    """The flow this plugin started for ``key``, if it is still running; a finished one is dropped.

    Every lookup also drops every *other* finished attempt, so an abandoned flow can't keep its
    attempt (and the loopback receiver bound with it) for the process's life: the cache holds only
    flows that are still waiting for a callback. An attempt that can't be polled is treated as
    finished — the cost of being wrong is one tap on Try again, against leaking a receiver.
    """
    with _flows_lock:
        for other in list(_flows):
            attempt = _flows[other]
            try:
                finished = attempt.poll().get("status") != "pending"
            except Exception:
                finished = True
            if finished:
                _flows.pop(other, None)
        return _flows.get(key)


def _expiry(cfg: Dict[str, Any]) -> int:
    """How long, in seconds, a started flow waits for its callback: the server's own ``oauth.timeout``."""
    oauth = cfg.get("oauth") if isinstance(cfg.get("oauth"), dict) else {}
    try:
        return max(1, int(float(oauth.get("timeout", 300))))
    except (TypeError, ValueError):
        return 300


def _names_redirect(url: str, redirect: str) -> bool:
    """Whether a pasted address is the redirect one flow waits for: same loopback host, port, path."""
    pasted, expected = urlparse(url), urlparse(redirect)
    if pasted.scheme != "http" or expected.scheme != "http":
        return False
    if (pasted.hostname or "") != (expected.hostname or ""):
        return False
    if pasted.port != expected.port or not expected.port:
        return False
    return (pasted.path or "/").rstrip("/") == (expected.path or "/").rstrip("/")


# Every feature this module answers for, with the check that says why a host can't offer it: one row
# per control, because each needs its own built-ins (see each check above). ``info`` advertises
# exactly the features whose check passes, so a feature is declared here once rather than named by
# hand beside its gate, in the payload and on the screen.
FEATURES: Tuple[Tuple[str, Callable[[], Optional[str]]], ...] = (
    ("mcps", available),
    ("mcps_write", writable),
    ("mcps_remove", removable),
    ("mcps_catalogue", browsable),
    ("mcps_add", addable),
    ("mcps_access", accessible),
    ("mcps_config", configurable),
    ("mcps_tools", tool_readable),
)


def catalogue(profile: Optional[str]) -> List[Dict[str, Any]]:
    """Every Catalogue entry ``profile`` is offered, A to Z, each marked with whether it has one.

    Hermes's own ``list_catalog`` is the entries — a manifest dir its own CI and approval process
    curate — and its own read of the profile's servers is the mark, so it says what Hermes itself
    would. An entry is reported by name and what Hermes says it is; one whose description is
    missing or empty reads as an empty one rather than being dropped, and the app shows its name
    alone.

    ``profile`` is a profile name, or None for the process's own. Blocking — the catalogue reads a
    directory of manifests and the profile's config, and the scope may hydrate an external secret
    source — so call it from a worker thread, never the event loop. Nothing is added, connected,
    probed or written by this, and no value an entry declares is read or answered: it is the
    browsing half of adding a server, and opening it cannot change the bot.
    """
    hermes = _hermes_catalogue()
    with hermes["read_scope"](profile):
        servers = hermes["installed"]()
        entries = [_catalogue_entry(entry, servers) for entry in hermes["list"]()]
    return sorted(entries, key=lambda entry: entry["name"])


def _catalogue_entry(entry: Any, servers: Dict[str, Any]) -> Dict[str, Any]:
    """One of Hermes's ``CatalogEntry`` objects in the app's own shape. Call it inside the scope.

    ``servers`` is the profile's servers, read once for the whole Catalogue rather than per entry:
    Hermes's own per-entry check (``is_installed`` is ``name in installed_servers()``) reads the
    profile's config on every call, so asking it once per entry would load and expand that config
    once per entry on a list that can run to dozens.
    """
    name = getattr(entry, "name", "")
    return {
        "name": name,
        "description": getattr(entry, "description", "") or "",
        "installed": name in servers,
        "needs_config": _needs_config(entry),
    }


def _needs_config(entry: Any) -> bool:
    """Whether adding an entry leaves anything to fill in, so a tap on the list can decide.

    Only the values its manifest declares count. OAuth is not one of them: an OAuth entry is added
    with its marker and reads ``needs_access``, and the tap that adds it has nothing to ask — so the
    screen adds it at once and offers Server access on its row afterwards (ADR 0014).
    """
    return bool(_env_specs(entry))


def entry(profile: Optional[str], name: str) -> Dict[str, Any]:
    """One Catalogue entry as ``profile`` is offered it, with the values it declares.

    The form that adds an entry is built from this: one field per value the entry's manifest declares
    (``auth.env``), each with whether it is required, whether it is secret and the default the
    manifest pins — and whether this bot already holds a value for it, which is the **only** thing
    the app is ever told about a value the bot has. A stored secret is never answered back, and an
    entry's own description is Hermes's. ``installed`` says whether the bot already has the server,
    as the Catalogue's own read does, so the app can mark it.

    ``profile`` is a profile name, or None for the process's own. Blocking — the profile's config and
    its ``.env`` are read, and the scope may hydrate an external secret source — so call it from a
    worker thread, never the event loop. This writes nothing: the block the entry would be added as
    is built only by ``install``, so reading an entry cannot change the bot. An entry the Catalogue
    doesn't have, or a host without the adding built-ins, raises ``McpError`` (400, or 501).
    """
    hermes = _hermes_install()
    with hermes["read_scope"](profile):
        found = _entry(hermes, name)
        return _entry_detail(found, name in hermes["installed"](), hermes["get_env"])


def install(profile: Optional[str], name: str, values: Dict[str, str]) -> List[Dict[str, Any]]:
    """Add one of the Catalogue's entries to ``profile``, and answer the servers it has afterwards.

    ``values`` is what the form collected, by the name each value declares. A key the entry does not
    declare, or a name Hermes's own environment writer refuses, is a 400 for the whole add rather
    than a partial write; a value the entry declares required that is neither given nor already held
    by the bot is the same 400. Hermes's own ``card_install_config`` then builds the
    ``mcp_servers.<name>`` block from the manifest — the same block its connection card installs,
    minus the prompts, the probe and the tool checklist a terminal owns — each collected value the
    manifest declares non-secret is inlined into it, and Hermes's own ``_save_mcp_server`` writes it.
    A configuration that write refuses is a 400 carrying Hermes's own sentence, and since the secrets
    are written only after the block lands, a refusal leaves nothing half-added; an entry whose own
    repository Hermes clones while building the block is the same 400 — with Hermes's own sentence —
    when that clone or its bootstrap fails. Hermes's own reconcile follows, so the server is live for
    the bot's next turn, and the answer is the profile's
    servers as ``read`` shapes them, so the app's list is the Host's own answer rather than the entry
    it guessed was added.

    A value already held by the bot is reused rather than asked for again: the manifest's ``${NAME}``
    reference stays in the block and the profile's ``.env`` keeps the value (which is why a removal
    leaves those values alone). An entry whose auth is OAuth is added with its marker and reads
    ``needs_access`` until the row's own flow grants the access; nothing here starts one.

    ``profile`` is a profile name, or None for the process's own. Blocking — the manifest's own
    bootstrap may clone a repository, the config is read and written, the environment is written and
    the reconcile takes a per-home lock — so call it from a worker thread, never the event loop.
    """
    hermes = _hermes_install()
    with hermes["write_scope"](profile):
        found = _entry(hermes, name)
        declared = _declared(found)
        collected = _collected(name, declared, values, hermes)
        try:
            block = hermes["card"](found)
        except hermes["catalog_error"] as error:
            # Building the block is where the entry's own repository is cloned and its bootstrap run
            # (`card_install_config` → `_do_git_install`), and Hermes answers a clone that fails with
            # its own sentence rather than a config it refuses: neither is a 500, and neither has
            # written anything yet.
            raise McpError(str(error), 400) from error
        secrets = {value["name"] for value in declared if value["secret"]}
        # Split first, then write in the order the half-added guarantee needs: the block carries the
        # plain values before it is saved, and the secrets reach the profile's environment only once
        # that save has landed.
        plain = {key: value for key, value in collected.items() if key not in secrets}
        secret = {key: value for key, value in collected.items() if key in secrets}
        for key, value in plain.items():
            block = hermes["inline"](block, key, value)
        return _land(hermes, name, block, secret)["servers"]


def _entry(hermes: Dict[str, Any], name: str) -> Any:
    """One of Hermes's own Catalogue entries by name, or a 400 for one it doesn't have."""
    found = hermes["entry"](name)
    if found is None:
        raise McpError(f"Hermes's Catalogue has no entry named {name!r}.", 400)
    return found


def _entry_detail(found: Any, installed: bool, get_env: Callable[[str], Any]) -> Dict[str, Any]:
    """One entry in the app's own shape, with the values it declares and whether each is set."""
    return {
        "name": getattr(found, "name", ""),
        "description": getattr(found, "description", "") or "",
        "installed": installed,
        "values": [_declared_value(spec, get_env) for spec in _env_specs(found)],
    }


def _value_shape(spec: Any) -> Dict[str, Any]:
    """What both the form and an add's own checks read of one declared value: the Hermes defaults."""
    return {
        "name": getattr(spec, "name", ""),
        "required": getattr(spec, "required", True) is not False,
        "secret": getattr(spec, "secret", True) is not False,
    }


def _declared_value(spec: Any, get_env: Callable[[str], Any]) -> Dict[str, Any]:
    """One value an entry declares, as the form is built from it.

    ``set`` is whether this bot already holds a value for it, read through Hermes's own environment
    read — and it is all the app is told: the value itself never leaves the Host. A secret's default
    is never answered (Hermes's own form leaves one out, and the field is masked, so a default in it
    would be a credential on screen); a plain value's default is what makes the common case one tap.
    """
    shape = _value_shape(spec)
    return {
        **shape,
        "prompt": getattr(spec, "prompt", "") or "",
        "default": "" if shape["secret"] else (getattr(spec, "default", "") or ""),
        "set": bool(get_env(shape["name"])),
    }


def _declared(found: Any) -> List[Dict[str, Any]]:
    """What one entry declares, in the app's own shape: what an add checks its values against."""
    return [_value_shape(spec) for spec in _env_specs(found)]


def _env_specs(found: Any) -> List[Any]:
    """The values one of Hermes's ``CatalogEntry`` objects declares (``auth.env``), if any."""
    auth = getattr(found, "auth", None)
    declared = getattr(auth, "env", None) or []
    return list(declared)


def _collected(
    name: str, declared: List[Dict[str, Any]], values: Dict[str, str], hermes: Dict[str, Any]
) -> Dict[str, str]:
    """The values an add will write, or the 400 that refuses it before anything is built.

    Configuring one MCP is not a general environment-writing primitive, so a key the entry doesn't
    declare is refused like a name Hermes's own writer would refuse one — before the block is built,
    before the profile's environment is touched and before anything is cloned or written. A value the
    entry declares required that is neither given nor already held by the bot is the same refusal,
    which is the Host's own backstop for the form's own check — a value of nothing but spaces is
    nothing given, as the form's own rule has it, and a value that is given is written as it was
    given. "Already held" is asked of Hermes's environment read for every declared value, secrets and
    plain ones alike: a plain value lives inlined in the configuration rather than in `.env`, so it is
    only ever found there when the name also stands for something ambient in the profile, and then
    leaving the manifest's ``${NAME}`` reference standing is exactly what Hermes's own load-time
    resolution wants.
    """
    names = {value["name"] for value in declared}
    for key in values:
        if key not in names:
            raise McpError(f"{name} does not declare the value {key}.", 400)
    # The save's own check — a value of spaces is nothing given, a name Hermes's writer refuses is a
    # 400 — so an add and a save can't disagree about what counts as a value.
    typed = _typed(hermes, values)
    collected: Dict[str, str] = dict(typed)
    for value in declared:
        if value["name"] not in typed and value["required"] and not hermes["get_env"](value["name"]):
            raise McpError(f"{value['name']} is required but no value was provided.", 400)
    return collected


def _refusal(hermes: Dict[str, Any], name: str, block: Dict[str, Any]) -> str:
    """Why Hermes's own validator refused a block, in its own words where it has any."""
    issues = [issue for issue in hermes["validate"](name, block) if isinstance(issue, str)]
    return " ".join(issues) if issues else f"Hermes refused {name}'s configuration."


def _writable_server(
    hermes: Dict[str, Any], name: str
) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """Refuse a server the profile doesn't have, or one a Hermes plugin provides.

    Hermes will not modify a server a plugin provides, so neither a switch nor a removal can land on
    one; both writes ask this the same way, and answer the same 400 for each.
    """
    servers, owners = _blocks(hermes)
    _server_block(servers, name)
    if owners.get(name):
        raise McpError(f"{name} is provided by a Hermes plugin, so it can't be changed.", 400)
    # What it read is what a write then works from: the same two calls, not two more.
    return servers, owners


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
    servers, owners = _blocks(hermes)
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
    """One server in the app's own shape: Gots' state word, whether it is on, where it comes from.

    A connected or lazily registered server also carries ``tools``: Hermes's cached read answers the
    count it holds for those, and ``0`` for one it has no runtime state for — which is not a count, so
    it is left out rather than reported as nothing to offer (``app/src/lib/mcp-server.ts``).
    """
    cfg = cfg if isinstance(cfg, dict) else {}
    status = status if isinstance(status, dict) else {}
    state = _state(name, cfg, owner, status, tokens_present)
    connected = _connected(status)
    row = {
        "name": name,
        "state": state,
        "enabled": _enabled(cfg),
        "source": "plugin" if owner else "config",
        "reason": _reason(state, status),
        "access": _grantable(cfg, owner, state),
    }
    count = status.get("tools")
    if isinstance(count, int) and not isinstance(count, bool):
        if connected or status.get("status") == "lazy":
            row["tools"] = count
    return row


def _grantable(cfg: Dict[str, Any], owner: Optional[str], state: str) -> bool:
    """Whether the row offers Grant access: an OAuth server of this profile, waiting or failing.

    A server with no stored access reads ``needs_access``; one whose stored access was revoked or
    expired reads ``failed``, and a fresh flow is the only way back short of removing and re-adding
    it. A server a Hermes plugin provides, a stdio server and an off one are never offered it.
    """
    if owner or cfg.get("auth") != "oauth" or not cfg.get("url"):
        return False
    return state in ("needs_access", "failed")


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
