"""Delegations run beside the turn that started them.

Hermes dispatches a keyed ``/v1/runs`` delegation in the background and hands the model a handle, so
the turn carries on and a question or an approval raised in it reaches the user while the subagents
still work. The plugin used to take that away by swapping every agent's delegate dispatch for one
that called ``delegate_task(background=False)``. These tests pin the plugin's side from outside: the
wiring it hands Hermes at ``register`` leaves a built agent's delegation to core, and ``info`` — the
contract the app reads — stops advertising the override.

That a question really reaches the user mid-delegation is the app's end-to-end flow
(``app/scripts/e2e/question-during-delegation.mjs``, ticket #471): the composer replacing itself while
a child still runs is a timing only a browser can measure.

Run: python3 -m unittest plugin.tests.test_delegation -v
"""

from __future__ import annotations

import asyncio
import sys
import unittest
from types import ModuleType
from typing import Any, Dict, List
from unittest import mock

import plugin
from plugin import approvals, meetings, research, sessions
from plugin.tests._helpers import App, Context, FakeWeb, Router

HANDLE = {"handle": "subagent-1"}
HELD_BY_THE_TURN = {"result": "the child's own answer"}


class Agent:
    """An agent the API server builds, delegating through Hermes's own dispatch: the tool's
    ``background`` default is what it gets, so the model is handed a handle."""

    session_id = "memento-1"

    def __init__(self, delegate: Any) -> None:
        self._delegate = delegate

    def _dispatch_delegate_task(self, function_args: Dict[str, Any]) -> Any:
        return self._delegate(goal=function_args.get("goal"), parent_agent=self)


class Adapter:
    """The API server's agent factory, and the auth check its routes ask first."""

    def __init__(self, delegate: Any) -> None:
        self._delegate = delegate

    def _check_auth(self, request: Any) -> None:
        return None

    def _create_agent(self, *args: Any, **kwargs: Any) -> Agent:
        return Agent(self._delegate)


class DelegationTest(unittest.TestCase):
    def setUp(self) -> None:
        # What the host's ``delegate_task`` is: a background call answers a handle, a synchronous one
        # the child's own result.
        self.calls: List[Dict[str, Any]] = []

        def delegate_task(goal=None, context=None, tasks=None, background=True, parent_agent=None):
            self.calls.append({"goal": goal, "background": background})
            return HANDLE if background else HELD_BY_THE_TURN

        delegate_tool = ModuleType("tools.delegate_tool")
        delegate_tool.delegate_task = delegate_task
        delegate_tool._strip_model_hidden_task_fields = lambda tasks: tasks
        tools = ModuleType("tools")
        tools.delegate_tool = delegate_tool

        # ``_wire_api_server`` imports aiohttp and probes ``tools.delegate_tool`` when it runs, and
        # neither is on a test machine's path: plant both, as the suite's harness trap says.
        aiohttp = ModuleType("aiohttp")
        aiohttp.web = FakeWeb()
        planted = {
            "tools": tools,
            "tools.delegate_tool": delegate_tool,
            "aiohttp": aiohttp,
            "aiohttp.web": aiohttp.web,
        }
        wiring = mock.patch.dict(sys.modules, planted)
        wiring.start()
        self.addCleanup(wiring.stop)

        # The wiring keeps the adapter on these modules, which other tests set for themselves: hand
        # them back as they were.
        for module in (sessions, approvals, research, meetings):
            held = getattr(module, "adapter", None)
            self.addCleanup(setattr, module, "adapter", held)

        self.app, self.adapter = App(), Adapter(delegate_task)
        context = Context()
        plugin.register(context)
        context.platforms["api_server"](self.app, self.adapter)

    def route(self, path: str) -> Any:
        for _method, registered, handler in self.app.router.added:
            if registered == path:
                return handler
        raise AssertionError(f"the plugin registered no {path}")

    def test_a_delegation_runs_beside_the_turn(self) -> None:
        agent = self.adapter._create_agent(session_id="memento-1")
        answer = agent._dispatch_delegate_task({"goal": "plan the auth refactor"})
        self.assertEqual(answer, HANDLE, "the model was parked until the child finished")
        self.assertEqual(self.calls, [{"goal": "plan the auth refactor", "background": True}])

    def test_info_does_not_advertise_sync_delegation(self) -> None:
        info = self.route(plugin.PREFIX + "/info")
        request = FakeWeb.Request()
        request.match_info, request.headers = {}, {}
        answer = asyncio.run(info(request))
        self.assertEqual(answer["status"], 200)
        self.assertNotIn("sync_delegation", answer["payload"]["features"])
        # The module's remaining job is still advertised: the app lists a session's children.
        self.assertIn("agents", answer["payload"]["features"])


if __name__ == "__main__":
    unittest.main()
