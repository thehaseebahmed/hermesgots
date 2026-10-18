"""Tests for the read, the toggle and the removal of a bot's MCP servers (``plugin/mcp.py``).

Hermes's own MCP built-ins — the profile scope, the config reader, the split between a profile's
servers and a Hermes plugin's, the cached runtime status read, the stored-access check, the
catalogue's own uninstall and the OAuth manager — are stood in for through ``sys.modules`` (the
``test_skills.py`` pattern), so each test asserts only this module's own rules: the state word each
of Hermes's states becomes, the Host's own reason on a failure, the profile scope the read or the
write ran in, what a removal takes with it, and that a host without the built-ins advertises
nothing.

Run: python3 -m unittest plugin.tests.test_mcp -v
"""

from __future__ import annotations

import contextlib
import inspect
import sys
import types
import unittest
from unittest import mock

from plugin import mcp


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

    # Hermes's own environment writer (the profile's `.env`), which a removal must not reach for: the
    # values stay so adding the server again doesn't mean finding its key a second time.
    def get_env_value(key):
        return env.get(key)

    def save_env_value(key, value):
        env_writes.append((write_scopes[-1] if write_scopes else None, key))
        env[key] = value

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

    oauth = types.ModuleType("tools.mcp_oauth_manager")
    oauth.get_manager = get_manager

    discovery = types.ModuleType("tools.mcp_tool_discovery")
    discovery.get_mcp_status = get_mcp_status
    discovery.discover_mcp_tools = _refuse("connect a server")
    discovery.reconcile_mcp_servers_with_config = reconcile_mcp_servers_with_config

    helpers = types.ModuleType("tui_gateway.mcp_rpc_helpers")
    helpers.server_configs_with_sources = server_configs_with_sources

    return {
        "hermes_cli.config": config_module,
        "hermes_cli.mcp_catalog": catalog,
        "hermes_cli.mcp_config": config,
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


class McpFeatureGateTests(unittest.TestCase):
    def test_the_hosts_built_ins_are_available(self):
        with mock.patch.dict(sys.modules, hermes()):
            self.assertIsNone(mcp.available())
            self.assertIsNone(mcp.writable())
            self.assertIsNone(mcp.removable())

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


if __name__ == "__main__":
    unittest.main()
