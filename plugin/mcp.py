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

from typing import Any, Callable, Dict, List, Optional, Tuple

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


def _hermes_catalogue() -> Dict[str, Any]:
    """Hermes's own Catalogue, imported at call time: a plugin loads before the CLI does.

    The entries Hermes offers (``list_catalog``) and its own read of the profile's servers
    (``installed_servers``), a config read and so inside the profile's read scope. Nothing here
    writes, installs or probes anything, so a missing one is a 501 rather than a failure: the app
    then offers no Add action on that Host.
    """
    try:
        from hermes_cli.mcp_catalog import installed_servers, list_catalog
        from hermes_cli.web_server_profiles import _config_profile_scope
    except ImportError as error:
        raise McpError(UNAVAILABLE, 501) from error
    return {
        "scope": _config_profile_scope,
        "list": list_catalog,
        "installed": installed_servers,
    }


def _hermes_install() -> Dict[str, Any]:
    """Everything adding a Catalogue entry needs, imported at call time.

    The write's own set (``_hermes_write``: the config read and write, Hermes's config write scope
    and the reconcile) plus the adding half of the Catalogue: its entry read (``get_entry``), the
    block Hermes builds for one from its manifest (``card_install_config``, never ``install_entry``,
    which owns a terminal's prompts, probe and curses checklist), the inlining that turns a
    non-secret value the user gave into the value the manifest's ``${NAME}`` refs stand for
    (``_inline_non_secret_value``), the write that refuses a suspicious configuration
    (``_save_mcp_server``) and the validator behind that refusal
    (``hermes_cli.mcp_security.validate_mcp_server_entry``, the one whose own sentence the app
    shows), the profile's environment read and write for the values an entry declares secret
    (``get_env_value``/``save_env_value``) and Hermes's own guard on what may be persisted through
    that writer (``validate_env_var_name_for_write``).

    Missing any of them is a 501, and ``addable`` is that same check for the ``info`` payload's gate
    — its own set, because a host can list a bot's servers, switch one and browse the Catalogue
    without being able to add one from it. The two scopes are named apart: an entry read and the
    mark of whether the bot has it run inside the profile's own read scope, and the add itself,
    everything it writes and its reconcile inside Hermes's config write scope.
    """
    hermes = _hermes_write()
    catalogue = _hermes_catalogue()
    try:
        from hermes_cli.config import (
            get_env_value,
            save_env_value,
            validate_env_var_name_for_write,
        )
        from hermes_cli.mcp_catalog import (
            CatalogError,
            _inline_non_secret_value,
            card_install_config,
            get_entry,
        )
        from hermes_cli.mcp_config import _save_mcp_server
        from hermes_cli.mcp_security import validate_mcp_server_entry
    except ImportError as error:
        raise McpError(UNAVAILABLE, 501) from error
    return {
        # The read-side helpers the answer after an add is shaped with (see ``_all_rows``).
        "servers": hermes["servers"],
        "sources": hermes["sources"],
        "status": hermes["status"],
        "tokens_present": hermes["tokens_present"],
        "reconcile": hermes["reconcile"],
        "read_scope": catalogue["scope"],
        "write_scope": hermes["scope"],
        "installed": catalogue["installed"],
        "entry": get_entry,
        "card": card_install_config,
        "catalog_error": CatalogError,
        "inline": _inline_non_secret_value,
        "save_server": _save_mcp_server,
        "validate": validate_mcp_server_entry,
        "get_env": get_env_value,
        "save_env": save_env_value,
        "check_name": validate_env_var_name_for_write,
    }


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


def browsable() -> Optional[str]:
    """Why this host's Catalogue can't be browsed from here, or None when it can.

    Browsing needs Hermes's catalogue module and the profile's read scope, which is a different set
    from the read's: a host can list a bot's servers without offering the Catalogue at all. ``info``
    advertises this as its own feature, so that host's Bot gets no Add action rather than one whose
    every tap is a 501.
    """
    try:
        _hermes_catalogue()
    except McpError as error:
        return str(error)
    return None


