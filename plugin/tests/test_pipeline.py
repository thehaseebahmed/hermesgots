"""The staged task's record: the snapshot it starts with, the step each stage is judged as, and
where a run leaves it.

No host, no GitHub and no browser: every branch here is a value — a snapshot, a gate's answer, the
worktree's state — so the record is tested where it lives, with no store and no session.

Run: python3 -m unittest plugin.tests.test_pipeline -v
"""

from __future__ import annotations

import unittest
from typing import Any, Dict, List

from plugin import pipeline, workflows
from plugin.pipeline import BUILD, CRITIQUE, DONE, GATE_CHECK
from plugin.tests._helpers import staged

WORKFLOW: Dict[str, Any] = {
    "id": "wf-test",
    "name": "Build · Test · Review",
    "stages": workflows.from_skills("plan", ["code-review"]),
}
ONCE: Dict[str, Any] = {
    "id": "preset:one-run",
    "name": "One run",
    "stages": [
        {"name": "Build", "steps": [], "check": None, "loop": None, "ships": True},
    ],
}


def tree(changed: int = 0, ahead: int = 1) -> List[Dict[str, Any]]:
    """A worktree as ``ship.status`` reports it: what is uncommitted and what is committed."""
    return [{"name": "mock-user/memento", "changed": changed, "ahead": ahead}]


def gate(*codes: int) -> List[Dict[str, Any]]:
    """The commands a build named, with the exit codes the host read from them."""
    return [{"command": f"step-{index}", "code": code} for index, code in enumerate(codes)]


class StartTests(unittest.TestCase):
    def test_the_snapshot_is_the_workflow_it_started_under(self) -> None:
        record = pipeline.start(WORKFLOW)
        self.assertEqual(record["workflow"]["id"], "wf-test")
        self.assertEqual(
            [stage["name"] for stage in record["stages"]],
            ["Build", "Test", "Review"],
        )
        self.assertEqual(record["stages"][0]["steps"], ["plan"], "the build follows its skill")
        self.assertEqual(record["stages"][2]["steps"], ["code-review"])
        self.assertTrue(record["stages"][2]["ships"], "Review is the stage that ships")

    def test_it_starts_at_the_first_stage_of_its_first_round(self) -> None:
        record = pipeline.start(WORKFLOW)
        self.assertEqual(record["stage"], 0)
        self.assertEqual(record["round"], 1)
        self.assertEqual(record["stages"][0]["state"], pipeline.CURRENT)
        self.assertEqual(record["stages"][0]["rounds"], [pipeline.new_round()])
        self.assertEqual(record["stages"][1]["state"], pipeline.TODO)
        self.assertEqual(record["stages"][1]["rounds"], [], "a stage nothing has run holds no round")

    def test_the_snapshot_is_not_the_librarys_body(self) -> None:
        workflow = {
            "id": "wf-test",
            "name": "Mine",
            "stages": workflows.from_skills("plan", ["code-review"]),
        }
        record = pipeline.start(workflow)
        workflow["stages"][0]["name"] = "Renamed"
        workflow["stages"][0]["steps"].append("tdd")
        self.assertEqual(record["stages"][0]["name"], "Build")
        self.assertEqual(record["stages"][0]["steps"], ["plan"], "editing the entry changes nothing")


class KindTests(unittest.TestCase):
    def test_each_stage_is_judged_as_its_step(self) -> None:
        record = pipeline.start(WORKFLOW)
        self.assertEqual(
            [pipeline.kind({**record, "stage": index}) for index in range(4)],
            [BUILD, GATE_CHECK, CRITIQUE, DONE],
            "Build, the gate stage after it, Review, and past its own end",
        )

    def test_a_task_past_its_last_stage_is_done(self) -> None:
        record = pipeline.start(WORKFLOW)
        self.assertEqual(pipeline.kind({**record, "stage": len(record["stages"])}), DONE)

    def test_a_session_that_never_ran_one_is_not_staged(self) -> None:
        self.assertIsNone(pipeline.read(None))
        self.assertIsNone(pipeline.kind(None))
        self.assertFalse(pipeline.gating(None))

    def test_a_stage_after_the_shipping_one_has_shipped(self) -> None:
        self.assertEqual(pipeline.kind(staged(pipeline.DONE)), DONE)


