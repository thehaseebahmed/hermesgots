"""Tests for the read of a bot's MCP servers (``plugin/mcp.py``).

Hermes's own MCP built-ins — the profile scope, the config reader, the split between a profile's
servers and a Hermes plugin's, the cached runtime status read, and the stored-access check — are
stood in for through ``sys.modules`` (the ``test_skills.py`` pattern), so each test asserts only
this module's own rules: the state word each of Hermes's states becomes, the Host's own reason on a
failure, the profile scope the read ran in, and that a host without the built-ins advertises
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


def hermes(servers=None, runtime=None, errors=None, plugin_servers=None, owners=None, tokens=None):
    """Hermes's MCP built-ins for one test, faked the way the module imports them.

    ``servers`` is the profile's ``mcp_servers`` block as ``_get_mcp_servers`` answers it.
    ``runtime`` is name -> the status word ``get_mcp_status`` reports (``connected``, ``lazy``,
    ``configured``, ``connecting``, ``failed``, ``disabled``); a name it doesn't carry is reported
    ``configured``, which is how Hermes reports a server it has no runtime state for. ``errors`` is
    the Host's own text for a failed one. ``plugin_servers``/``owners`` are what a Hermes plugin
    provides through its own ``mcp.json``; ``tokens`` names the servers with stored Server access.

    The scopes the read enters land on ``hermes_cli.web_server_profiles``'s ``scopes``, so a test
    can assert which profile's the read ran in. ``discover_mcp_tools`` and
    ``reconcile_mcp_servers_with_config`` are present and refuse: a read that reached for one to
    start or stop a server fails the test instead of quietly connecting something.
    """

    scopes = []

    @contextlib.contextmanager
    def _config_profile_scope(profile):
        scopes.append(profile)
        yield

    runtime = dict(runtime or {})
    errors = dict(errors or {})
    access = set(tokens or ())

    def _get_mcp_servers():
        return {name: dict(cfg) for name, cfg in (servers or {}).items()}

    def server_configs_with_sources(config_servers):
        """Hermes's split: the profile's own servers, plus the ones a plugin provides."""
        found = {name: dict(cfg) for name, cfg in config_servers.items()}
        found_owners = {name: None for name in found}
        for name, cfg in (plugin_servers or {}).items():
            if name not in found:
                found[name] = dict(cfg)
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

    def _refuse(what):
        def refuse(*_args, **_kwargs):
            raise AssertionError(f"the read must not {what}")

        return refuse

    config = types.ModuleType("hermes_cli.mcp_config")
    config._get_mcp_servers = _get_mcp_servers
    config._oauth_tokens_present = _oauth_tokens_present

    profiles = types.ModuleType("hermes_cli.web_server_profiles")
    profiles._config_profile_scope = _config_profile_scope
    profiles.scopes = scopes

    discovery = types.ModuleType("tools.mcp_tool_discovery")
    discovery.get_mcp_status = get_mcp_status
    discovery.discover_mcp_tools = _refuse("connect a server")
    discovery.reconcile_mcp_servers_with_config = _refuse("reconcile servers")

    helpers = types.ModuleType("tui_gateway.mcp_rpc_helpers")
    helpers.server_configs_with_sources = server_configs_with_sources

    return {
        "hermes_cli.mcp_config": config,
        "hermes_cli.web_server_profiles": profiles,
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
                {"name": "alpha", "state": "on", "source": "config", "reason": None},
                {"name": "mid", "state": "off", "source": "config", "reason": None},
                {"name": "zeta", "state": "on", "source": "config", "reason": None},
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
            [{"name": "drive", "state": "needs_access", "source": "config", "reason": None}], found
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
            [{"name": "drive", "state": "on", "source": "config", "reason": None}], found
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
            {"name": "theirs", "state": "plugin", "source": "plugin", "reason": None},
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
            {"name": "theirs", "state": "plugin", "source": "plugin", "reason": None}, found[0]
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


class McpFeatureGateTests(unittest.TestCase):
    def test_the_hosts_built_ins_are_available(self):
        with mock.patch.dict(sys.modules, hermes()):
            self.assertIsNone(mcp.available())

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