def addable() -> Optional[str]:
    """Why this host can't add a Catalogue entry to a bot from here, or None when it can.

    Adding one needs Hermes's catalogue (its entry read and the block it builds) and the writes that
    land it — the config write, the validator behind it, the environment writer and its name guard,
    and the reconcile. That is its own set again: a host can list a bot's servers, switch one and
    browse the Catalogue with the catalogue's own built-ins alone. ``info`` advertises this as its
    own feature, so that host's Bot gets no Add action rather than one whose every tap is a 501.
    """
    try:
        _hermes_install()
    except McpError as error:
        return str(error)
    return None


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
    with hermes["scope"](profile):
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
    }


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
        for key, value in collected.items():
            if key not in secrets:
                block = hermes["inline"](block, key, value)
        if not hermes["save_server"](name, block):
            raise McpError(_refusal(hermes, name, block))
        for key, value in collected.items():
            if key in secrets:
                hermes["save_env"](key, value)
        hermes["reconcile"]()
        return _all_rows(hermes)


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


def _declared_value(spec: Any, get_env: Callable[[str], Any]) -> Dict[str, Any]:
    """One value an entry declares, as the form is built from it.

    ``set`` is whether this bot already holds a value for it, read through Hermes's own environment
    read — and it is all the app is told: the value itself never leaves the Host. A secret's default
    is never answered (Hermes's own form leaves one out, and the field is masked, so a default in it
    would be a credential on screen); a plain value's default is what makes the common case one tap.
    """
    secret = getattr(spec, "secret", True) is not False
    return {
        "name": getattr(spec, "name", ""),
        "prompt": getattr(spec, "prompt", "") or "",
        "required": getattr(spec, "required", True) is not False,
        "secret": secret,
        "default": "" if secret else (getattr(spec, "default", "") or ""),
        "set": bool(get_env(getattr(spec, "name", ""))),
    }


def _declared(found: Any) -> List[Dict[str, Any]]:
    """What one entry declares, in the app's own shape: what an add checks its values against."""
    return [
        {
            "name": getattr(spec, "name", ""),
            "required": getattr(spec, "required", True) is not False,
            "secret": getattr(spec, "secret", True) is not False,
        }
        for spec in _env_specs(found)
    ]


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
    declare, and so is a name Hermes's own writer would refuse — before
    the block is built, before the profile's environment is touched and before anything is cloned or
    written. A value the entry declares required that is neither given nor already held by the bot is
    the same refusal, which is the Host's own backstop for the form's own check. "Already held" is
    asked of Hermes's environment read for every declared value, secrets and plain ones alike: a plain
    value lives inlined in the configuration rather than in `.env`, so it is only ever found there when
    the name also stands for something ambient in the profile, and then leaving the manifest's
    ``${NAME}`` reference standing is exactly what Hermes's own load-time resolution wants.
    """
    names = {value["name"] for value in declared}
    for key in values:
        if key not in names:
            raise McpError(f"{name} does not declare the value {key}.", 400)
    for key in values:
        try:
            hermes["check_name"](key)
        except ValueError as error:
            raise McpError(str(error), 400) from error
    collected: Dict[str, str] = {}
    for value in declared:
        given = values.get(value["name"])
        if isinstance(given, str) and given:
            collected[value["name"]] = given
        elif value["required"] and not hermes["get_env"](value["name"]):
            raise McpError(f"{value['name']} is required but no value was provided.", 400)
    return collected


def _refusal(hermes: Dict[str, Any], name: str, block: Dict[str, Any]) -> str:
    """Why Hermes's own validator refused a block, in its own words where it has any."""
    issues = [issue for issue in hermes["validate"](name, block) if isinstance(issue, str)]
    return " ".join(issues) if issues else f"Hermes refused {name}'s configuration."


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
