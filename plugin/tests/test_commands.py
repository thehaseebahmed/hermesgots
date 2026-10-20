"""The hook that records each shell command an AFK session's run executes, over a temp store.

A throwaway Hermes home with a real (empty) worktree and the plugin's own store, so a command lands
on the session's pipeline record and is read back from it — the same prior art as the gate's and the
todos' tests.

Run: python3 -m unittest plugin.tests.test_commands -v
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, Dict, List, Optional
from unittest.mock import patch

from plugin import commands, gate, pipeline, sessions
from plugin.store import db_path
from plugin.tests._helpers import staged as staged_record

SESSION = "memento-afk-commands"


class CommandTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.tree = self.home / "trees" / "afk-337"
        self.tree.mkdir(parents=True)
        sessions._upsert(
            db_path(self.home),
            SESSION,
            "p1",
            [
                {
                    "name": "mock-user/memento",
                    "repo_root": str(self.home / "checkout"),
                    "path": str(self.tree),
                    "branch": "hermes/afk-337",
                }
            ],
            "auto",
            None,
        )
        patcher = patch("plugin.sessions._paths", return_value=(db_path(self.home), self.home))
        patcher.start()
        self.addCleanup(patcher.stop)

    def staged(self, stage: str = pipeline.BUILD) -> Dict[str, Any]:
        record = staged_record(stage, steps=("plan",))
        sessions.set_pipeline(db_path(self.home), SESSION, record)
        return record

    def read(self) -> Optional[Dict[str, Any]]:
        return pipeline.read(sessions.read(db_path(self.home), SESSION)["pipeline"])

    def run_command(self, line: str, session_id: Optional[str] = SESSION) -> None:
        commands.before_tool(
            tool_name="terminal", args={"command": line}, session_id=session_id
        )

    def test_a_run_that_lints_typechecks_and_tests_has_all_three_in_order(self) -> None:
        self.staged()
        for line in ("pnpm lint", "pnpm typecheck", "pnpm test"):
            self.run_command(line)
        found = pipeline.stage_commands(self.read())
        self.assertEqual(
            [one["command"] for one in found], ["pnpm lint", "pnpm typecheck", "pnpm test"]
        )
        self.assertEqual(
            [one["checked"] for one in found],
            [False, False, False],
            "none of them is the gate's until the host has run it",
        )

    def test_it_keeps_the_most_recent_fifty_of_a_stage(self) -> None:
        self.staged()
        for index in range(pipeline.COMMAND_CAP + 10):
            self.run_command(f"step-{index}")
        found = pipeline.stage_commands(self.read())
        self.assertEqual(len(found), pipeline.COMMAND_CAP)
        self.assertEqual(found[0]["command"], "step-10", "the oldest ten fell off the cap")
        self.assertEqual(found[-1]["command"], f"step-{pipeline.COMMAND_CAP + 9}")

    def test_the_cap_is_a_stages_own_across_its_rounds(self) -> None:
        record = self.staged()
        # A loop's second round is the same stage again: its commands are capped with the first's.
        record["stages"][0]["rounds"].append(pipeline.new_round())
        record["round"] = 2
        sessions.set_pipeline(db_path(self.home), SESSION, record)
        for index in range(pipeline.COMMAND_CAP + 5):
            self.run_command(f"step-{index}")
        found = pipeline.stage_commands(self.read())
        self.assertEqual(len(found), pipeline.COMMAND_CAP)
        self.assertEqual({one["round"] for one in found}, {2}, "the first round's all fell off")

    def test_a_long_line_is_cut(self) -> None:
        self.staged()
        self.run_command("echo " + "x" * (pipeline.COMMAND_CHARS * 2))
        found = pipeline.stage_commands(self.read())
        self.assertEqual(len(found[0]["command"]), pipeline.COMMAND_CHARS)

    def test_another_tool_records_nothing(self) -> None:
        self.staged()
        commands.before_tool(tool_name="read_file", args={"path": "a"}, session_id=SESSION)
        self.assertEqual(pipeline.stage_commands(self.read()), [])

    def test_a_terminal_call_with_no_command_records_nothing(self) -> None:
        self.staged()
        commands.before_tool(tool_name="terminal", args={}, session_id=SESSION)
        commands.before_tool(tool_name="terminal", args={"command": "  "}, session_id=SESSION)
        self.assertEqual(pipeline.stage_commands(self.read()), [])

    def test_a_session_that_is_not_afk_records_nothing(self) -> None:
        # A code session without a pipeline: no stage to record a command against.
        self.run_command("pnpm test")
        self.assertIsNone(self.read())

    def test_an_unknown_session_records_nothing(self) -> None:
        self.staged()
        self.run_command("pnpm test", session_id="memento-not-a-session")
        self.assertEqual(pipeline.stage_commands(self.read()), [])

    def test_a_finished_task_records_nothing_on_its_last_stage(self) -> None:
        record = self.staged()
        record["stage"] = len(record["stages"])
        sessions.set_pipeline(db_path(self.home), SESSION, record)
        self.run_command("pnpm test")
        self.assertEqual(self.read()["stage"], len(record["stages"]), "the task is still done")

    def test_the_commands_are_kept_on_the_stage_the_run_is_in(self) -> None:
        self.staged(stage=pipeline.CRITIQUE)
        self.run_command("git diff")
        record = self.read()
        self.assertEqual(
            record["stages"][record["stage"]]["rounds"][-1]["commands"][0]["command"], "git diff"
        )
        self.assertEqual(
            [
                one
                for stage in record["stages"][: record["stage"]]
                for run in stage["rounds"]
                for one in run["commands"]
            ],
            [],
            "no earlier stage gained a command",
        )

    def test_a_command_that_goes_to_the_shell_is_recorded_with_its_line_only(self) -> None:
        self.staged()
        self.run_command("pnpm test --reporter=dot")
        found = pipeline.stage_commands(self.read())
        self.assertEqual(
            found,
            [
                {
                    "command": "pnpm test --reporter=dot",
                    "repo": None,
                    "code": None,
                    "checked": False,
                    "round": 1,
                }
            ],
            "the line, the round, and nothing of what it printed",
        )

    def test_the_gates_answer_keeps_the_commands_the_run_executed_before_it(self) -> None:
        self.staged()
        for line in ("pnpm lint", "true"):
            self.run_command(line)
        answer = json.loads(gate.handle({"commands": ["true"]}, session_id=SESSION))
        self.assertTrue(answer["passed"])
        self.assertEqual(
            [(one["command"], one["code"], one["checked"]) for one in pipeline.stage_commands(self.read())],
            [("pnpm lint", None, False), ("true", 0, True)],
            "the host's exit code lands on the line the run ran, and the rest stay the run's own",
        )


if __name__ == "__main__":
    unittest.main()
