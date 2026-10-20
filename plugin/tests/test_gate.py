"""The gate tool: the commands a build names, run on the host and answered with exit codes.

A throwaway Hermes home with a real (empty) worktree and the plugin's own store, so the tool runs
what it is given where it says it does and the answer it keeps is the one read back.

Run: python3 -m unittest plugin.tests.test_gate -v
"""

from __future__ import annotations

import json
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, Dict, Optional
from unittest.mock import patch

from plugin import gate, pipeline, sessions
from plugin.store import db_path
from plugin.tests._helpers import staged as staged_record

SESSION = "memento-afk-gate"


class GateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.tree = self.home / "trees" / "afk-265"
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
                    "branch": "hermes/afk-265",
                }
            ],
            "auto",
            None,
        )
        patcher = patch("plugin.sessions._paths", return_value=(db_path(self.home), self.home))
        patcher.start()
        self.addCleanup(patcher.stop)

    def staged(self, stage: str = pipeline.BUILD, skills=("code-review",)) -> Dict[str, Any]:
        if not skills:
            sessions.set_pipeline(db_path(self.home), SESSION, None)
            return {}
        record = staged_record(stage, steps=tuple(skills))
        sessions.set_pipeline(db_path(self.home), SESSION, record)
        return record

    def two_repos(self) -> Path:
        """A second worktree in the same session, as a project of more than one repo has."""
        other = self.home / "trees" / "afk-265-api"
        other.mkdir(parents=True, exist_ok=True)
        sessions._upsert(
            db_path(self.home),
            SESSION,
            "p1",
            [
                {
                    "name": "mock-user/memento",
                    "repo_root": str(self.home / "checkout"),
                    "path": str(self.tree),
                    "branch": "hermes/afk-265",
                },
                {
                    "name": "mock-user/memento-api",
                    "repo_root": str(self.home / "checkout-api"),
                    "path": str(other),
                    "branch": "hermes/afk-265",
                },
            ],
            "auto",
            None,
        )
        return other

    def read(self) -> Optional[Dict[str, Any]]:
        return sessions.read(db_path(self.home), SESSION)

    def call(self, args: Any, session_id: Optional[str] = SESSION) -> Dict[str, Any]:
        return json.loads(gate.handle(args, session_id=session_id))

    def test_it_answers_with_each_commands_exit_code(self) -> None:
        self.staged()
        answer = self.call({"commands": ["true", "false"]})
        self.assertEqual(
            answer["results"],
            [{"command": "true", "code": 0}, {"command": "false", "code": 1}],
        )
        self.assertFalse(answer["passed"])

    def test_it_runs_the_command_in_the_sessions_worktree(self) -> None:
        self.staged()
        self.call({"commands": ["pwd > where-i-ran"]})
        self.assertEqual(
            (self.tree / "where-i-ran").read_text().strip(),
            str(self.tree),
            "the host runs it where the build works, not where the host happens to be",
        )

    def test_a_command_that_is_not_installed_exits_non_zero(self) -> None:
        self.staged()
        answer = self.call({"commands": ["memento-no-such-command"]})
        self.assertNotEqual(answer["results"][0]["code"], 0)

    def test_the_answer_is_kept_on_the_stage_the_build_is_in(self) -> None:
        self.staged()
        self.call({"commands": ["true"]})
        found = pipeline.read(self.read()["pipeline"])
        self.assertEqual(pipeline.kind(found), pipeline.BUILD, "the build is still building")
        self.assertEqual(
            pipeline.gate_of(found)["commands"], [{"command": "true", "code": 0}]
        )

    def test_a_call_naming_no_command_is_refused(self) -> None:
        self.staged()
        for args in ({}, {"commands": []}, {"commands": [""]}, {"commands": "pnpm test"}):
            answer = self.call(args)
            self.assertIn("error", answer, f"{args} is not a gate")
        self.assertEqual(
            pipeline.kind(pipeline.read(self.read()["pipeline"])),
            pipeline.BUILD,
            "a refused call records nothing",
        )

    def test_a_session_that_is_not_staged_has_no_gate(self) -> None:
        self.staged(skills=())
        answer = self.call({"commands": ["true"]})
        self.assertIn("isn't a staged task", answer["error"])

    def test_a_review_cannot_be_gated_again(self) -> None:
        self.staged(stage=pipeline.CRITIQUE)
        answer = self.call({"commands": ["true"]})
        self.assertIn('"Review"', answer["error"], "the refusal names the stage it is in")
        self.assertIn("no gate to run", answer["error"])

    def test_a_build_can_gate_again_after_fixing_what_the_gate_named(self) -> None:
        self.staged()
        self.call({"commands": ["false"]})
        answer = self.call({"commands": ["true"]})
        self.assertEqual(answer["results"], [{"command": "true", "code": 0}], "the second answer runs")
        self.assertTrue(answer["passed"])
        self.assertEqual(
            pipeline.gate_of(pipeline.read(self.read()["pipeline"]))["commands"],
            [{"command": "true", "code": 0}],
            "the last answer is the one the host judges the build by",
        )

    def test_it_stops_at_the_first_command_that_fails(self) -> None:
        self.staged()
        answer = self.call({"commands": ["false", "sleep 10"]})
        self.assertEqual(answer["results"], [{"command": "false", "code": 1}])
        self.assertFalse(answer["passed"])

    def test_a_command_that_names_a_repo_runs_in_that_repos_worktree(self) -> None:
        other = self.two_repos()
        self.staged()
        self.call({"commands": [{"repo": "mock-user/memento-api", "command": "pwd > where-i-ran"}]})
        self.assertEqual(
            (other / "where-i-ran").read_text().strip(),
            str(other),
            "a project of more than one repo gates each repo's own work",
        )
        self.assertEqual(
            pipeline.gate_of(pipeline.read(self.read()["pipeline"]))["commands"],
            [{"command": "pwd > where-i-ran", "repo": "mock-user/memento-api", "code": 0}],
        )

    def test_a_repo_this_session_has_not_got_is_refused_before_anything_runs(self) -> None:
        self.two_repos()
        self.staged()
        answer = self.call({"commands": [{"repo": "mock-user/nope", "command": "true"}]})
        self.assertIn("no repo named mock-user/nope", answer["error"])
        self.assertEqual(
            pipeline.kind(pipeline.read(self.read()["pipeline"])),
            pipeline.BUILD,
            "a refused call runs nothing and records nothing",
        )

    def test_a_finished_pipeline_has_no_gate_either(self) -> None:
        self.staged(stage=pipeline.DONE)
        self.assertIn("error", self.call({"commands": ["true"]}))

    def test_a_session_with_no_worktree_is_refused(self) -> None:
        self.staged()
        answer = self.call({"commands": ["true"]}, session_id="memento-not-a-session")
        self.assertIn("no worktree", answer["error"])

    def test_a_command_that_hangs_is_a_failure_not_a_wait(self) -> None:
        self.staged()
        with patch.object(gate, "GATE_TIMEOUT_S", 1):
            began = time.monotonic()
            answer = self.call({"commands": ["sleep 10"]})
            waited = time.monotonic() - began
        self.assertEqual(answer["results"][0]["code"], gate.TIMED_OUT)
        self.assertFalse(answer["passed"])
        self.assertLess(waited, 5, "the call answers at its timeout, not when the command would end")


if __name__ == "__main__":
    unittest.main()