class ShipTests(unittest.TestCase):
    def test_only_the_shipping_stage_ships(self) -> None:
        self.assertFalse(pipeline.ships(staged(BUILD)))
        self.assertFalse(pipeline.ships(staged(GATE_CHECK)))
        self.assertTrue(pipeline.ships(staged(CRITIQUE)))

    def test_the_shipping_stage_may_gate_itself(self) -> None:
        self.assertFalse(pipeline.gating(staged(CRITIQUE)), "a review's gate has already answered")
        one_run = pipeline.start(ONCE)
        self.assertTrue(
            pipeline.gating(one_run),
            "One run is one stage that implements, gates itself and ships",
        )

    def test_a_build_and_the_gate_stage_after_it_may_gate(self) -> None:
        self.assertTrue(pipeline.gating(staged(BUILD)))
        self.assertTrue(pipeline.gating(staged(GATE_CHECK)))


class AdvanceTests(unittest.TestCase):
    def test_a_build_that_passed_its_gate_reaches_its_review(self) -> None:
        step = pipeline.advance(pipeline.gated(staged(BUILD), gate(0)), worktree=tree())
        self.assertEqual(step.stage, CRITIQUE)
        self.assertIsNone(step.stall)

    def test_a_build_that_never_ran_the_gate_stalls(self) -> None:
        step = pipeline.advance(staged(BUILD), worktree=tree())
        self.assertEqual(step.stall, pipeline.NO_GATE)
        self.assertEqual(step.stage, GATE_CHECK)

    def test_the_failing_command_is_named(self) -> None:
        step = pipeline.advance(pipeline.gated(staged(BUILD), gate(0, 2)), worktree=tree())
        self.assertEqual(step.stall, "The gate failed: step-1 exited 2.")

    def test_the_tree_has_to_be_committed(self) -> None:
        step = pipeline.advance(pipeline.gated(staged(BUILD), gate(0)), worktree=tree(changed=3))
        self.assertEqual(step.stall, pipeline.UNCOMMITTED)

    def test_there_have_to_be_commits_beyond_the_base(self) -> None:
        step = pipeline.advance(pipeline.gated(staged(BUILD), gate(0)), worktree=tree(ahead=0))
        self.assertEqual(step.stall, pipeline.NO_COMMITS)

    def test_any_repo_uncommitted_fails_the_gate_of_a_project_that_spans_them(self) -> None:
        worktree = [*tree(), {"name": "o/api", "changed": 1, "ahead": 0}]
        step = pipeline.advance(pipeline.gated(staged(BUILD), gate(0)), worktree=worktree)
        self.assertEqual(step.stall, pipeline.UNCOMMITTED)

    def test_a_run_that_failed_keeps_the_stage_it_stopped_in(self) -> None:
        step = pipeline.advance(staged(BUILD), stopped="The run failed.")
        self.assertEqual(step.stage, BUILD)
        self.assertEqual(step.stall, "The run failed.")

    def test_a_review_that_finished_ends_the_task(self) -> None:
        step = pipeline.advance(staged(CRITIQUE))
        self.assertEqual(step.stage, DONE)
        self.assertIsNone(step.stall)

    def test_a_finished_task_stays_finished(self) -> None:
        self.assertEqual(pipeline.advance(staged(DONE)).stage, DONE)

    def test_one_run_is_finished_by_its_own_run(self) -> None:
        record = pipeline.gated(pipeline.start(ONCE), gate(0))
        self.assertEqual(
            pipeline.advance(record, worktree=tree()).stage,
            DONE,
            "its only stage implements, ships and is never reviewed by a second run of itself",
        )


