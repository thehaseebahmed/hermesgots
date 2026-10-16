"""Setting a chat's goal: what the plugin hands Hermes, and what it hands back.

The plugin owns no goal parsing — Hermes's own ``/goal`` command does that — so these tests pin the
seam: the exact text dispatched, the budget the manager is built with, the gates, and the payload the
app reads.

Run: python3 -m unittest plugin.tests.test_goal -v
"""

from __future__ import annotations

import sys
import unittest
from types import ModuleType
from typing import Any, Dict, List, Optional
from unittest import mock

from plugin import goal


class _Contract:
    def __init__(self, **fields: str) -> None:
        self.outcome = fields.get("outcome", "")
        self.verification = fields.get("verification", "")
        self.constraints = fields.get("constraints", "")
        self.boundaries = fields.get("boundaries", "")
        self.stop_when = fields.get("stop_when", "")


class _Gate:
    def __init__(self, command: str, exit_code: Optional[int] = None) -> None:
        self.command = command
        self.timeout_seconds = 600
        self.max_retries = 2
        self.attempts = 0
        self.last_exit_code = exit_code
        self.last_output_tail = ""


class _State:
    def __init__(self, text: str, **overrides: Any) -> None:
        self.goal = text
        self.status = "active"
        self.turns_used = 0
        self.max_turns = 20
        self.subgoals: List[str] = []
        self.contract = _Contract()
        self.gates: List[_Gate] = []
        self.last_verdict = None
        self.last_reason = None
        self.paused_reason = None
        self.waiting_reason = None
        for key, value in overrides.items():
            setattr(self, key, value)


class _Manager:
    """Stands in for ``hermes_cli.goals.GoalManager``: it records how it was built."""

    built: List[Dict[str, Any]] = []

    def __init__(self, session_id: str, *, default_max_turns: Optional[int] = None) -> None:
        self.session_id = session_id
        self.default_max_turns = default_max_turns
        self.state: Optional[_State] = None
        _Manager.built.append({"session_id": session_id, "default_max_turns": default_max_turns})

    def set(self, text: str, **_: Any) -> _State:
        self.state = _State(text, max_turns=self.default_max_turns or 20)
        return self.state

    def add_gate(self, command: str) -> _Gate:
        gate = _Gate(command)
        assert self.state is not None
        self.state.gates.append(gate)
        return gate

    def pause(self, reason: str = "user-paused") -> _State:
        assert self.state is not None
        self.state.status, self.state.paused_reason = "paused", reason
        return self.state

    def resume(self, **_: Any) -> _State:
        assert self.state is not None
        self.state.status = "active"
        return self.state

    def clear(self) -> None:
        self.state = None

    def next_continuation_prompt(self) -> str:
        return "[Continuing toward your standing goal] carry on"


class _Result:
    def __init__(self, output: str = "", prompt: Optional[str] = None, error: bool = False) -> None:
        self.output = output
        self.prompt = prompt
        self.error = error
        self.kickoff = not error
        self.clear_pending = None


def dispatch(manager: _Manager, arg: str, *, authorize_gate: Any, **_: Any) -> _Result:
    """Stands in for Hermes's own dispatcher: records, then applies the two shapes the plugin uses.

    A faithful parser is Hermes's job, so this checks only that the plugin reaches it with the right
    text — the real one is what runs on a host.
    """
    dispatched.append(arg)
    refused = authorize_gate()
    if refused:
        return _Result(refused, error=True)
    if arg.startswith("-- "):
        manager.set(arg[len("-- "):])
        return _Result("⊙ Goal set", prompt="[goal] work on it")
    if arg.startswith("gate add "):
        if arg.endswith("nope"):
            return _Result("/goal gate add: that command isn't allowed.", error=True)
        manager.add_gate(arg[len("gate add "):])
        return _Result("✓ Gate added")
    if arg == "resume":
        return _Result("▶ Goal resumed: Fix the login bug", prompt=manager.next_continuation_prompt())
    return _Result(f"⊙ /goal {arg}")


dispatched: List[str] = []


def hermes(manager_class: Any = _Manager) -> Any:
    """A patch of the two Hermes modules ``goal`` imports at call time."""
    goals = ModuleType("hermes_cli.goals")
    goals.GoalManager = manager_class
    goals.DEFAULT_MAX_TURNS = 20
    goals.goal_kick_prompt = lambda text, last=None: f"[goal] {text}"
    command = ModuleType("hermes_cli.goal_command")
    command.dispatch_goal_command = dispatch
    parent = ModuleType("hermes_cli")
    parent.goals, parent.goal_command = goals, command
    return mock.patch.dict(
        sys.modules,
        {"hermes_cli": parent, "hermes_cli.goals": goals, "hermes_cli.goal_command": command},
    )


class Budget(unittest.TestCase):
    def test_a_budget_is_a_whole_number_of_turns(self):
        self.assertEqual(goal.clean_max_turns(5), 5)
        self.assertEqual(goal.clean_max_turns(" 12 "), 12)

    def test_no_budget_keeps_the_hosts_default(self):
        self.assertIsNone(goal.clean_max_turns(None))
        self.assertIsNone(goal.clean_max_turns(""))

    def test_a_nonsense_budget_is_refused(self):
        for value in (0, -1, goal.MAX_TURNS + 1, "soon", 1.5, True):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    goal.clean_max_turns(value)


