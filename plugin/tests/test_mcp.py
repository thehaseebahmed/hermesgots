"""Tests for the read, the toggle, the removal, the Catalogue and adding from it, of a bot's MCP
servers (``plugin/mcp.py``).

Hermes's own MCP built-ins — the profile scope, the config reader, the split between a profile's
servers and a Hermes plugin's, the cached runtime status read, the stored-access check, the
catalogue's own uninstall, its list and one entry, the card block and the inlining a catalogue entry
is built and added through, the config validator, the environment writer and its name guard, the
OAuth manager — are stood in for through ``sys.modules`` (the ``test_skills.py`` pattern), so each
test asserts only this module's own rules: the state word each of Hermes's states becomes, the Host's
own reason on a failure, the profile scope the read or the write ran in, what a removal takes with
it, which Catalogue entries the profile already has and what one declares, that an add writes the
block and the secrets it declares and nothing when it is refused, and that a host without the
built-ins advertises nothing.

Run: python3 -m unittest plugin.tests.test_mcp -v
"""

from __future__ import annotations

import contextlib
import inspect
import re
import sys
import types
import unittest
from unittest import mock

from plugin import mcp


class CatalogError(Exception):
    """Hermes's own exception for an entry it can't install (a clone that failed, git absent)."""


def hermes(
    servers=None,
    runtime=None,
    errors=None,
    plugin_servers=None,
    owners=None,
    tokens=None,
    env=None,
    reconcile=None,
    saved=None,
    uninstalled=None,
    forgotten=None,
    env_writes=None,
    catalogue=None,
    reads=None,
    refusals=None,
    cards=None,
    card_errors=None,
    inlines=None,
    checks=None,
    validates=None,
    discovers=None,
):
    """Hermes's MCP built-ins for one test, faked the way the module imports them.

    ``servers`` is the profile's ``mcp_servers`` block as ``_get_mcp_servers`` answers it.
    ``runtime`` is name -> the status word ``get_mcp_status`` reports (``connected``, ``lazy``,
    ``configured``, ``connecting``, ``failed``, ``disabled``); a name it doesn't carry is reported
    ``configured``, which is how Hermes reports a server it has no runtime state for. ``errors`` is
    the Host's own text for a failed one. ``plugin_servers``/``owners`` are what a Hermes plugin
    provides through its own ``mcp.json``; ``tokens`` names the servers with stored Server access.

    ``reconcile`` is a list the write's reconcile appends the profile it ran inside to; when it is
    None, reconcile refuses — so a read that reached for it fails the test instead of quietly
    reconciling. ``saved`` is a list the config write appends ``(profile, config)`` to, so a test can
    assert both the saved flag and the scope the write ran in. The config load and save round-trip
    through one ``store``, as Hermes's own do: a write lands in the store, so a read after it sees
    the change.

    ``uninstalled`` is a list the removal's uninstall appends ``(profile, name, purge_install_dir)``
    to, and ``forgotten`` one the OAuth manager appends ``(profile, name)`` to; each refuses when it
    is None, so a read or a toggle that reached for a removal fails the test. The uninstall takes the
    entry out of the ``store`` and the manager takes the name out of the stored-access set, as
    Hermes's own do.

    ``env`` is the profile's ``.env`` — the values a server's configuration needs — and
    ``env_writes`` a list Hermes's environment writer appends ``(profile, key)`` to. A removal must
    leave both alone, since Hermes reuses a value when the same server is added again; the fake keeps
    the values, so a removal that wrote one shows up in the assertions rather than passing quietly.

    ``catalogue`` is what Hermes's own ``list_catalog`` offers, shaped into the entry objects its own
    ``CatalogEntry`` dataclass is: ``{name, description, transport, auth}`` dicts, an entry with
    neither a transport nor an auth being an http entry declaring nothing. A ``transport`` carries
    the command, args, url and env its manifest pins — ``${NAME}`` refs and all — and an ``auth``
    carries its ``type`` and the values it declares as ``env`` (``{name, prompt, required, secret,
    default}``), which the fake shapes into ``EnvVarSpec`` objects. ``installed_servers`` reads the
    same ``store`` the profile's config does, as Hermes's own does, and ``get_entry`` answers one
    entry by name or None. ``reads`` is a list it appends to on every call, so a test can assert the
    whole Catalogue costs one read rather than one per entry.

    The adding half is Hermes's own too: ``card_install_config`` copies an entry's transport into the
    ``mcp_servers.<name>`` block the way Hermes's own does (minus everything a terminal owns) and
    appends the entry's name to ``cards`` — raising ``CatalogError``, as Hermes's own does, for an
    entry named in ``card_errors``, which is where a clone of the entry's own repository fails;
    ``_inline_non_secret_value`` replaces a ``${NAME}`` ref
    throughout that block and appends ``(name, value)`` to ``inlines``; ``_save_mcp_server``
    validates the block — through ``validate_mcp_server_entry``, which answers the issues in
    ``refusals`` for that name — and writes it into the ``store`` and ``saved``, refusing when it
    found any; ``validate_env_var_name_for_write`` appends the name it was asked about to ``checks``
    and refuses a name that isn't a plain environment variable name (``PATH``, ``LD_PRELOAD``, a
    lowercase name). ``get_env_value``/``save_env_value`` are the profile's ``.env``: the value a
    write lands is what a later read of the same name answers, which is what makes an already-set
    value testable.

    The scopes the read enters land on ``hermes_cli.web_server_profiles``'s ``scopes``, and the
    scopes the write enters on ``hermes_cli.web_routers._common``'s ``write_scopes`` — Hermes's own
    config write scope — so a test can assert which profile's each ran in. ``discover_mcp_tools``
    refuses: a read or a write that reached for one to start or stop a server fails the test instead
    of connecting something.
    """

    scopes = []
    write_scopes = []
    saved = saved if saved is not None else []

    @contextlib.contextmanager
    def _config_profile_scope(profile):
        scopes.append(profile)
        yield

    @contextlib.contextmanager
    def _write_profile_scope(profile):
        """Hermes's own config write scope: the read scope under the config lock.

        It is recorded separately from the read's, so a write that entered the read's scope instead
        of Hermes's own fails the tests rather than passing on the scope's argument alone.
        """
        write_scopes.append(profile)
        yield

    # Hermes's own config read and write: the block round-trips through one store, so the flag a
    # write sets is what the next read reports. A server's entry is whatever the YAML holds — a bare
    # `name:` with nothing under it reads back as None, which the module has to survive.
    def entry(cfg):
        return dict(cfg) if isinstance(cfg, dict) else cfg

    store = {name: entry(cfg) for name, cfg in (servers or {}).items()}
    runtime = dict(runtime or {})
    errors = dict(errors or {})
    access = set(tokens or ())
    env = env if env is not None else {}
    env_writes = env_writes if env_writes is not None else []

    def _get_mcp_servers():
        return {name: entry(cfg) for name, cfg in store.items()}

    def load_config():
        return {"mcp_servers": {name: entry(cfg) for name, cfg in store.items()}}

    def save_config(config):
        saved.append((write_scopes[-1] if write_scopes else None, config))
        block = config.get("mcp_servers", {})
        store.clear()
        store.update({name: entry(cfg) for name, cfg in block.items()})

    def reconcile_mcp_servers_with_config():
        if reconcile is None:
            raise AssertionError("the read must not reconcile servers")
        reconcile.append(write_scopes[-1] if write_scopes else None)
        return {"registered": [], "unregistered": []}

    def server_configs_with_sources(config_servers):
        """Hermes's split: the profile's own servers, plus the ones a plugin provides."""
        found = {name: entry(cfg) for name, cfg in config_servers.items()}
        found_owners = {name: None for name in found}
        for name, cfg in (plugin_servers or {}).items():
            if name not in found:
                found[name] = entry(cfg)
                found_owners[name] = (owners or {}).get(name)
        return found, found_owners

    def get_mcp_status(configured=None, *, include_runtime=True):
        """Hermes's cached-state read: a row per configured server, never a connection.

        The state word is Hermes's own: a config that switches the server off reports ``disabled``,
        and anything else it has no runtime state for reports ``configured`` — Hermes's own reader
        defaults an absent, null or unparseable ``enabled`` key to on.
        """
        found = _get_mcp_servers() if configured is None else configured
        rows = []
        for name, cfg in found.items():
            cfg = cfg if isinstance(cfg, dict) else {}
            enabled = cfg.get("enabled", True) is not False
            word = runtime.get(name, "configured" if enabled else "disabled")
            row = {
                "name": name,
                "transport": "http" if "url" in cfg else "stdio",
                "tools": 0,
                "connected": word == "connected",
                "disabled": word == "disabled",
                "status": word,
            }
            if word == "failed":
                row["error"] = errors.get(name, "")
            rows.append(row)
        return rows

    def _oauth_tokens_present(name):
        return name in access

    def uninstall_entry(name, *, purge_install_dir=True):
        """Hermes's own uninstall: the config entry (through its own write) and its clone dir."""
        if uninstalled is None:
            raise AssertionError("the read must not remove a server")
        uninstalled.append((write_scopes[-1] if write_scopes else None, name, purge_install_dir))
        if name not in store:
            return False
        save_config({"mcp_servers": {other: entry(cfg) for other, cfg in store.items() if other != name}})
        return True

    class _OAuthManager:
        """Hermes's own process-wide OAuth manager: the stored access, and the cached provider."""

        def remove(self, name, *, hermes_home=None):
            if forgotten is None:
                raise AssertionError("the read must not drop a server's stored access")
            forgotten.append((write_scopes[-1] if write_scopes else None, name))
            access.discard(name)

    def get_manager():
        return _OAuthManager()

    def _refuse(what):
        def refuse(*_args, **_kwargs):
            raise AssertionError(f"the read must not {what}")

        return refuse

    def discover_mcp_tools(*args, **_kwargs):
        """Starting or stopping a server, for real: recorded when a test asks, always refused.

        A read or a write that reaches for this fails the test rather than connecting something; a
        test that passes ``discovers`` also asserts the call was never made, rather than leaning on
        the refusal alone.
        """
        if discovers is not None:
            discovers.append(args)
        raise AssertionError("the read must not connect a server")

    # Hermes's own environment writer (the profile's `.env`), which a removal must not reach for: the
    # values stay so adding the server again doesn't mean finding its key a second time. An adding
    # write reaches for it, and only for a value the entry declares secret.
    def get_env_value(key):
        return env.get(key)

    def save_env_value(key, value):
        validate_env_var_name_for_write(key)
        env_writes.append((write_scopes[-1] if write_scopes else None, key))
        env[key] = value

    # Hermes's own guard on what may be persisted through that writer: a name that isn't a plain
    # environment variable name, or one that steers a subprocess or Hermes itself, is refused.
    def validate_env_var_name_for_write(key):
        if checks is not None:
            checks.append(key)
        if not re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", key) or key.upper() in (
            "PATH",
            "LD_PRELOAD",
            "PYTHONPATH",
            "HERMES_HOME",
        ):
            raise ValueError(f"Invalid environment variable name: {key!r}")

    config = types.ModuleType("hermes_cli.mcp_config")
    config._get_mcp_servers = _get_mcp_servers
    config._oauth_tokens_present = _oauth_tokens_present

    # The write's own modules: Hermes's config read/write and its config write scope, which is the
    # read's scope under Hermes's config lock. Its recorder is the write's own (see above).
    config_module = types.ModuleType("hermes_cli.config")
    config_module.load_config = load_config
    config_module.save_config = save_config
    config_module.get_env_value = get_env_value
    config_module.save_env_value = save_env_value
    config_module.validate_env_var_name_for_write = validate_env_var_name_for_write

    routers = types.ModuleType("hermes_cli.web_routers")
    router_common = types.ModuleType("hermes_cli.web_routers._common")
    router_common.config_write_scope = _write_profile_scope
    router_common.write_scopes = write_scopes
    routers._common = router_common

    profiles = types.ModuleType("hermes_cli.web_server_profiles")
    profiles._config_profile_scope = _config_profile_scope
    profiles.scopes = scopes

    catalog = types.ModuleType("hermes_cli.mcp_catalog")
    catalog.uninstall_entry = uninstall_entry

    def entry_object(raw):
        """One of Hermes's ``CatalogEntry`` objects, from the dict a test wrote.

        A manifest the test says nothing about is an http entry declaring nothing: its transport is
        the name's own URL and its auth brings no values, which is what most Catalogue entries are.
        """
        raw = dict(raw)
        transport = dict(raw.get("transport") or {"type": "http", "url": f"https://{raw['name']}.example/mcp"})
        auth = dict(raw.get("auth") or {})
        specs = [
            types.SimpleNamespace(
                name=spec["name"],
                prompt=spec.get("prompt", ""),
                required=spec.get("required", True),
                secret=spec.get("secret", True),
                default=spec.get("default", ""),
            )
            for spec in (auth.get("env") or [])
        ]
        return types.SimpleNamespace(
            name=raw["name"],
            description=raw.get("description", ""),
            transport=types.SimpleNamespace(
                type=transport.get("type", "http"),
                command=transport.get("command"),
                args=list(transport.get("args") or []),
                url=transport.get("url"),
                env=dict(transport.get("env") or {}),
            ),
            auth=types.SimpleNamespace(
                type=auth.get("type", "none"), env=specs, provider=auth.get("provider"), oauth={}
            ),
        )

    def list_catalog():
        """Hermes's own Catalogue: its entry objects, which carry a name and a description."""
        return [entry_object(entry) for entry in (catalogue or [])]

    def get_entry(name):
        """Hermes's own read of one entry by name, or None when the Catalogue has no such entry."""
        return next((entry for entry in list_catalog() if entry.name == name), None)

    def installed_servers():
        """Hermes's own read of the profile's config: the servers it has an entry for."""
        if reads is not None:
            reads.append(scopes[-1] if scopes else None)
        return dict(store)

    def card_install_config(entry):
        """Hermes's own card block: the manifest's transport, enabled, and nothing a terminal owns.

        ``card_errors`` is the failure a test says this entry's own install hits — Hermes clones the
        entry's repository while building the block and answers a clone that fails with its own
        exception — raised here in the same place and shape.
        """
        if cards is not None:
            cards.append(entry.name)
        if card_errors and entry.name in card_errors:
            raise CatalogError(card_errors[entry.name])
        transport = entry.transport
        if transport.type == "http":
            cfg = {"url": transport.url}
        else:
            cfg = {"command": transport.command}
            if transport.args:
                cfg["args"] = list(transport.args)
            if transport.env:
                cfg["env"] = dict(transport.env)
        if entry.auth.type == "oauth":
            cfg["auth"] = "oauth"
        cfg["enabled"] = True
        return cfg

    def inline_into(obj, name, value):
        if isinstance(obj, str):
            return obj.replace("${" + name + "}", value)
        if isinstance(obj, dict):
            return {key: inline_into(item, name, value) for key, item in obj.items()}
        if isinstance(obj, list):
            return [inline_into(item, name, value) for item in obj]
        return obj

    def _inline_non_secret_value(obj, name, value):
        """Hermes's own inlining of one collected non-secret value through a block."""
        if inlines is not None:
            inlines.append((name, value))
        return inline_into(obj, name, value)

    def _save_mcp_server(name, server_config):
        """Hermes's own config write, refused when its own validator finds anything."""
        if validates is not None:
            validates.append((name, server_config))
        if validate_mcp_server_entry(name, server_config):
            return False
        block = {other: entry(cfg) for other, cfg in store.items()}
        block[name] = entry(server_config)
        save_config({"mcp_servers": block})
        return True

    def validate_mcp_server_entry(name, server_config):
        """Hermes's own read of what is wrong with a block: the issues a test pinned for that name."""
        return list((refusals or {}).get(name, ()))

    catalog.list_catalog = list_catalog
    catalog.installed_servers = installed_servers
    catalog.get_entry = get_entry
    catalog.card_install_config = card_install_config
    catalog._inline_non_secret_value = _inline_non_secret_value
    catalog.CatalogError = CatalogError

    # The config write an adding write lands through, and the validator behind it, in the modules
    # Hermes keeps them in.
    config._save_mcp_server = _save_mcp_server

    security = types.ModuleType("hermes_cli.mcp_security")
    security.validate_mcp_server_entry = validate_mcp_server_entry

    oauth = types.ModuleType("tools.mcp_oauth_manager")
    oauth.get_manager = get_manager

    discovery = types.ModuleType("tools.mcp_tool_discovery")
    discovery.get_mcp_status = get_mcp_status
    discovery.discover_mcp_tools = discover_mcp_tools
    discovery.reconcile_mcp_servers_with_config = reconcile_mcp_servers_with_config

    helpers = types.ModuleType("tui_gateway.mcp_rpc_helpers")
    helpers.server_configs_with_sources = server_configs_with_sources

    return {
        "hermes_cli.config": config_module,
        "hermes_cli.mcp_catalog": catalog,
        "hermes_cli.mcp_config": config,
        "hermes_cli.mcp_security": security,
        "hermes_cli.web_routers": routers,
        "hermes_cli.web_routers._common": router_common,
        "hermes_cli.web_server_profiles": profiles,
        "tools.mcp_oauth_manager": oauth,
        "tools.mcp_tool_discovery": discovery,
        "tui_gateway.mcp_rpc_helpers": helpers,
    }


