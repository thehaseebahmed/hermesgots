"""The staged pipeline's rule: which stage comes next, and where it stalls.

No host, no GitHub and no browser: ``pipeline.advance`` takes the session's record, whether the run
ended, the gate's answer and the worktree's state, so every branch of the rule is a value here.

Run: python3 -m unittest plugin.tests.test_pipeline -v
"""

from __future__ import annotations

import unittest
from typing import Any, Dict, List

from plugin import pipeline
from plugin.pipeline import BUILD, CRITIQUE, DONE, GATE


def tree(changed: int = 0, ahead: int = 1) -> List[Dict[str, Any]]:
    """A worktree as ``ship.status`` reports it: what is uncommitted and what is committed."""
    return [{"name": "mock-user/memento", "changed": changed, "ahead": ahead}]


def gate(*codes: int) -> List[Dict[str, Any]]:
    """The commands a build named, with the exit codes the host read from them."""
    return [{"command": f"step-{index}", "code": code} for index, code in enumerate(codes)]


class StartTests(unittest.TestCase):
    def test_no_critique_skill_is_no_pipeline(self) -> None:
        self.assertIsNone(
            pipeline.start(None, []), "a build skill alone is one run, exactly as it was before"
        )

    def test_a_critique_skill_starts_the_task_at_its_build(self) -> None:
        record = pipeline.start(None, ["code-review"])
        self.assertEqual(record["stage"], BUILD)
        self.assertEqual(record["critique_skills"], ["code-review"])
        self.assertIsNone(record["gate"], "nothing has been gated yet")
        self.assertIsNone(record["reason"])

    def test_the_skills_are_kept_once_each_and_named(self) -> None:
        record = pipeline.start(None, ["code-review", " ", "code-review", None, "log-triage"])
        self.assertEqual(record["critique_skills"], ["code-review", "log-triage"])


class ReadTests(unittest.TestCase):
    def test_a_row_without_a_pipeline_is_not_staged(self) -> None:
        for value in (None, "", [], {}, {"stage": "testing"}, {"critique_skills": ["x"]}):
            self.assertIsNone(pipeline.read(value))
        self.assertFalse(pipeline.gating(pipeline.read(None)))

    def test_a_record_reads_back_with_its_gate(self) -> None:
        record = pipeline.start(None, ["x"])
        found = pipeline.read(pipeline.gated(record, gate(0)))
        self.assertEqual(found["stage"], GATE)
        self.assertEqual(found["gate"]["commands"], [{"command": "step-0", "code": 0}])

    def test_a_hand_written_gate_reads_as_none(self) -> None:
        found = pipeline.read({"stage": BUILD, "critique_skills": ["x"], "gate": "yes"})
        self.assertIsNone(found["gate"], "a gate that isn't a block is no answer at all")

    def test_a_row_whose_list_was_hand_edited_to_a_string_names_no_skills(self) -> None:
        found = pipeline.read(
            {"stage": "build", "critique_skills": "code-review", "build_skill": "plan"}
        )
        self.assertEqual(
            found["critique_skills"], [], "a string is not read one character at a time"
        )
        self.assertEqual(found["build_skill"], "plan", "and the rest of the row still reads")


class ShipTests(unittest.TestCase):
    def test_a_build_cannot_ship_and_the_gate_still_belongs_to_it(self) -> None:
        record = pipeline.start(None, ["x"])
        self.assertTrue(pipeline.gating(record))
        self.assertTrue(pipeline.gating(pipeline.gated(record, gate(0))))

    def test_a_critique_ships(self) -> None:
        record = {**pipeline.start(None, ["x"]), "stage": CRITIQUE}
        self.assertFalse(pipeline.gating(record))

    def test_a_session_that_is_not_staged_ships_as_it_always_did(self) -> None:
        self.assertFalse(pipeline.gating(None))