class MoveTests(unittest.TestCase):
    def test_a_build_that_reached_its_review_leaves_it_current(self) -> None:
        record = pipeline.gated(staged(BUILD), gate(0))
        moved = pipeline.moved(record, pipeline.advance(record, worktree=tree()))
        self.assertEqual(pipeline.kind(moved), CRITIQUE)
        self.assertEqual(moved["stages"][0]["state"], pipeline.FINISHED)
        self.assertEqual(
            moved["stages"][1]["state"],
            pipeline.FINISHED,
            "the gate stage is answered by the host, so a task past it leaves it done",
        )
        self.assertEqual(moved["stages"][2]["state"], pipeline.CURRENT)
        self.assertEqual(moved["stages"][2]["rounds"], [pipeline.new_round()])

    def test_a_stall_keeps_the_stage_and_says_why(self) -> None:
        record = staged(BUILD)
        moved = pipeline.moved(record, pipeline.advance(record, worktree=tree()))
        self.assertEqual(pipeline.kind(moved), GATE_CHECK, "nothing is reviewed that never gated")
        self.assertEqual(moved["stages"][0]["state"], pipeline.FAILED)
        self.assertEqual(moved["stages"][0]["rounds"][-1]["stop"], pipeline.NO_GATE)

    def test_a_move_lands_on_the_next_stage_that_runs(self) -> None:
        record = pipeline.start(
            {
                "id": "wf-two-runs",
                "name": "Build · Test · Review",
                "stages": [
                    {"name": "Build", "steps": []},
                    {"name": "Test", "steps": ["code-review"]},
                    {"name": "Review", "steps": [], "ships": True},
                ],
            }
        )
        gated = pipeline.gated(record, [{"command": "true", "code": 0}])
        step = pipeline.advance(gated, worktree=tree())
        self.assertEqual(step.index, 1, "the stage after the build, not the one that ships")
        self.assertEqual(
            pipeline.kind(pipeline.moved(gated, step)),
            BUILD,
            "a workflow's own next stage, whatever step it is judged as",
        )

    def test_a_finished_review_moves_the_task_past_its_last_stage(self) -> None:
        moved = pipeline.moved(staged(CRITIQUE), pipeline.advance(staged(CRITIQUE)))
        self.assertEqual(moved["stage"], len(moved["stages"]))
        self.assertEqual(pipeline.kind(moved), DONE)

    def test_a_second_pass_keeps_the_rounds_it_ran_before(self) -> None:
        record = staged(BUILD)
        record["stages"][0]["rounds"].append(pipeline.new_round())
        moved = pipeline.moved(record, pipeline.Step(CRITIQUE, None))
        self.assertEqual(moved["stages"][2]["rounds"], [pipeline.new_round()], "Review's first round")
        self.assertEqual(moved["round"], 1)

    def test_a_write_leaves_the_record_it_was_given_alone(self) -> None:
        record = staged(BUILD)
        before = pipeline.gate_of(record)
        pipeline.gated(record, gate(0))
        self.assertEqual(pipeline.gate_of(record), before, "the record is a value, not a buffer")


class GateTests(unittest.TestCase):
    def test_the_gate_keeps_each_commands_exit_code(self) -> None:
        record = pipeline.gated(staged(BUILD), gate(0, 1))
        self.assertEqual(pipeline.gate_of(record)["commands"][1]["code"], 1)

    def test_a_gate_that_ran_clean_says_nothing(self) -> None:
        self.assertIsNone(pipeline.gate_verdict(pipeline.gated(staged(BUILD), gate(0))))

    def test_a_gate_that_never_ran_says_so(self) -> None:
        self.assertEqual(pipeline.gate_verdict(staged(BUILD)), pipeline.NO_GATE)

    def test_a_command_in_a_repo_is_named_with_it(self) -> None:
        record = pipeline.gated(
            staged(BUILD), [{"command": "pnpm test", "repo": "o/api", "code": 1}]
        )
        self.assertEqual(pipeline.gate_verdict(record), "The gate failed: o/api: pnpm test exited 1.")

    def test_a_hand_written_gate_reads_as_none(self) -> None:
        record = staged(BUILD)
        record["stages"][0]["rounds"][0]["gate"] = "yes"
        self.assertIsNone(pipeline.gate_of(pipeline.read(record)))