def rows(found):
    """``[(name, state), ...]``, the pair the state words are asserted through."""
    return [(server["name"], server["state"]) for server in found]


# A Catalogue entry that declares two values, one of them a secret, with its manifest's own
# ``${NAME}`` refs in the transport Hermes's card copies: the shape the adding half is driven
# through, from the form's fields to the block that lands in the profile's config.
POSTGRES = {
    "name": "postgres",
    "description": "Query a Postgres database.",
    "transport": {
        "type": "stdio",
        "command": "srv",
        "args": ["--db", "${PG_DATABASE}"],
        "env": {"DATABASE_URL": "postgres://user:${PG_PASSWORD}@db.example/gots"},
    },
    "auth": {
        "type": "none",
        "env": [
            {"name": "PG_DATABASE", "prompt": "Database", "required": True, "secret": False, "default": "postgres"},
            {"name": "PG_PASSWORD", "prompt": "Password", "required": True, "secret": True},
        ],
    },
}

# A manifest that says more about its values than most do: one left optional, one secret with a default
# pinned (which Hermes's own prompt pre-fills, and which a masked field must never answer) and one
# required plain value the form has to be given.
SENTRY = {
    "name": "sentry",
    "description": "Triage Sentry issues.",
    "auth": {
        "type": "api_key",
        "env": [
            {
                "name": "SENTRY_AUTH_TOKEN",
                "prompt": "Token",
                "required": True,
                "secret": True,
                "default": "a-pinned-secret",
            },
            {
                "name": "SENTRY_REGION",
                "prompt": "Region",
                "required": False,
                "secret": False,
                "default": "eu-west-1",
            },
            {"name": "SENTRY_ORG", "prompt": "Organisation", "required": True, "secret": False},
        ],
    },
}