class BuildTests(unittest.TestCase):
    def setUp(self) -> None:
        self.record = pipeline.start(None, ["code-review"])

    def step(self, record: Any = None, **kwargs: Any) -> pipeline.Step:
        return pipeline.advance(self.record if record is None else record, **kwargs)

    def test_a_build_that_passed_its_gate_is_critiqued(self) -> None:
        step = self.step(pipeline.gated(self.record, gate(0)), worktree=tree())
        self.assertEqual(step.stage, CRITIQUE, "reaching the critique is what starts it")
        self.assertEqual(step.stage, CRITIQUE, "and the task is recorded as being in it")
        self.assertIsNone(step.stall)

    def test_a_build_that_never_ran_the_gate_stalls(self) -> None:
        step = self.step(worktree=tree())
        self.assertEqual(step.stall, pipeline.NO_GATE)
        self.assertEqual(step.stage, GATE, "nothing is critiqued that was never gated")
        self.assertEqual(step.stage, GATE, "the task is at the gate it never passed")

    def test_the_failing_command_is_named(self) -> None:
        step = self.step(pipeline.gated(self.record, gate(0, 2)), worktree=tree())
        self.assertEqual(step.stall, "The gate failed: step-1 exited 2.")

    def test_the_tree_has_to_be_committed(self) -> None:
        step = self.step(pipeline.gated(self.record, gate(0)), worktree=tree(changed=3))
        self.assertEqual(step.stall, pipeline.UNCOMMITTED)
        self.assertEqual(step.stage, GATE)

    def test_there_have_to_be_commits_beyond_the_base(self) -> None:
        step = self.step(pipeline.gated(self.record, gate(0)), worktree=tree(ahead=0))
        self.assertEqual(step.stall, pipeline.NO_COMMITS)
        self.assertEqual(step.stage, GATE)

    def test_a_greened_tree_with_nothing_committed_stalls_rather_than_shipping_emptily(self) -> None:
        step = self.step(pipeline.gated(self.record, gate(0)), worktree=())
        self.assertEqual(step.stall, pipeline.NO_COMMITS)

    def test_any_repo_uncommitted_fails_the_gate_of_a_project_that_spans_them(self) -> None:
        worktree = [*tree(), {"name": "o/api", "changed": 1, "ahead": 0}]
        step = self.step(pipeline.gated(self.record, gate(0)), worktree=worktree)
        self.assertEqual(step.stall, pipeline.UNCOMMITTED)

    def test_a_build_run_that_failed_keeps_its_stage_and_says_why(self) -> None:
        step = self.step(self.record, stopped="The run failed.", worktree=tree())
        self.assertEqual(step.stage, BUILD, "the build is where it stopped")
        self.assertEqual(step.stall, "The run failed.")

    def test_a_run_that_stopped_at_the_gate_keeps_the_gate(self) -> None:
        record = pipeline.gated(self.record, gate(0))
        step = self.step(record, stopped="The run was interrupted.")
        self.assertEqual(step.stage, GATE)
        self.assertEqual(step.stall, "The run was interrupted.")

    def test_a_build_that_was_gated_and_then_fell_over_is_not_critiqued(self) -> None:
        record = pipeline.gated(self.record, gate(0))
        step = self.step(record, stopped="The run failed.", worktree=tree())
        self.assertEqual(step.stage, GATE)


class CritiqueTests(unittest.TestCase):
    def test_a_critique_that_finished_ends_the_pipeline(self) -> None:
        record = {**pipeline.start(None, ["code-review"]), "stage": CRITIQUE}
        step = pipeline.advance(record)
        self.assertEqual(step.stage, DONE)
        self.assertIsNone(step.stall)

    def test_a_finished_pipeline_stays_finished(self) -> None:
        record = {**pipeline.start(None, ["code-review"]), "stage": DONE}
        self.assertEqual(pipeline.advance(record).stage, DONE)

    def test_a_critique_that_failed_stalls(self) -> None:
        record = {**pipeline.start(None, ["code-review"]), "stage": CRITIQUE}
        step = pipeline.advance(record, stopped="The run failed.")
        self.assertEqual(step.stall, "The run failed.")
        self.assertEqual(step.stage, CRITIQUE)


class MoveTests(unittest.TestCase):
    def test_a_step_writes_its_stage_and_its_reason(self) -> None:
        record = pipeline.start(None, ["code-review"])
        stalled = pipeline.moved(record, pipeline.advance(record))
        self.assertEqual(stalled["stage"], GATE)
        self.assertEqual(stalled["reason"], pipeline.NO_GATE)
        gated = pipeline.gated(record, gate(0))
        moved_on = pipeline.moved(gated, pipeline.advance(gated, worktree=tree()))
        self.assertEqual(moved_on["stage"], CRITIQUE)
        self.assertIsNone(moved_on["reason"], "a stalled reason doesn't outlive the stage it was in")


if __name__ == "__main__":
    unittest.main()