class Gates(unittest.TestCase):
    def test_gates_are_trimmed_and_kept_in_order(self):
        self.assertEqual(goal.clean_gates([" pnpm test ", "pnpm lint"]), ["pnpm test", "pnpm lint"])

    def test_no_gates_is_an_empty_list(self):
        self.assertEqual(goal.clean_gates(None), [])
        self.assertEqual(goal.clean_gates([]), [])

    def test_a_gate_is_a_shell_command(self):
        for value in ("pnpm test", ["", " ", 7, None], {"command": "pnpm test"}):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    goal.clean_gates(value)

    def test_only_the_first_ten_gates_are_kept(self):
        self.assertEqual(len(goal.clean_gates([f"step {i}" for i in range(14)])), 10)


class Apply(unittest.TestCase):
    def setUp(self):
        dispatched.clear()
        _Manager.built.clear()

    def apply(self, **kwargs: Any) -> Dict[str, Any]:
        with hermes():
            return goal.apply("memento-1", kwargs.pop("command", "Fix the login bug"), **kwargs)

    def test_the_wizards_text_goes_to_hermes_verbatim(self):
        text = "Fix the login bug\noutcome: signing in works\nverify: pnpm test passes"
        found = self.apply(command=text)
        self.assertEqual(dispatched, [f"-- {text}"])
        self.assertEqual(found["kick"], "[goal] work on it")

    def test_the_budget_reaches_the_goal_itself(self):
        found = self.apply(max_turns=7)
        self.assertEqual(_Manager.built[0]["default_max_turns"], 7)
        self.assertEqual(found["goal"]["max_turns"], 7)

    def test_without_a_budget_the_host_decides(self):
        self.apply()
        self.assertEqual(_Manager.built[0], {"session_id": "memento-1", "default_max_turns": 20})

    def test_each_gate_is_added_in_order(self):
        found = self.apply(gates=["pnpm test", "pnpm lint"])
        self.assertEqual(dispatched[1:], ["gate add pnpm test", "gate add pnpm lint"])
        self.assertEqual([g["command"] for g in found["goal"]["gates"]], ["pnpm test", "pnpm lint"])

    def test_the_goal_the_app_reads_back_is_the_managers(self):
        found = self.apply()
        self.assertEqual(found["goal"]["goal"], "Fix the login bug")
        self.assertEqual(found["goal"]["status"], "active")

    def test_an_empty_goal_is_refused_before_hermes_is_reached(self):
        with self.assertRaises(goal.GoalError) as refused:
            self.apply(command="   ")
        self.assertEqual(refused.exception.status, 400)
        self.assertEqual(dispatched, [])

    def test_a_goal_hermes_refuses_comes_back_as_the_message(self):
        with hermes():
            with self.assertRaises(goal.GoalError) as refused:
                goal.apply("memento-1", "Fix the login bug", gates=["something nope"])
        self.assertEqual(refused.exception.status, 400)
        self.assertIn("isn't allowed", str(refused.exception))

    def test_a_host_without_a_goal_command_says_so(self):
        with mock.patch.object(goal, "_hermes", side_effect=goal.GoalError("no /goal here", 501)):
            with self.assertRaises(goal.GoalError) as refused:
                goal.apply("memento-1", "Fix the login bug")
        self.assertEqual(refused.exception.status, 501)


class Control(unittest.TestCase):
    def setUp(self):
        dispatched.clear()

    def test_the_three_actions_are_dispatched_by_name(self):
        for action in goal.ACTIONS:
            with self.subTest(action=action):
                dispatched.clear()
                with hermes():
                    goal.control("memento-1", action)
                self.assertEqual(dispatched, [action])

    def test_resuming_carries_the_continuation_prompt(self):
        with hermes():
            found = goal.control("memento-1", "resume")
        self.assertEqual(found["kick"], "[Continuing toward your standing goal] carry on")

    def test_anything_else_is_refused(self):
        with self.assertRaises(goal.GoalError) as refused:
            goal.control("memento-1", "delete")
        self.assertEqual(refused.exception.status, 400)


class View(unittest.TestCase):
    def test_a_session_without_a_goal_has_none(self):
        with hermes():
            self.assertIsNone(goal.read("memento-1")["goal"])

    def test_the_app_reads_the_contract_gates_and_verdict(self):
        state = _State(
            "Ship the routines screen",
            turns_used=3,
            max_turns=12,
            contract=_Contract(outcome="shipped", boundaries="app/src"),
            gates=[_Gate("pnpm test", exit_code=0), _Gate("pnpm lint", exit_code=1)],
            last_verdict="continue",
            last_reason="the screen still misses the empty state",
            waiting_reason="CI run 41",
        )
        found = goal.view(state)
        self.assertEqual(found["turns_used"], 3)
        self.assertEqual(found["max_turns"], 12)
        self.assertEqual(found["contract"]["outcome"], "shipped")
        self.assertEqual(found["contract"]["verification"], "")
        self.assertEqual(
            [(g["command"], g["passing"]) for g in found["gates"]], [("pnpm test", True), ("pnpm lint", False)]
        )
        self.assertEqual(found["verdict"], "continue")
        self.assertIn("empty state", found["reason"])
        self.assertEqual(found["waiting"], "CI run 41")


class Available(unittest.TestCase):
    def test_a_host_without_the_goal_command_says_why(self):
        with mock.patch.dict(sys.modules, {"hermes_cli": None}):
            self.assertIn("/goal", goal.available() or "")

    def test_a_host_with_it_is_ready(self):
        with hermes():
            self.assertIsNone(goal.available())


if __name__ == "__main__":
    unittest.main()