class McpReadTests(unittest.TestCase):
    def test_every_server_is_listed_sorted_with_its_state(self):
        with mock.patch.dict(
            sys.modules,
            hermes(
                servers={
                    "zeta": {"command": "npx", "args": ["-y", "srv"]},
                    "alpha": {"url": "https://alpha.example/mcp"},
                    "mid": {"command": "srv", "enabled": False},
                },
                runtime={"zeta": "lazy", "alpha": "connected"},
            ),
        ):
            found = mcp.read("bot-a")
        self.assertEqual(
            [
                {"name": "alpha", "state": "on", "enabled": True, "source": "config", "reason": None},
                {"name": "mid", "state": "off", "enabled": False, "source": "config", "reason": None},
                {"name": "zeta", "state": "on", "enabled": True, "source": "config", "reason": None},
            ],
            found,
        )

    def test_a_server_that_never_says_whether_it_is_enabled_reads_as_on(self):
        """Hermes reports such a server ``configured``; it is a server this bot has."""
        with mock.patch.dict(sys.modules, hermes(servers={"quiet": {"command": "srv"}})):
            found = mcp.read("bot-a")
        self.assertEqual([("quiet", "on")], rows(found))

    def test_a_server_the_config_switches_off_reads_as_off(self):
        with mock.patch.dict(sys.modules, hermes(servers={"off": {"command": "srv", "enabled": False}})):
            found = mcp.read("bot-a")
        self.assertEqual([("off", "off")], rows(found))

    def test_the_servers_own_flag_is_reported_beside_its_state_word(self):
        """The word is Hermes's cached runtime and can lag the flag, so the row carries the flag too.

        A server whose config is switched off while its cached state still reads ``connecting`` is
        the case: the app drives the switch from ``enabled``, so it agrees with what a toggle wrote.
        """
        with mock.patch.dict(
            sys.modules,
            hermes(
                servers={"srv": {"command": "srv", "enabled": False}},
                runtime={"srv": "connecting"},
            ),
        ):
            found = mcp.read("bot-a")
        self.assertEqual([("srv", "connecting")], rows(found))
        self.assertIs(False, found[0]["enabled"])

    def test_a_server_hermes_reports_nothing_for_reads_as_on(self):
        """A status read that says nothing about a configured server is not an off server."""
        stubs = hermes(servers={"quiet": {"command": "srv"}})
        stubs["tools.mcp_tool_discovery"].get_mcp_status = lambda configured=None, **kwargs: []
        with mock.patch.dict(sys.modules, stubs):
            found = mcp.read("bot-a")
        self.assertEqual([("quiet", "on")], rows(found))

    def test_a_connecting_server_reads_as_connecting(self):
        with mock.patch.dict(
            sys.modules, hermes(servers={"slow": {"command": "srv"}}, runtime={"slow": "connecting"})
        ):
            found = mcp.read("bot-a")
        self.assertEqual([("slow", "connecting")], rows(found))

    def test_a_failed_server_carries_the_hosts_own_reason(self):
        with mock.patch.dict(
            sys.modules,
            hermes(
                servers={
                    "ghost": {"url": "https://gone.example/mcp"},
                    "fine": {"url": "https://fine.example/mcp"},
                },
                runtime={"ghost": "failed", "fine": "connected"},
                errors={"ghost": "Connection refused"},
            ),
        ):
            found = mcp.read("bot-a")
        by_name = {server["name"]: server for server in found}
        self.assertEqual("failed", by_name["ghost"]["state"])
        self.assertEqual("Connection refused", by_name["ghost"]["reason"])
        self.assertIsNone(by_name["fine"]["reason"])

    def test_a_server_waiting_on_server_access_reads_as_needs_access(self):
        with mock.patch.dict(
            sys.modules,
            hermes(servers={"drive": {"url": "https://drive.example/mcp", "auth": "oauth"}}),
        ):
            found = mcp.read("bot-a")
        self.assertEqual(
            [{"name": "drive", "state": "needs_access", "enabled": True, "source": "config", "reason": None}],
            found,
        )

    def test_a_stored_access_token_reads_as_on(self):
        with mock.patch.dict(
            sys.modules,
            hermes(
                servers={"drive": {"url": "https://drive.example/mcp", "auth": "oauth"}},
                runtime={"drive": "connected"},
                tokens=["drive"],
            ),
        ):
            found = mcp.read("bot-a")
        self.assertEqual([("drive", "on")], rows(found))

    def test_a_connected_oauth_server_reads_as_on_with_no_stored_access(self):
        """A live connection wins: a server that is working is never shown as needing Server access."""
        with mock.patch.dict(
            sys.modules,
            hermes(
                servers={"drive": {"url": "https://drive.example/mcp", "auth": "oauth"}},
                runtime={"drive": "connected"},
            ),
        ):
            found = mcp.read("bot-a")
        self.assertEqual(
            [{"name": "drive", "state": "on", "enabled": True, "source": "config", "reason": None}], found
        )

    def test_a_connected_oauth_server_reads_as_on_from_the_status_word_alone(self):
        """Hermes's status word is enough; its ``connected`` flag needn't be there for the same read."""
        stubs = hermes(servers={"drive": {"url": "https://drive.example/mcp", "auth": "oauth"}})
        stubs["tools.mcp_tool_discovery"].get_mcp_status = lambda configured=None, **kwargs: [
            {"name": "drive", "status": "connected"}
        ]
        with mock.patch.dict(sys.modules, stubs):
            found = mcp.read("bot-a")
        self.assertEqual([("drive", "on")], rows(found))

    def test_needs_access_outranks_the_failure_a_token_less_oauth_server_reports(self):
        """Hermes reports ``failed`` until the flow lands; access is the word that offers it."""
        with mock.patch.dict(
            sys.modules,
            hermes(
                servers={"drive": {"url": "https://drive.example/mcp", "auth": "oauth"}},
                runtime={"drive": "failed"},
                errors={"drive": "401 Unauthorized"},
            ),
        ):
            found = mcp.read("bot-a")
        self.assertEqual([("drive", "needs_access")], rows(found))
        self.assertIsNone(found[0]["reason"])

    def test_a_server_that_declares_no_auth_is_never_waiting_on_access(self):
        """Only an ``auth: oauth`` server is asked about stored access."""
        with mock.patch.dict(
            sys.modules, hermes(servers={"plain": {"url": "https://plain.example/mcp"}})
        ):
            found = mcp.read("bot-a")
        self.assertEqual([("plain", "on")], rows(found))

    def test_a_hermes_plugins_server_reads_as_plugin(self):
        with mock.patch.dict(
            sys.modules,
            hermes(
                servers={"own": {"command": "srv"}},
                plugin_servers={"theirs": {"command": "plugin-srv"}},
                owners={"theirs": "gots-extras"},
                runtime={"theirs": "connected"},
            ),
        ):
            found = mcp.read("bot-a")
        self.assertEqual(
            {"name": "theirs", "state": "plugin", "enabled": True, "source": "plugin", "reason": None},
            {server["name"]: server for server in found}["theirs"],
        )

    def test_a_plugin_provided_server_reads_as_plugin_even_after_it_failed(self):
        """Hermes refuses to modify those, so the screen has no control to offer for one — but the
        Host's own reason for the failure still rides along with the word."""
        with mock.patch.dict(
            sys.modules,
            hermes(
                plugin_servers={"theirs": {"command": "plugin-srv"}},
                owners={"theirs": "gots-extras"},
                runtime={"theirs": "failed"},
                errors={"theirs": "spawn failed"},
            ),
        ):
            found = mcp.read("bot-a")
        self.assertEqual(
            {
                "name": "theirs",
                "state": "plugin",
                "enabled": True,
                "source": "plugin",
                "reason": "spawn failed",
            },
            found[0],
        )

    def test_a_plugin_provided_server_hermes_reports_no_error_for_carries_no_reason(self):
        with mock.patch.dict(
            sys.modules,
            hermes(
                plugin_servers={"theirs": {"command": "plugin-srv"}},
                owners={"theirs": "gots-extras"},
                runtime={"theirs": "failed"},
            ),
        ):
            found = mcp.read("bot-a")
        self.assertEqual(
            {"name": "theirs", "state": "plugin", "enabled": True, "source": "plugin", "reason": None},
            found[0],
        )

    def test_an_empty_profile_answers_an_empty_list(self):
        with mock.patch.dict(sys.modules, hermes()):
            self.assertEqual([], mcp.read("bot-a"))

    def test_the_read_runs_inside_the_given_profile_scope(self):
        stubs = hermes(servers={"srv": {"command": "npx"}})
        with mock.patch.dict(sys.modules, stubs):
            mcp.read("bot-a")
            mcp.read(None)
        self.assertEqual(["bot-a", None], stubs["hermes_cli.web_server_profiles"].scopes)

    def test_the_read_never_connects_a_server(self):
        """The fakes' discover and reconcile refuse; a read that reached for one would fail here."""
        with mock.patch.dict(
            sys.modules, hermes(servers={"srv": {"command": "npx"}}, runtime={"srv": "lazy"})
        ):
            found = mcp.read("bot-a")
        self.assertEqual([("srv", "on")], rows(found))


