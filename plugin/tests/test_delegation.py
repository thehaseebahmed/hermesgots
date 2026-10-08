"""Keeping an API server agent's delegations in its turn.

Run: python3 -m unittest plugin.tests.test_delegation -v
"""

from __future__ import annotations

import unittest
from unittest import mock

from plugin import delegation


def delegate(goal=None, context=None, tasks=None, background=None, parent_agent=None):
    return {"goal": goal, "tasks": tasks, "background": background, "parent": parent_agent}


class Agent:
    def _dispatch_delegate_task(self, function_args):
        return "background"


class DelegationTest(unittest.TestCase):
    def test_runs_in_the_turn(self) -> None:
        agent = Agent()
        with mock.patch.object(delegation, "_delegate", return_value=delegate):
            delegation.equip(agent)
            result = agent._dispatch_delegate_task({"goal": "plan", "output_schema": {}})
        self.assertEqual(result, {"goal": "plan", "tasks": None, "background": False, "parent": agent})

    def test_wraps_once(self) -> None:
        agent = Agent()
        with mock.patch.object(delegation, "_delegate", return_value=delegate):
            delegation.equip(agent)
            first = agent._dispatch_delegate_task
            delegation.equip(agent)
        self.assertIs(agent._dispatch_delegate_task, first)

    def test_leaves_a_hermes_without_background_alone(self) -> None:
        agent = Agent()
        with mock.patch.object(delegation, "_delegate", return_value=None):
            delegation.equip(agent)
        self.assertEqual(agent._dispatch_delegate_task({}), "background")


if __name__ == "__main__":
    unittest.main()
