"""Tests for a page's Query answered by a local MCP server (``plugin/mcp_call.py``).

Hermes's config built-ins and the MCP SDK are stood in for through ``sys.modules``.

Run: python3 -m unittest plugin.tests.test_mcp_call -v
"""

from __future__ import annotations

import asyncio
import contextlib
import sys
import types
import unittest
from unittest import mock

from plugin import mcp, mcp_call


def install(servers, opened=None, answer=None, hang=False, fail=None, issues=()):
    opened = opened if opened is not None else []
    scopes = []

    @contextlib.contextmanager
    def scope(profile):
        scopes.append(profile)
        yield

    def module(name, **attrs):
        made = types.ModuleType(name)
        made.__dict__.update(attrs)
        return made

    class Session:
        def __init__(self, read, write):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            opened.append("closed")

        async def initialize(self):
            if fail:
                raise fail

        async def call_tool(self, tool, args):
            opened.append((tool, args))
            if hang:
                await asyncio.sleep(60)
            return answer

    @contextlib.asynccontextmanager
    async def stdio_client(params):
        opened.append(params.command)
        yield None, None

    class Params:
        def __init__(self, command, args, env):
            self.command, self.args, self.env = command, args, env

    fakes = {
        "hermes_cli": module("hermes_cli"),
        "hermes_cli.web_server_profiles": module("a", _config_profile_scope=scope),
        "hermes_cli.mcp_config": module(
            "b", _get_mcp_servers=lambda: servers, _resolve_mcp_server_config=lambda c: dict(c)
        ),
        "hermes_cli.mcp_security": module("e", validate_mcp_server_entry=lambda n, c: list(issues)),
        "tui_gateway": module("tui_gateway"),
        "tui_gateway.mcp_rpc_helpers": module("c", server_configs_with_sources=lambda s: (s, {})),
        "mcp": module("mcp", ClientSession=Session, StdioServerParameters=Params),
        "mcp.client": module("mcp.client"),
        "mcp.client.stdio": module("d", stdio_client=stdio_client),
    }
    return mock.patch.dict(sys.modules, fakes), scopes


def result(structured=None, texts=(), error=False):
    return types.SimpleNamespace(
        structuredContent=structured,
        content=[types.SimpleNamespace(text=t) for t in texts],
        isError=error,
    )


class Call(unittest.TestCase):
    def run_call(self, servers, name="home.light", args=None, timeout=5, **kw):
        patch, scopes = install(servers, **kw)
        with patch:
            return mcp_call.call("p", name, args or {}, timeout=timeout), scopes

    def test_a_tool_on_a_local_server_answers_its_structured_value(self) -> None:
        opened = []
        value, scopes = self.run_call(
            {"home": {"command": "serve"}}, args={"id": 1}, opened=opened,
            answer=result({"on": True}),
        )
        self.assertEqual(value, {"on": True})
        self.assertEqual(scopes, ["p"])
        self.assertEqual(opened, ["serve", ("light", {"id": 1}), "closed"])

    def test_a_text_answer_is_read_as_json_where_it_is(self) -> None:
        value, _ = self.run_call({"home": {"command": "s"}}, answer=result(texts=['{"a": 1}']))
        self.assertEqual(value, {"a": 1})
        value, _ = self.run_call({"home": {"command": "s"}}, answer=result(texts=["warm"]))
        self.assertEqual(value, "warm")

    def test_a_second_call_opens_its_own_session(self) -> None:
        opened = []
        for _ in range(2):
            self.run_call({"home": {"command": "s"}}, opened=opened, answer=result({}))
        self.assertEqual(opened.count("s"), 2)

    def refused(self, servers, text, name="home.light", status=502, **kw):
        with self.assertRaises(mcp.McpError) as caught:
            self.run_call(servers, name=name, **kw)
        self.assertEqual(caught.exception.status, status)
        self.assertIn(text, str(caught.exception))

    def test_a_missing_server_is_refused_with_a_reason(self) -> None:
        self.refused({}, "no MCP server named 'home'")

    def test_an_off_server_is_refused_with_a_reason(self) -> None:
        self.refused({"home": {"command": "s", "enabled": False}}, "is off")

    def test_a_remote_oauth_server_is_refused_without_connecting(self) -> None:
        opened = []
        self.refused(
            {"home": {"url": "https://x", "auth": "oauth"}}, "OAuth-authenticated remote", opened=opened
        )
        self.assertEqual(opened, [])

    def test_a_block_hermes_rejects_is_never_run(self) -> None:
        opened = []
        self.refused({"home": {"command": "s"}}, "not safe to run: bad", issues=["bad"], opened=opened)
        self.assertEqual(opened, [])

    def test_a_name_without_a_server_is_refused(self) -> None:
        self.refused({}, "<server>.<tool>", name="light", status=400)

    def test_a_failing_tool_is_refused_with_its_text(self) -> None:
        self.refused({"home": {"command": "s"}}, "boom", answer=result(texts=["boom"], error=True))

    def test_a_server_that_dies_on_start_is_refused_not_raised(self) -> None:
        self.refused({"home": {"command": "s"}}, "failed: dead", fail=RuntimeError("dead"))

    def test_a_server_that_hangs_is_cut_off(self) -> None:
        self.refused({"home": {"command": "s"}}, "did not answer", hang=True, answer=result({}), timeout=0.05)

    def test_a_host_without_the_sdk_answers_501(self) -> None:
        patch, _ = install({"home": {"command": "s"}})
        with patch, mock.patch.dict(sys.modules, {"mcp.client.stdio": None}):
            with self.assertRaises(mcp.McpError) as caught:
                mcp_call.call("p", "home.light", {})
        self.assertEqual(caught.exception.status, 501)


if __name__ == "__main__":
    unittest.main()