class McpToggleTests(unittest.TestCase):
    """Switching one of a bot's MCP servers on or off (``mcp.set_enabled``)."""

    def test_switching_a_server_off_writes_the_flag_and_reads_as_off(self):
        reconcile, saved = [], []
        stubs = hermes(
            servers={"github": {"command": "npx", "args": ["-y", "srv"]}},
            reconcile=reconcile,
            saved=saved,
        )
        with mock.patch.dict(sys.modules, stubs):
            answered = mcp.set_enabled("bot-a", "github", False)
            after = mcp.read("bot-a")
        self.assertEqual(
            {"name": "github", "state": "off", "enabled": False, "source": "config", "reason": None},
            answered,
        )
        self.assertEqual([("github", "off")], rows(after))
        self.assertIs(False, saved[-1][1]["mcp_servers"]["github"]["enabled"])

    def test_switching_a_server_back_on_writes_the_flag_and_reads_as_on(self):
        saved = []
        stubs = hermes(
            servers={"github": {"command": "npx", "enabled": False}},
            reconcile=[],
            saved=saved,
        )
        with mock.patch.dict(sys.modules, stubs):
            answered = mcp.set_enabled("bot-a", "github", True)
        self.assertEqual("on", answered["state"])
        self.assertIs(True, answered["enabled"])
        self.assertIs(True, saved[-1][1]["mcp_servers"]["github"]["enabled"])

    def test_the_write_and_the_reconcile_run_inside_the_given_profile_scope(self):
        """The scope is what keeps one bot's toggle from touching another bot's servers."""
        reconcile, saved = [], []
        stubs = hermes(servers={"srv": {"command": "npx"}}, reconcile=reconcile, saved=saved)
        with mock.patch.dict(sys.modules, stubs):
            mcp.set_enabled("bot-a", "srv", False)
            mcp.set_enabled("bot-b", "srv", False)
        # Each write entered its own profile's scope — Hermes's own config write scope, not the
        # read's — and the reconcile ran inside that scope, not after it, so neither bot's toggle
        # could touch the other's servers.
        self.assertEqual(["bot-a", "bot-b"], stubs["hermes_cli.web_routers._common"].write_scopes)
        self.assertEqual(["bot-a", "bot-b"], [scope for scope, _config in saved])
        self.assertEqual([], stubs["hermes_cli.web_server_profiles"].scopes)
        self.assertEqual(["bot-a", "bot-b"], reconcile)

    def test_switching_off_and_back_on_leaves_the_servers_other_keys_alone(self):
        saved = []
        stubs = hermes(
            servers={
                "postgres": {
                    "url": "https://db.example/mcp",
                    "env": {"PGPASSWORD": "${PG_PASSWORD}"},
                    "args": ["--ro"],
                }
            },
            reconcile=[],
            saved=saved,
        )
        with mock.patch.dict(sys.modules, stubs):
            mcp.set_enabled("bot-a", "postgres", False)
            mcp.set_enabled("bot-a", "postgres", True)
        entry = saved[-1][1]["mcp_servers"]["postgres"]
        self.assertEqual(
            {
                "url": "https://db.example/mcp",
                "env": {"PGPASSWORD": "${PG_PASSWORD}"},
                "args": ["--ro"],
                "enabled": True,
            },
            entry,
        )

    def test_a_server_a_hermes_plugin_provides_is_refused(self):
        """Hermes refuses to modify those, so the toggle must not try."""
        saved, reconcile = [], []
        stubs = hermes(
            plugin_servers={"theirs": {"command": "plugin-srv"}},
            owners={"theirs": "gots-extras"},
            saved=saved,
            reconcile=reconcile,
        )
        with mock.patch.dict(sys.modules, stubs):
            with self.assertRaises(mcp.McpError) as caught:
                mcp.set_enabled("bot-a", "theirs", False)
        self.assertEqual(400, caught.exception.status)
        self.assertEqual([], saved)
        self.assertEqual([], reconcile)

    def test_an_unknown_server_is_refused(self):
        saved = []
        stubs = hermes(servers={"github": {"command": "npx"}}, saved=saved, reconcile=[])
        with mock.patch.dict(sys.modules, stubs):
            with self.assertRaises(mcp.McpError) as caught:
                mcp.set_enabled("bot-a", "nope", False)
        self.assertEqual(400, caught.exception.status)
        self.assertEqual([], saved)

    def test_the_toggle_never_connects_a_server(self):
        """``discover_mcp_tools`` refuses in the fakes; a toggle that reached for it would fail here."""
        stubs = hermes(servers={"srv": {"command": "npx"}}, reconcile=[])
        with mock.patch.dict(sys.modules, stubs):
            answered = mcp.set_enabled("bot-a", "srv", False)
        self.assertEqual("off", answered["state"])

    def test_a_servers_entry_that_is_empty_is_given_the_flag(self):
        """A bare `name:` in the YAML reads back as None; the write must not fail on it."""
        saved = []
        stubs = hermes(servers={"github": None}, reconcile=[], saved=saved)
        with mock.patch.dict(sys.modules, stubs):
            answered = mcp.set_enabled("bot-a", "github", False)
        self.assertEqual("off", answered["state"])
        self.assertIs(False, answered["enabled"])
        self.assertEqual({"enabled": False}, saved[-1][1]["mcp_servers"]["github"])

    def test_a_servers_entry_that_is_not_a_mapping_is_refused(self):
        """Writing the flag would mean dropping whatever the entry holds, so it is refused instead."""
        saved = []
        stubs = hermes(servers={"weird": "nonsense"}, reconcile=[], saved=saved)
        with mock.patch.dict(sys.modules, stubs):
            with self.assertRaises(mcp.McpError) as caught:
                mcp.set_enabled("bot-a", "weird", False)
        self.assertEqual(400, caught.exception.status)
        self.assertEqual([], saved)

    def test_a_host_without_the_write_built_ins_refuses_with_501(self):
        """A host that can list servers but has no writers still lists them, and refuses a toggle."""
        stubs = hermes(servers={"srv": {"command": "npx"}}, reconcile=[])
        stubs["hermes_cli.web_routers._common"] = None
        with mock.patch.dict(sys.modules, stubs):
            self.assertIsNone(mcp.available())
            with self.assertRaises(mcp.McpError) as caught:
                mcp.set_enabled("bot-a", "srv", False)
        self.assertEqual(501, caught.exception.status)