class ReadTests(unittest.TestCase):
    def test_a_snapshot_reads_back_as_it_was_written(self) -> None:
        record = pipeline.gated(staged(BUILD), gate(0))
        self.assertEqual(pipeline.read(record), record)

    def test_a_row_with_no_record_is_not_staged(self) -> None:
        for value in (None, "", [], {}, {"stage": "testing"}, {"workflow": {}}):
            self.assertIsNone(pipeline.read(value))

    def test_a_record_from_before_the_snapshot_is_upgraded(self) -> None:
        found = pipeline.read(
            {
                "stage": "critique",
                "build_skill": "plan",
                "critique_skills": ["code-review", "log-triage"],
                "gate": {"commands": [{"command": "pnpm test", "code": 0}]},
                "reason": None,
            }
        )
        self.assertIsNotNone(found, "a finished task still draws its stages after the upgrade")
        self.assertEqual(
            [stage["name"] for stage in found["stages"]], ["Build", "Test", "Review"]
        )
        self.assertEqual(found["stages"][0]["steps"], ["plan"])
        self.assertEqual(found["stages"][2]["steps"], ["code-review", "log-triage"])
        self.assertTrue(found["stages"][2]["ships"])
        self.assertEqual(pipeline.kind(found), CRITIQUE)
        self.assertEqual(found["stages"][2]["rounds"][0]["gate"], {"commands": [{"command": "pnpm test", "code": 0}]})

    def test_a_finished_old_record_keeps_every_stage_it_ran(self) -> None:
        found = pipeline.read({"stage": "done", "build_skill": "plan", "critique_skills": ["x"]})
        self.assertEqual(pipeline.kind(found), DONE)
        self.assertEqual(
            [stage["state"] for stage in found["stages"]],
            [pipeline.FINISHED] * 3,
            "a finished task draws its stages as finished, not as still to come",
        )

    def test_a_build_upgraded_from_the_old_shape_keeps_its_skills(self) -> None:
        found = pipeline.read({"stage": "build", "build_skill": None, "critique_skills": ["x"]})
        self.assertEqual(pipeline.kind(found), BUILD)
        self.assertIsNone(pipeline.build_skill(found))
        self.assertEqual(pipeline.critique_skills(found), ["x"])

    def test_an_old_record_that_stopped_keeps_its_reason(self) -> None:
        found = pipeline.read({"stage": "gate", "critique_skills": ["x"], "reason": "The gate failed."})
        self.assertEqual(pipeline.kind(found), GATE_CHECK)
        self.assertEqual(found["stages"][1]["state"], pipeline.FAILED)
        self.assertEqual(found["stages"][1]["rounds"][-1]["stop"], "The gate failed.")

    def test_a_finished_old_record_is_done(self) -> None:
        found = pipeline.read({"stage": "done", "critique_skills": ["x"]})
        self.assertEqual(pipeline.kind(found), DONE)

    def test_a_round_trip_of_an_upgraded_record_is_the_record(self) -> None:
        found = pipeline.read({"stage": "critique", "critique_skills": ["x"]})
        self.assertEqual(pipeline.read(found), found)


class SkillTests(unittest.TestCase):
    def test_the_build_and_review_skills_are_the_steps_they_name(self) -> None:
        record = staged(BUILD)
        self.assertEqual(pipeline.build_skill(record), "plan")
        self.assertEqual(pipeline.critique_skills(record), ["code-review"])

    def test_every_step_is_read_once_in_the_order_the_workflow_applies_them(self) -> None:
        record = staged(BUILD, steps=("code-review", "log-triage"))
        self.assertEqual(pipeline.steps_of(record), ["plan", "code-review", "log-triage"])

    def test_a_workflow_naming_nothing_names_no_skills(self) -> None:
        record = pipeline.start(
            {
                "id": "preset:staged",
                "name": "Build · Test · Review · Summary",
                "stages": workflows.from_skills(None, []),
            }
        )
        self.assertEqual(pipeline.steps_of(record), [])


if __name__ == "__main__":
    unittest.main()