class McpRemoveTests(unittest.TestCase):
    """Taking one of a bot's MCP servers away (``mcp.remove``)."""

    def test_removing_a_server_takes_its_entry_and_answers_what_is_left(self):
        uninstalled, forgotten, reconcile, saved = [], [], [], []
        stubs = hermes(
            servers={
                "obsolete": {"command": "npx", "args": ["-y", "old"]},
                "kept": {"url": "https://db.example/mcp", "env": {"PGPASSWORD": "${PG_PASSWORD}"}},
            },
            reconcile=reconcile,
            saved=saved,
            uninstalled=uninstalled,
            forgotten=forgotten,
        )
        with mock.patch.dict(sys.modules, stubs):
            left = mcp.remove("bot-a", "obsolete")
            after = mcp.read("bot-a")
        # The list is what the Host has left, and the entry is gone from the config it wrote.
        self.assertEqual([("kept", "on")], rows(left))
        self.assertEqual([("kept", "on")], rows(after))
        self.assertNotIn("obsolete", saved[-1][1]["mcp_servers"])
        # Hermes's own uninstall is what removed it, asked to purge the directory it cloned too.
        self.assertEqual([("bot-a", "obsolete", True)], uninstalled)
        # The server that stayed keeps everything of its own, its environment values included.
        self.assertEqual(
            {"url": "https://db.example/mcp", "env": {"PGPASSWORD": "${PG_PASSWORD}"}},
            saved[-1][1]["mcp_servers"]["kept"],
        )

    def test_a_servers_stored_server_access_goes_with_it(self):
        """``hermes mcp remove`` drops the stored access too, so adding it again needs it granted."""
        forgotten, uninstalled = [], []
        stubs = hermes(
            servers={"drive": {"url": "https://drive.example/mcp", "auth": "oauth"}},
            tokens=["drive"],
            reconcile=[],
            uninstalled=uninstalled,
            forgotten=forgotten,
        )
        with mock.patch.dict(sys.modules, stubs):
            before = mcp.read("bot-a")
            left = mcp.remove("bot-a", "drive")
        self.assertEqual([("drive", "on")], rows(before))
        self.assertEqual([], left)
        self.assertEqual([("bot-a", "drive")], forgotten)

    def test_the_removal_and_its_reconcile_run_inside_the_given_profile_scope(self):
        """The scope is what keeps one bot's removal from touching another bot's servers."""
        uninstalled, forgotten, reconcile = [], [], []
        stubs = hermes(
            servers={"one": {"command": "npx"}, "two": {"command": "npx"}},
            reconcile=reconcile,
            uninstalled=uninstalled,
            forgotten=forgotten,
        )
        with mock.patch.dict(sys.modules, stubs):
            mcp.remove("bot-a", "one")
            mcp.remove("bot-b", "two")
        # Each removal entered its own profile's scope — Hermes's own config write scope, not the
        # read's — and everything it ran ran inside that scope, not after it.
        self.assertEqual(["bot-a", "bot-b"], stubs["hermes_cli.web_routers._common"].write_scopes)
        self.assertEqual([("bot-a", "one", True), ("bot-b", "two", True)], uninstalled)
        self.assertEqual([("bot-a", "one"), ("bot-b", "two")], forgotten)
        self.assertEqual(["bot-a", "bot-b"], reconcile)
        self.assertEqual([], stubs["hermes_cli.web_server_profiles"].scopes)

    def test_a_server_a_hermes_plugin_provides_is_refused(self):
        """Hermes refuses to modify those, so the removal must not try."""
        uninstalled, forgotten, reconcile = [], [], []
        stubs = hermes(
            plugin_servers={"theirs": {"command": "plugin-srv"}},
            owners={"theirs": "gots-extras"},
            uninstalled=uninstalled,
            forgotten=forgotten,
            reconcile=reconcile,
        )
        with mock.patch.dict(sys.modules, stubs):
            with self.assertRaises(mcp.McpError) as caught:
                mcp.remove("bot-a", "theirs")
        self.assertEqual(400, caught.exception.status)
        self.assertEqual([], uninstalled)
        self.assertEqual([], forgotten)
        self.assertEqual([], reconcile)

    def test_an_unknown_server_is_refused(self):
        uninstalled, forgotten = [], []
        stubs = hermes(
            servers={"github": {"command": "npx"}},
            reconcile=[],
            uninstalled=uninstalled,
            forgotten=forgotten,
        )
        with mock.patch.dict(sys.modules, stubs):
            with self.assertRaises(mcp.McpError) as caught:
                mcp.remove("bot-a", "nope")
        self.assertEqual(400, caught.exception.status)
        self.assertEqual([], uninstalled)
        self.assertEqual([], forgotten)

    def test_the_removal_never_connects_a_server(self):
        """``discover_mcp_tools`` refuses in the fakes; a removal that reached for it would fail here."""
        stubs = hermes(
            servers={"srv": {"command": "npx"}}, reconcile=[], uninstalled=[], forgotten=[]
        )
        with mock.patch.dict(sys.modules, stubs):
            left = mcp.remove("bot-a", "srv")
        self.assertEqual([], left)

    def test_the_removal_leaves_the_values_in_the_profiles_environment(self):
        """The values in the profile's ``.env`` stay, so adding the server again means no new key.

        Hermes's own uninstall drops the configuration entry and the directory it cloned and nothing
        else, and the removal writes no value back: the profile's environment writer is never called.
        """
        env = {"PG_PASSWORD": "already-found-once"}
        env_writes = []
        stubs = hermes(
            servers={"obsolete": {"command": "npx", "env": {"PGPASSWORD": "${PG_PASSWORD}"}}},
            env=env,
            env_writes=env_writes,
            reconcile=[],
            uninstalled=[],
            forgotten=[],
        )
        with mock.patch.dict(sys.modules, stubs):
            mcp.remove("bot-a", "obsolete")
        self.assertEqual([], env_writes)
        self.assertEqual({"PG_PASSWORD": "already-found-once"}, env)

    def test_a_host_without_the_removals_built_ins_refuses_with_501(self):
        """The removal's own built-ins are what its *own* gate covers, not the switch's.

        A missing one leaves the list and the switch alone where they don't need it — the read's own
        gate is its own test — and takes the removal out of the ``info`` payload and off the ``remove``
        route.
        """
        for missing in (
            "hermes_cli.config",
            "hermes_cli.mcp_catalog",
            "hermes_cli.web_routers._common",
            "tools.mcp_oauth_manager",
            "tools.mcp_tool_discovery",
            "tui_gateway.mcp_rpc_helpers",
        ):
            with self.subTest(missing=missing):
                stubs = hermes(servers={"srv": {"command": "npx"}}, reconcile=[])
                stubs[missing] = None
                with mock.patch.dict(sys.modules, stubs):
                    self.assertIsInstance(mcp.removable(), str)
                    with self.assertRaises(mcp.McpError) as caught:
                        mcp.remove("bot-a", "srv")
                self.assertEqual(501, caught.exception.status)


class McpCatalogueTests(unittest.TestCase):
    """Browsing Hermes's Catalogue for a bot (``mcp.catalogue``): a read, and nothing else."""

    def test_every_entry_is_listed_sorted_with_whether_the_bot_has_it(self):
        """An entry the bot's config has reads as installed, one it doesn't as not installed."""
        stubs = hermes(
            servers={"github": {"command": "npx"}, "postgres": {"url": "https://db.example/mcp", "enabled": False}},
            catalogue=[
                {"name": "slack", "description": "Read and post in Slack channels."},
                {"name": "github", "description": "Open, review and land pull requests."},
                {"name": "postgres", "description": "Query a Postgres database."},
            ],
        )
        with mock.patch.dict(sys.modules, stubs):
            found = mcp.catalogue("bot-a")
        self.assertEqual(
            [
                {
                    "name": "github",
                    "description": "Open, review and land pull requests.",
                    "installed": True,
                },
                {
                    "name": "postgres",
                    "description": "Query a Postgres database.",
                    "installed": True,
                },
                {
                    "name": "slack",
                    "description": "Read and post in Slack channels.",
                    "installed": False,
                },
            ],
            found,
        )

    def test_the_whole_catalogue_costs_one_read_of_the_profile(self):
        """The mark is Hermes's own, taken from one read of the profile's servers, inside its scope.

        Hermes's per-entry check reads the profile's config on every call, so marking a catalogue
        entry by entry would load and expand that config once per entry.
        """
        reads = []
        stubs = hermes(
            servers={"github": {"command": "npx"}},
            catalogue=[
                {"name": "slack", "description": "Read and post in Slack channels."},
                {"name": "github", "description": "Open, review and land pull requests."},
                {"name": "postgres", "description": "Query a Postgres database."},
            ],
            reads=reads,
        )
        with mock.patch.dict(sys.modules, stubs):
            found = mcp.catalogue("bot-a")
        self.assertEqual(["bot-a"], reads)
        # A to Z: github is the one this bot's config has.
        self.assertEqual([True, False, False], [entry["installed"] for entry in found])

    def test_an_entry_with_no_description_reads_as_an_empty_one(self):
        """An entry Hermes says nothing about carries an empty description; the app shows its name."""
        stubs = hermes(catalogue=[{"name": "bare"}])
        with mock.patch.dict(sys.modules, stubs):
            found = mcp.catalogue("bot-a")
        self.assertEqual([{"name": "bare", "description": "", "installed": False}], found)

    def test_an_empty_catalogue_answers_an_empty_list(self):
        with mock.patch.dict(sys.modules, hermes()):
            self.assertEqual([], mcp.catalogue("bot-a"))

    def test_the_catalogue_runs_inside_the_given_profile_scope(self):
        """The scope is what keeps one bot's catalogue from marking another bot's entries."""
        stubs = hermes(catalogue=[{"name": "slack", "description": "Slack."}])
        with mock.patch.dict(sys.modules, stubs):
            mcp.catalogue("bot-a")
            mcp.catalogue(None)
        self.assertEqual(["bot-a", None], stubs["hermes_cli.web_server_profiles"].scopes)

    def test_browsing_the_catalogue_writes_nothing(self):
        """The fakes' writers refuse where they can be reached; this proves none was asked for."""
        env_writes, saved, reconcile = [], [], []
        stubs = hermes(
            servers={"github": {"command": "npx"}},
            catalogue=[{"name": "github", "description": "GitHub."}, {"name": "slack", "description": "Slack."}],
            env_writes=env_writes,
            saved=saved,
            reconcile=reconcile,
        )
        with mock.patch.dict(sys.modules, stubs):
            mcp.catalogue("bot-a")
        self.assertEqual([], saved)
        self.assertEqual([], env_writes)
        self.assertEqual([], reconcile)
        # Nothing entered Hermes's config write scope: a read never takes the config lock.
        self.assertEqual([], stubs["hermes_cli.web_routers._common"].write_scopes)

    def test_the_bot_is_unchanged_by_browsing_it(self):
        """The read reports the profile's config without touching it, so the bot has what it had."""
        stubs = hermes(
            servers={"github": {"command": "npx"}},
            catalogue=[{"name": "github", "description": "GitHub."}, {"name": "slack", "description": "Slack."}],
            reconcile=[],
        )
        with mock.patch.dict(sys.modules, stubs):
            marked = {entry["name"]: entry["installed"] for entry in mcp.catalogue("bot-a")}
            after = mcp.read("bot-a")
        self.assertEqual({"github": True, "slack": False}, marked)
        self.assertEqual([("github", "on")], rows(after))

    def test_a_host_without_the_catalogue_built_ins_offers_none(self):
        """A host whose Hermes has no Catalogue offers no Add action, and the route is a 501."""
        for missing in ("hermes_cli.mcp_catalog", "hermes_cli.web_server_profiles"):
            with self.subTest(missing=missing):
                stubs = hermes(servers={"srv": {"command": "npx"}}, catalogue=[{"name": "slack"}])
                stubs[missing] = None
                with mock.patch.dict(sys.modules, stubs):
                    self.assertIsInstance(mcp.browsable(), str)
                    with self.assertRaises(mcp.McpError) as caught:
                        mcp.catalogue("bot-a")
                self.assertEqual(501, caught.exception.status)

    def test_a_host_whose_catalogue_module_lost_a_function_is_a_501(self):
        """Hermes's own module, with the read moved out of it: the same 501 as a missing module."""
        stubs = hermes(catalogue=[{"name": "slack"}])
        del stubs["hermes_cli.mcp_catalog"].list_catalog
        with mock.patch.dict(sys.modules, stubs):
            self.assertIsInstance(mcp.browsable(), str)
            with self.assertRaises(mcp.McpError) as caught:
                mcp.catalogue("bot-a")
        self.assertEqual(501, caught.exception.status)

    def test_browsing_and_the_servers_read_are_gated_apart(self):
        """The Catalogue's built-ins aren't the read's: a host with one and not the other is real."""
        stubs = hermes(servers={"srv": {"command": "npx"}}, catalogue=[{"name": "slack"}])
        del stubs["hermes_cli.mcp_catalog"].list_catalog
        with mock.patch.dict(sys.modules, stubs):
            self.assertIsNone(mcp.available())
            self.assertEqual([("srv", "on")], rows(mcp.read("bot-a")))
            self.assertIsInstance(mcp.browsable(), str)


class McpFeatureGateTests(unittest.TestCase):
    def test_the_hosts_built_ins_are_available(self):
        with mock.patch.dict(sys.modules, hermes()):
            self.assertIsNone(mcp.available())
            self.assertIsNone(mcp.writable())
            self.assertIsNone(mcp.removable())
            self.assertIsNone(mcp.browsable())

    def test_the_features_are_declared_once_with_their_own_check(self):
        """The table ``info`` advertises from: every feature this module answers for and its gate."""
        self.assertEqual(
            [
                ("mcps", mcp.available),
                ("mcps_write", mcp.writable),
                ("mcps_remove", mcp.removable),
                ("mcps_catalogue", mcp.browsable),
                ("mcps_add", mcp.addable),
            ],
            list(mcp.FEATURES),
        )

    def test_a_host_that_can_only_read_still_lists_its_servers(self):
        """The write's built-ins are a different set from the read's, so this combination is real."""
        for missing in ("hermes_cli.config", "hermes_cli.web_routers._common"):
            with self.subTest(missing=missing):
                stubs = hermes(servers={"srv": {"command": "npx"}}, reconcile=[])
                stubs[missing] = None
                with mock.patch.dict(sys.modules, stubs):
                    self.assertIsNone(mcp.available())
                    self.assertEqual([("srv", "on")], rows(mcp.read("bot-a")))
                    self.assertIsInstance(mcp.writable(), str)

    def test_the_switch_is_unavailable_when_a_write_built_in_is_missing(self):
        """``writable()`` is the gate the ``info`` payload's second feature is advertised from."""
        for missing in (
            "hermes_cli.config",
            "hermes_cli.web_routers._common",
            "tools.mcp_tool_discovery",
            "tui_gateway.mcp_rpc_helpers",
        ):
            with self.subTest(missing=missing):
                stubs = hermes(servers={"srv": {"command": "npx"}}, reconcile=[])
                stubs[missing] = None
                with mock.patch.dict(sys.modules, stubs):
                    self.assertIsInstance(mcp.writable(), str)
                    self.assertTrue(mcp.writable())
                    with self.assertRaises(mcp.McpError) as caught:
                        mcp.set_enabled("bot-a", "srv", False)
                self.assertEqual(501, caught.exception.status)

    def test_a_host_that_can_switch_but_not_remove_still_offers_the_switch(self):
        """The plugin that first shipped the switch is exactly that host, and must keep its switch.

        A removal needs two built-ins the switch doesn't, so the two are gated apart: a bot whose
        plugin predates the removal gets a switch and no removal, rather than a removal whose every
        tap would be a 404.
        """
        for missing in ("hermes_cli.mcp_catalog", "tools.mcp_oauth_manager"):
            with self.subTest(missing=missing):
                stubs = hermes(servers={"srv": {"command": "npx"}}, reconcile=[])
                stubs[missing] = None
                with mock.patch.dict(sys.modules, stubs):
                    self.assertIsNone(mcp.writable())
                    answered = mcp.set_enabled("bot-a", "srv", False)
                    self.assertEqual(("srv", "off"), (answered["name"], answered["state"]))
                    self.assertIsInstance(mcp.removable(), str)

    def test_the_feature_is_unavailable_when_a_built_in_is_missing(self):
        for missing in (
            "hermes_cli.mcp_config",
            "hermes_cli.web_server_profiles",
            "tools.mcp_tool_discovery",
            "tui_gateway.mcp_rpc_helpers",
        ):
            with self.subTest(missing=missing):
                stubs = hermes(servers={"srv": {"command": "npx"}})
                stubs[missing] = None
                with mock.patch.dict(sys.modules, stubs):
                    self.assertIsInstance(mcp.available(), str)
                    self.assertTrue(mcp.available())
                    with self.assertRaises(mcp.McpError) as caught:
                        mcp.read("bot-a")
                self.assertEqual(501, caught.exception.status)

    def test_the_feature_is_unavailable_when_a_built_in_moved_inside_its_module(self):
        stubs = hermes()
        del stubs["tools.mcp_tool_discovery"].get_mcp_status
        with mock.patch.dict(sys.modules, stubs):
            self.assertIsInstance(mcp.available(), str)
            with self.assertRaises(mcp.McpError) as caught:
                mcp.read("bot-a")
        self.assertEqual(501, caught.exception.status)

    def test_hermes_imports_stay_deferred(self):
        """A plugin loads before the CLI does: no Hermes import sits at module level."""
        imports = [
            line for line in inspect.getsource(mcp).splitlines() if line.startswith(("import ", "from "))
        ]
        self.assertEqual(
            [],
            [
                line
                for line in imports
                if any(name in line for name in ("hermes", "tools", "tui_gateway", "agent"))
            ],
        )


class McpEntryTests(unittest.TestCase):
    """One Catalogue entry as a bot is offered it (``mcp.entry``): what it declares, and nothing else.

    The form that adds an entry is built from this: one field per value the entry declares, with
    whether each is required, whether it is secret, the default its manifest pins and whether this
    bot already has a value for it. A value already set on the host is reported as set and its
    content is never answered — that is the whole of what the screen may know about it.
    """

    def test_the_values_an_entry_declares_are_reported_apart_from_their_content(self):
        stubs = hermes(catalogue=[POSTGRES])
        with mock.patch.dict(sys.modules, stubs):
            found = mcp.entry("bot-a", "postgres")
        self.assertEqual(
            {
                "name": "postgres",
                "description": "Query a Postgres database.",
                "installed": False,
                "values": [
                    {
                        "name": "PG_DATABASE",
                        "prompt": "Database",
                        "required": True,
                        "secret": False,
                        "default": "postgres",
                        "set": False,
                    },
                    {
                        "name": "PG_PASSWORD",
                        "prompt": "Password",
                        "required": True,
                        "secret": True,
                        "default": "",
                        "set": False,
                    },
                ],
            },
            found,
        )

    def test_a_value_already_set_on_the_host_reads_as_set_and_never_as_its_content(self):
        """The value is the host's, and the host never answers it back: only that it has one."""
        stubs = hermes(catalogue=[POSTGRES], env={"PG_PASSWORD": "already-found-once"})
        with mock.patch.dict(sys.modules, stubs):
            found = mcp.entry("bot-a", "postgres")
        by_name = {value["name"]: value for value in found["values"]}
        self.assertIs(True, by_name["PG_PASSWORD"]["set"])
        self.assertIs(False, by_name["PG_DATABASE"]["set"])
        self.assertNotIn("already-found-once", repr(found))

    def test_an_entry_whose_values_have_a_default_keeps_them(self):
        """A manifest-pinned default is the one thing the screen may fill in for the user."""
        stubs = hermes(catalogue=[POSTGRES])
        with mock.patch.dict(sys.modules, stubs):
            found = mcp.entry("bot-a", "postgres")
        self.assertEqual(["postgres", ""], [value["default"] for value in found["values"]])

    def test_the_entry_carries_whether_this_bot_already_has_it(self):
        stubs = hermes(servers={"postgres": {"command": "srv"}}, catalogue=[POSTGRES, {"name": "slack"}])
        with mock.patch.dict(sys.modules, stubs):
            added = mcp.entry("bot-a", "postgres")
            missing = mcp.entry("bot-a", "slack")
        self.assertIs(True, added["installed"])
        self.assertIs(False, missing["installed"])

    def test_an_entry_that_declares_nothing_answers_no_values(self):
        stubs = hermes(catalogue=[{"name": "slack", "description": "Read and post in Slack channels."}])
        with mock.patch.dict(sys.modules, stubs):
            found = mcp.entry("bot-a", "slack")
        self.assertEqual(
            {
                "name": "slack",
                "description": "Read and post in Slack channels.",
                "installed": False,
                "values": [],
            },
            found,
        )

    def test_a_value_that_is_not_required_is_reported_as_such(self):
        """A manifest may leave a value optional, and the screen marks only the ones it doesn't."""
        stubs = hermes(catalogue=[SENTRY])
        with mock.patch.dict(sys.modules, stubs):
            found = mcp.entry("bot-a", "sentry")
        by_name = {value["name"]: value for value in found["values"]}
        self.assertIs(False, by_name["SENTRY_REGION"]["required"])
        self.assertIs(True, by_name["SENTRY_ORG"]["required"])

    def test_a_secrets_default_is_never_answered(self):
        """A masked field is no place for a credential, default or not, so one is never sent back."""
        stubs = hermes(catalogue=[SENTRY])
        with mock.patch.dict(sys.modules, stubs):
            found = mcp.entry("bot-a", "sentry")
        by_name = {value["name"]: value for value in found["values"]}
        self.assertEqual("eu-west-1", by_name["SENTRY_REGION"]["default"])
        self.assertEqual("", by_name["SENTRY_AUTH_TOKEN"]["default"])
        self.assertNotIn("a-pinned-secret", repr(found))

    def test_an_entry_the_catalogue_does_not_have_is_refused(self):
        stubs = hermes(catalogue=[POSTGRES])
        with mock.patch.dict(sys.modules, stubs):
            with self.assertRaises(mcp.McpError) as caught:
                mcp.entry("bot-a", "nope")
        self.assertEqual(400, caught.exception.status)

    def test_the_entry_runs_inside_the_bots_own_read_scope_and_writes_nothing(self):
        saved, env_writes, reconcile, cards = [], [], [], []
        stubs = hermes(
            catalogue=[POSTGRES],
            saved=saved,
            env_writes=env_writes,
            reconcile=reconcile,
            cards=cards,
        )
        with mock.patch.dict(sys.modules, stubs):
            mcp.entry("bot-a", "postgres")
            mcp.entry(None, "postgres")
        self.assertEqual(["bot-a", None], stubs["hermes_cli.web_server_profiles"].scopes)
        self.assertEqual([], stubs["hermes_cli.web_routers._common"].write_scopes)
        self.assertEqual([], saved)
        self.assertEqual([], env_writes)
        self.assertEqual([], reconcile)
        # Reading an entry never builds the block that adding it would write.
        self.assertEqual([], cards)

    def test_a_host_without_the_adding_built_ins_offers_no_entry(self):
        """The entry read is the adding half's, so a host that can't add one can't read one either."""
        for missing in (
            "hermes_cli.mcp_catalog",
            "hermes_cli.mcp_config",
            "hermes_cli.mcp_security",
            "hermes_cli.web_routers._common",
            "tools.mcp_tool_discovery",
        ):
            with self.subTest(missing=missing):
                stubs = hermes(catalogue=[POSTGRES])
                stubs[missing] = None
                with mock.patch.dict(sys.modules, stubs):
                    self.assertIsInstance(mcp.addable(), str)
                    with self.assertRaises(mcp.McpError) as caught:
                        mcp.entry("bot-a", "postgres")
                self.assertEqual(501, caught.exception.status)


class McpAddTests(unittest.TestCase):
    """Adding one of the Catalogue's entries to a bot (``mcp.install``)."""

    def test_adding_an_entry_writes_the_server_and_answers_what_the_bot_has(self):
        cards, inlines, env_writes, saved, reconcile = [], [], [], [], []
        stubs = hermes(
            catalogue=[POSTGRES],
            cards=cards,
            inlines=inlines,
            env_writes=env_writes,
            saved=saved,
            reconcile=reconcile,
        )
        with mock.patch.dict(sys.modules, stubs):
            servers = mcp.install("bot-a", "postgres", {"PG_DATABASE": "gots", "PG_PASSWORD": "hunter2"})
        # The server the bot now has, shaped as the screen's own read shapes it.
        self.assertEqual([("postgres", "on")], rows(servers))
        # Hermes's own card built the block, and the non-secret value was inlined into it: the
        # secret's ref stays, so the config never carries a credential.
        self.assertEqual(["postgres"], cards)
        self.assertEqual(
            {
                "command": "srv",
                "args": ["--db", "gots"],
                "env": {"DATABASE_URL": "postgres://user:${PG_PASSWORD}@db.example/gots"},
                "enabled": True,
            },
            saved[-1][1]["mcp_servers"]["postgres"],
        )
        self.assertEqual([("PG_DATABASE", "gots")], inlines)
        # The secret went through Hermes's own environment writer, and the change is live.
        self.assertEqual([("bot-a", "PG_PASSWORD")], env_writes)
        self.assertEqual("hunter2", stubs["hermes_cli.config"].get_env_value("PG_PASSWORD"))
        self.assertEqual(["bot-a"], reconcile)

    def test_only_a_secret_reaches_the_profiles_environment(self):
        """``.env`` is secrets-only: a plain value (a hostname, a database name) is inlined instead."""
        env_writes, inlines = [], []
        stubs = hermes(
            catalogue=[POSTGRES],
            env={"PG_PASSWORD": "already-found-once"},
            env_writes=env_writes,
            inlines=inlines,
            reconcile=[],
        )
        with mock.patch.dict(sys.modules, stubs):
            mcp.install("bot-a", "postgres", {"PG_DATABASE": "gots"})
        self.assertEqual([], env_writes)
        self.assertEqual([("PG_DATABASE", "gots")], inlines)

    def test_the_whole_add_runs_inside_the_given_profile_scope(self):
        """The scope is what keeps one bot's add from landing on another bot."""
        cards, env_writes, saved, reconcile = [], [], [], []
        stubs = hermes(
            catalogue=[POSTGRES],
            cards=cards,
            env_writes=env_writes,
            saved=saved,
            reconcile=reconcile,
        )
        with mock.patch.dict(sys.modules, stubs):
            mcp.install("bot-a", "postgres", {"PG_DATABASE": "a", "PG_PASSWORD": "one"})
            mcp.install("bot-b", "postgres", {"PG_DATABASE": "b", "PG_PASSWORD": "two"})
        # Hermes's own config write scope, not the read's, and everything the add ran inside it.
        self.assertEqual(["bot-a", "bot-b"], stubs["hermes_cli.web_routers._common"].write_scopes)
        self.assertEqual([("bot-a", "PG_PASSWORD"), ("bot-b", "PG_PASSWORD")], env_writes)
        self.assertEqual(["bot-a", "bot-b"], [scope for scope, _config in saved])
        self.assertEqual(["bot-a", "bot-b"], reconcile)
        self.assertEqual([], stubs["hermes_cli.web_server_profiles"].scopes)

    def test_a_required_value_left_empty_is_refused_and_nothing_is_written(self):
        cards, saved, env_writes, reconcile = [], [], [], []
        stubs = hermes(
            catalogue=[POSTGRES],
            cards=cards,
            saved=saved,
            env_writes=env_writes,
            reconcile=reconcile,
        )
        with mock.patch.dict(sys.modules, stubs):
            with self.assertRaises(mcp.McpError) as caught:
                mcp.install("bot-a", "postgres", {"PG_DATABASE": "gots"})
        self.assertEqual(400, caught.exception.status)
        self.assertIn("PG_PASSWORD", str(caught.exception))
        # Nothing was built, written or reconciled: the bot is exactly what it was.
        self.assertEqual([], cards)
        self.assertEqual([], saved)
        self.assertEqual([], env_writes)
        self.assertEqual([], reconcile)

    def test_an_empty_value_is_a_value_left_empty(self):
        """A field the form sent as empty is the same as one it left out."""
        stubs = hermes(catalogue=[POSTGRES], cards=[], saved=[], env_writes=[], reconcile=[])
        with mock.patch.dict(sys.modules, stubs):
            with self.assertRaises(mcp.McpError) as caught:
                mcp.install("bot-a", "postgres", {"PG_DATABASE": "gots", "PG_PASSWORD": ""})
        self.assertEqual(400, caught.exception.status)
        self.assertIn("PG_PASSWORD", str(caught.exception))

    def test_a_value_the_entry_does_not_declare_is_refused_and_nothing_is_written(self):
        """Configuring one MCP is not a general environment-writing primitive."""
        cards, saved, env_writes, checks = [], [], [], []
        stubs = hermes(
            catalogue=[POSTGRES],
            cards=cards,
            saved=saved,
            env_writes=env_writes,
            checks=checks,
            reconcile=[],
        )
        with mock.patch.dict(sys.modules, stubs):
            with self.assertRaises(mcp.McpError) as caught:
                mcp.install("bot-a", "postgres", {"PG_DATABASE": "gots", "AWS_SECRET_ACCESS_KEY": "x"})
        self.assertEqual(400, caught.exception.status)
        self.assertIn("AWS_SECRET_ACCESS_KEY", str(caught.exception))
        self.assertEqual([], cards)
        self.assertEqual([], saved)
        self.assertEqual([], env_writes)
        self.assertEqual([], checks)

    def test_a_value_name_hermes_writer_refuses_is_refused_and_nothing_is_written(self):
        """A declared name that would steer a subprocess never reaches the writer at all."""
        entry = dict(POSTGRES)
        entry["auth"] = {
            "type": "none",
            "env": [{"name": "LD_PRELOAD", "prompt": "Library", "required": True, "secret": True}],
        }
        cards, saved, env_writes = [], [], []
        stubs = hermes(catalogue=[entry], cards=cards, saved=saved, env_writes=env_writes, reconcile=[])
        with mock.patch.dict(sys.modules, stubs):
            with self.assertRaises(mcp.McpError) as caught:
                mcp.install("bot-a", "postgres", {"LD_PRELOAD": "/tmp/evil.so"})
        self.assertEqual(400, caught.exception.status)
        self.assertIn("LD_PRELOAD", str(caught.exception))
        self.assertEqual([], cards)
        self.assertEqual([], saved)
        self.assertEqual([], env_writes)

    def test_a_config_hermes_own_validator_refuses_surfaces_its_reason_and_leaves_nothing(self):
        """The refusal is Hermes's own sentence, and the secret is written only after it lands."""
        reason = "Server 'postgres' runs a command that fetches and executes a remote script."
        cards, saved, env_writes, reconcile, validates = [], [], [], [], []
        stubs = hermes(
            catalogue=[POSTGRES],
            refusals={"postgres": [reason]},
            cards=cards,
            saved=saved,
            env_writes=env_writes,
            reconcile=reconcile,
            validates=validates,
        )
        with mock.patch.dict(sys.modules, stubs):
            with self.assertRaises(mcp.McpError) as caught:
                mcp.install("bot-a", "postgres", {"PG_DATABASE": "gots", "PG_PASSWORD": "hunter2"})
        self.assertEqual(400, caught.exception.status)
        self.assertIn(reason, str(caught.exception))
        # The block was built and offered to Hermes's own write, which refused it: no config entry,
        # no value in the environment and no reconcile, so nothing is half-added.
        self.assertEqual(["postgres"], cards)
        self.assertEqual(["postgres"], [name for name, _cfg in validates])
        self.assertEqual([], saved)
        self.assertEqual([], env_writes)
        self.assertEqual([], reconcile)
        self.assertEqual({}, stubs["hermes_cli.mcp_config"]._get_mcp_servers())

    def test_a_value_already_set_on_the_host_is_not_asked_for_again(self):
        """The bot keeps a value it has: adding the same entry again needs no new key."""
        env_writes, saved = [], []
        stubs = hermes(
            catalogue=[POSTGRES],
            env={"PG_PASSWORD": "already-found-once"},
            env_writes=env_writes,
            saved=saved,
            reconcile=[],
        )
        with mock.patch.dict(sys.modules, stubs):
            servers = mcp.install("bot-a", "postgres", {"PG_DATABASE": "gots"})
        self.assertEqual([("postgres", "on")], rows(servers))
        self.assertEqual(
            {"DATABASE_URL": "postgres://user:${PG_PASSWORD}@db.example/gots"},
            saved[-1][1]["mcp_servers"]["postgres"]["env"],
        )
        self.assertEqual([], env_writes)
        self.assertEqual("already-found-once", stubs["hermes_cli.config"].get_env_value("PG_PASSWORD"))

    def test_a_value_given_for_one_the_host_already_holds_replaces_it(self):
        """Typing over a value the bot holds is how the screen replaces it: the new one is written."""
        env_writes, saved = [], []
        stubs = hermes(
            catalogue=[POSTGRES],
            env={"PG_PASSWORD": "already-found-once"},
            env_writes=env_writes,
            saved=saved,
            reconcile=[],
        )
        with mock.patch.dict(sys.modules, stubs):
            servers = mcp.install(
                "bot-a", "postgres", {"PG_DATABASE": "gots", "PG_PASSWORD": "typed-over"}
            )
        self.assertEqual([("postgres", "on")], rows(servers))
        self.assertEqual([("bot-a", "PG_PASSWORD")], env_writes)
        self.assertEqual("typed-over", stubs["hermes_cli.config"].get_env_value("PG_PASSWORD"))
        # The block still carries the manifest's own ref rather than the value typed over it: what
        # the user typed reaches the profile's environment, never the configuration.
        self.assertEqual(
            {"DATABASE_URL": "postgres://user:${PG_PASSWORD}@db.example/gots"},
            saved[-1][1]["mcp_servers"]["postgres"]["env"],
        )

    def test_an_entry_the_catalogue_does_not_have_is_refused_and_nothing_is_written(self):
        cards, saved = [], []
        stubs = hermes(catalogue=[POSTGRES], cards=cards, saved=saved, reconcile=[])
        with mock.patch.dict(sys.modules, stubs):
            with self.assertRaises(mcp.McpError) as caught:
                mcp.install("bot-a", "nope", {})
        self.assertEqual(400, caught.exception.status)
        self.assertEqual([], cards)
        self.assertEqual([], saved)

    def test_an_entry_that_needs_server_access_is_added_with_its_marker(self):
        """The add writes the entry; granting Server access is its own step (the row's)."""
        entry = {
            "name": "drive",
            "transport": {"type": "http", "url": "https://drive.example/mcp"},
            "auth": {"type": "oauth"},
        }
        saved, reconcile = [], []
        stubs = hermes(catalogue=[entry], saved=saved, reconcile=reconcile)
        with mock.patch.dict(sys.modules, stubs):
            servers = mcp.install("bot-a", "drive", {})
        self.assertEqual(
            {"url": "https://drive.example/mcp", "auth": "oauth", "enabled": True},
            saved[-1][1]["mcp_servers"]["drive"],
        )
        # The bot has it, waiting on the access it hasn't been granted yet — and nothing was started.
        self.assertEqual([("drive", "needs_access")], rows(servers))
        self.assertEqual(["bot-a"], reconcile)

    def test_an_optional_value_left_out_is_added_without_it(self):
        """A manifest's optional value is not the Host's to demand: the add lands with the rest."""
        saved, env_writes, inlines = [], [], []
        stubs = hermes(catalogue=[SENTRY], saved=saved, inlines=inlines, env_writes=env_writes, reconcile=[])
        with mock.patch.dict(sys.modules, stubs):
            servers = mcp.install("bot-a", "sentry", {"SENTRY_AUTH_TOKEN": "t", "SENTRY_ORG": "gots"})
        self.assertEqual([("sentry", "on")], rows(servers))
        self.assertEqual(["bot-a"], [profile for profile, _config in saved])
        # The secret the form gave went to the profile's environment; the plain value was inlined; and
        # the optional one is nowhere, because nothing was given for it.
        self.assertEqual([("bot-a", "SENTRY_AUTH_TOKEN")], env_writes)
        self.assertEqual([("SENTRY_ORG", "gots")], inlines)

    def test_an_entry_hermes_cannot_install_surfaces_its_own_reason_and_writes_nothing(self):
        """A clone Hermes refuses while building the block is its own sentence, not an opaque 500."""
        cards, saved, env_writes, reconcile = [], [], [], []
        stubs = hermes(
            catalogue=[POSTGRES],
            cards=cards,
            card_errors={"postgres": "git clone failed for https://github.com/example/postgres-mcp"},
            saved=saved,
            env_writes=env_writes,
            reconcile=reconcile,
        )
        with mock.patch.dict(sys.modules, stubs):
            with self.assertRaises(mcp.McpError) as caught:
                mcp.install("bot-a", "postgres", {"PG_DATABASE": "gots", "PG_PASSWORD": "hunter2"})
        self.assertEqual(400, caught.exception.status)
        self.assertEqual("git clone failed for https://github.com/example/postgres-mcp", str(caught.exception))
        self.assertEqual(["postgres"], cards)
        self.assertEqual([], saved)
        self.assertEqual([], env_writes)
        self.assertEqual([], reconcile)

    def test_adding_never_connects_a_server(self):
        """``discover_mcp_tools`` is recorded and refuses: an add that reached for it fails here."""
        discovers, reconcile = [], []
        stubs = hermes(catalogue=[POSTGRES], discovers=discovers, reconcile=reconcile)
        with mock.patch.dict(sys.modules, stubs):
            servers = mcp.install("bot-a", "postgres", {"PG_DATABASE": "gots", "PG_PASSWORD": "p"})
        self.assertEqual([("postgres", "on")], rows(servers))
        self.assertEqual([], discovers)

    def test_adding_a_server_hermes_reports_failed_answers_its_row_with_the_hosts_reason(self):
        """What the screen shows after an add is the host's own answer, not the entry it just wrote."""
        stubs = hermes(
            catalogue=[POSTGRES],
            runtime={"postgres": "failed"},
            errors={"postgres": "Connection refused"},
            reconcile=[],
        )
        with mock.patch.dict(sys.modules, stubs):
            servers = mcp.install("bot-a", "postgres", {"PG_DATABASE": "gots", "PG_PASSWORD": "p"})
        self.assertEqual(
            [{"name": "postgres", "state": "failed", "enabled": True, "source": "config", "reason": "Connection refused"}],
            servers,
        )

    def test_adding_is_gated_apart_from_the_rest_of_the_screen(self):
        """Its own set of built-ins, so a host that can list, switch and browse may still not add."""
        for missing in (
            "hermes_cli.config",
            "hermes_cli.mcp_catalog",
            "hermes_cli.mcp_config",
            "hermes_cli.mcp_security",
            "hermes_cli.web_routers._common",
            "tools.mcp_tool_discovery",
        ):
            with self.subTest(missing=missing):
                stubs = hermes(servers={"srv": {"command": "npx"}}, catalogue=[POSTGRES], reconcile=[])
                stubs[missing] = None
                with mock.patch.dict(sys.modules, stubs):
                    self.assertIsInstance(mcp.addable(), str)
                    with self.assertRaises(mcp.McpError) as caught:
                        mcp.install("bot-a", "postgres", {"PG_DATABASE": "gots", "PG_PASSWORD": "p"})
                self.assertEqual(501, caught.exception.status)


if __name__ == "__main__":
    unittest.main()
