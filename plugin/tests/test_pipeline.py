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
from plugin.tests._helpers import placed, preset, staged

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


class PostsTests(unittest.TestCase):
    """Which stages post a run of the task's session, and which the host answers itself."""

    STAGED = preset("preset:staged")

    def test_a_stage_before_the_shipping_one_posts_a_run_even_with_no_skill(self) -> None:
        stages = pipeline.start(self.STAGED)["stages"]
        self.assertTrue(
            pipeline.posts(stages, 0),
            "a preset's build names no skill, and its built-in brief is what implements the issue",
        )

    def test_the_shipping_stage_posts_a_run_even_with_no_skill(self) -> None:
        stages = pipeline.start(self.STAGED)["stages"]
        self.assertTrue(pipeline.posts(stages, 2), "nothing ships if the review never runs")

    def test_a_checkpoint_posts_none(self) -> None:
        stages = pipeline.start(self.STAGED)["stages"]
        self.assertFalse(
            pipeline.posts(stages, 1), "the host answers the gate from the run before it"
        )

    def test_a_stage_after_the_shipping_one_posts_only_when_it_names_steps(self) -> None:
        stages = pipeline.start(self.STAGED)["stages"]
        self.assertFalse(pipeline.posts(stages, 3), "an empty Summary has nothing to do")
        stages[3]["steps"] = ["weekly-review"]
        self.assertTrue(pipeline.posts(stages, 3))

    def test_the_stage_a_task_is_in_is_the_one_that_posts(self) -> None:
        record = pipeline.start(self.STAGED)
        self.assertTrue(pipeline.posts_now(record), "Build runs")
        self.assertFalse(
            pipeline.posts_now({**record, "stage": 1}), "Test is a checkpoint, so nothing is posted"
        )
        self.assertTrue(pipeline.posts_now({**record, "stage": 2}), "Review runs")
        self.assertFalse(
            pipeline.posts_now({**record, "stage": 4}), "past its last stage, nothing is posted"
        )


class NameTests(unittest.TestCase):
    def test_a_task_names_the_stage_it_is_in_and_the_one_that_ships(self) -> None:
        record = pipeline.start(preset("preset:staged"))
        self.assertEqual(pipeline.stage_name({**record, "stage": 0}), "Build")
        self.assertEqual(pipeline.stage_name({**record, "stage": 3}), "Summary")
        self.assertEqual(pipeline.shipping_name(record), "Review")
        self.assertIsNone(pipeline.stage_name({**record, "stage": 4}))


class LoopTests(unittest.TestCase):
    """The preset whose build repeats while the gate fails: a round, its failure, and its cap."""

    LOOP = preset("preset:loop")
    BROKEN = [{"command": "pnpm test", "code": 1}]

    def failing(self, rounds: int = 1) -> Dict[str, Any]:
        """The loop preset's build, in hand after ``rounds`` rounds that each failed their gate."""
        record = placed(self.LOOP, 0)
        record["stages"][0]["rounds"] = [
            {**pipeline.new_round(), "gate": {"commands": self.BROKEN}} for _ in range(rounds)
        ]
        return pipeline.read(record)

    def test_a_failed_checkpoint_starts_another_round_of_the_stage_the_loop_starts_at(self) -> None:
        step = pipeline.advance(self.failing(), worktree=tree())
        self.assertIsNone(step.stall, "a loop is work, not a wait for the user")
        self.assertEqual(step.index, 0, "back to the build the loop starts at")
        self.assertEqual(step.retry, "pnpm test exited 1", "the command, as a sentence names it")

    def test_the_next_round_keeps_the_round_it_replaces_and_is_told_what_failed(self) -> None:
        record = self.failing()
        moved = pipeline.moved(record, pipeline.advance(record, worktree=tree()))
        self.assertEqual(moved["stage"], 0)
        self.assertEqual(moved["round"], 2)
        self.assertEqual(len(moved["stages"][0]["rounds"]), 2, "nothing the task ran is lost")
        self.assertEqual(moved["stages"][0]["rounds"][0]["gate"], record["stages"][0]["rounds"][0]["gate"])
        self.assertEqual(
            moved["stages"][0]["rounds"][1]["retry"],
            "pnpm test exited 1",
            "the round it starts is told the command that failed",
        )
        self.assertEqual(pipeline.retry(moved), "pnpm test exited 1")
        self.assertIsNone(pipeline.reason(moved), "a repeating build is not a stalled task")

    def test_a_gate_that_passes_leaves_the_loop_for_the_review(self) -> None:
        record = pipeline.gated(self.failing(), [{"command": "pnpm test", "code": 0}])
        step = pipeline.advance(record, worktree=tree())
        self.assertIsNone(step.retry)
        self.assertEqual(pipeline.kind(pipeline.moved(record, step)), CRITIQUE)
        self.assertEqual(pipeline.stage_name(pipeline.moved(record, step)), "Review")

    def test_past_the_cap_it_stalls_naming_the_command(self) -> None:
        step = pipeline.advance(self.failing(rounds=3), worktree=tree())
        self.assertEqual(
            step.stall,
            "The loop ran out of rounds (3) and the gate still failed: pnpm test exited 1.",
            "the user is told the command, not only that a loop ended",
        )
        self.assertIsNone(step.index, "a stall starts nothing")

    def test_past_the_cap_it_lands_on_the_checkpoint_and_nothing_after_it_starts(self) -> None:
        record = self.failing(rounds=3)
        moved = pipeline.moved(record, pipeline.advance(record, worktree=tree()))
        self.assertEqual(pipeline.kind(moved), GATE_CHECK, "it waits at the checkpoint it failed")
        self.assertEqual(moved["stages"][2]["rounds"], [], "the review never starts")
        self.assertEqual(moved["stages"][2]["state"], pipeline.TODO)

    def test_the_cap_is_the_loops_own(self) -> None:
        once = {
            "id": "wf-once",
            "name": "Build ⇄ Test",
            "stages": [
                {"name": "Build", "steps": ["plan"]},
                {
                    "name": "Test",
                    "steps": [],
                    "check": workflows.GATE,
                    "loop": {"from": "Build", "cap": 1},
                },
                {"name": "Review", "steps": [], "ships": True},
            ],
        }
        step = pipeline.advance(placed(once, 0, gate={"commands": self.BROKEN}), worktree=tree())
        self.assertIn("ran out of rounds (1)", step.stall or "")

    def test_a_span_of_several_stages_repeats_from_its_first_one(self) -> None:
        span = {
            "id": "wf-span",
            "name": "Build · Polish ⇄ Test",
            "stages": [
                {"name": "Build", "steps": ["plan"]},
                {"name": "Polish", "steps": ["code-review"]},
                {
                    "name": "Test",
                    "steps": [],
                    "check": workflows.GATE,
                    "loop": {"from": "Build", "cap": 3},
                },
                {"name": "Review", "steps": [], "ships": True},
            ],
        }
        record = placed(span, 2, gate={"commands": self.BROKEN})
        step = pipeline.advance(record, worktree=tree())
        self.assertEqual(step.index, 0, "the span starts at its first stage")
        moved = pipeline.moved(record, step)
        self.assertEqual(moved["stage"], 0)
        self.assertEqual(moved["stages"][1]["state"], pipeline.TODO, "Polish has to run again")


class FlowTests(unittest.TestCase):
    """A workflow's stages handing over to one another, one run at a time."""

    STAGED = preset("preset:staged")

    def test_a_workflow_with_a_summary_that_names_nothing_ends_after_its_review(self) -> None:
        record = placed(self.STAGED, 2)
        step = pipeline.advance(record)
        self.assertEqual(
            step.stage, DONE, "an empty Summary has nothing to run, so the task is over"
        )
        moved = pipeline.moved(record, step)
        self.assertEqual(moved["stage"], 4)
        self.assertEqual(
            moved["stages"][3]["state"], pipeline.FINISHED, "it is drawn as done, not still to come"
        )

    def test_a_summary_that_names_a_skill_is_started_like_any_other_stage(self) -> None:
        record = placed(self.STAGED, 2)
        record["stages"][3]["steps"] = ["weekly-review"]
        step = pipeline.advance(record)
        self.assertEqual(step.index, 3)
        self.assertEqual(step.stage, DONE, "a stage after the shipping one has shipped")
        moved = pipeline.moved(record, step)
        self.assertEqual(pipeline.stage_name(moved), "Summary")
        self.assertEqual(moved["stages"][3]["rounds"], [pipeline.new_round()])

    def test_a_summary_that_finished_ends_the_task(self) -> None:
        record = placed(self.STAGED, 3)
        self.assertEqual(pipeline.advance(record).stage, DONE)
        self.assertEqual(pipeline.moved(record, pipeline.advance(record))["stage"], 4)

    def test_a_review_hands_over_without_being_gated(self) -> None:
        record = placed(self.STAGED, 2)
        self.assertFalse(pipeline.measured(record), "the pull request is what judges a review")
        self.assertEqual(pipeline.advance(record).stage, DONE)


class SingleStageTests(unittest.TestCase):
    def test_one_run_is_a_workflow_of_one_shipping_stage(self) -> None:
        record = pipeline.start(preset("preset:one-run"))
        self.assertTrue(pipeline.ships(record))
        self.assertTrue(pipeline.measured(record))
        self.assertTrue(pipeline.gating(record))
        self.assertEqual(pipeline.advance(pipeline.gated(record, gate(0)), worktree=tree()).stage, DONE)

    def test_a_shipping_stage_with_a_stage_after_it_is_not_one_run(self) -> None:
        after = {
            "id": "wf-ship-then-summary",
            "name": "Ship · Summary",
            "stages": [
                {"name": "Ship", "steps": [], "ships": True},
                {"name": "Summary", "steps": ["weekly-review"]},
            ],
        }
        record = placed(after, 0)
        self.assertFalse(pipeline.gating(record), "it gates nothing: the review is what judges it")
        self.assertEqual(
            pipeline.moved(record, pipeline.advance(record))["stage"],
            1,
            "the stage after it is the task's next one, not its end",
        )


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


class RecordOfWhatRanTests(unittest.TestCase):
    """What a stage's run executed and what its review found, as the details sheet reads them."""

    def ran(self, record: Dict[str, Any], *lines: str) -> Dict[str, Any]:
        for line in lines:
            record = pipeline.ran(record, line)
        return record

    def test_a_stage_keeps_every_command_its_run_executed_in_order(self) -> None:
        record = self.ran(staged(BUILD), "pnpm lint", "pnpm typecheck", "pnpm test")
        self.assertEqual(
            [one["command"] for one in pipeline.stage_commands(record)],
            ["pnpm lint", "pnpm typecheck", "pnpm test"],
        )

    def test_what_a_stage_ran_is_capped_to_its_most_recent(self) -> None:
        record = self.ran(staged(BUILD), *[f"step-{index}" for index in range(pipeline.COMMAND_CAP + 3)])
        found = pipeline.stage_commands(record)
        self.assertEqual(len(found), pipeline.COMMAND_CAP)
        self.assertEqual(found[0]["command"], "step-3")

    def test_the_gates_commands_carry_the_code_the_host_read_and_the_rest_do_not(self) -> None:
        record = self.ran(staged(BUILD), "pnpm lint", "pnpm test")
        record = pipeline.gated(
            record,
            [
                {"command": "pnpm lint", "code": 0},
                {"command": "pnpm test", "code": 1},
            ],
        )
        found = pipeline.stage_commands(record)
        self.assertEqual(
            [(one["command"], one["code"], one["checked"]) for one in found],
            [("pnpm lint", 0, True), ("pnpm test", 1, True)],
            "the run's own lines are the ones the host checked, and they carry its codes",
        )

    def test_a_gate_command_the_run_never_executed_is_listed_too(self) -> None:
        record = pipeline.gated(staged(BUILD), [{"command": "pnpm test", "code": 0}])
        self.assertEqual(
            pipeline.stage_commands(record),
            [{"command": "pnpm test", "repo": None, "code": 0, "checked": True, "round": 1}],
        )

    def test_a_command_before_the_gate_is_not_marked_checked(self) -> None:
        record = self.ran(staged(BUILD), "pnpm lint", "pnpm test")
        record = pipeline.gated(record, [{"command": "pnpm test", "code": 0}])
        found = pipeline.stage_commands(record)
        self.assertEqual(
            [(one["command"], one["checked"]) for one in found],
            [("pnpm lint", False), ("pnpm test", True)],
        )

    def test_a_repo_in_the_gates_answer_names_the_matching_command(self) -> None:
        record = pipeline.gated(
            staged(BUILD), [{"command": "pnpm test", "repo": "o/api", "code": 1}]
        )
        self.assertEqual(
            pipeline.stage_commands(record)[0]["repo"], "o/api", "the sheet says where the host ran it"
        )

    def test_each_rounds_commands_are_marked_with_their_round(self) -> None:
        record = staged(BUILD)
        record = self.ran(record, "pnpm test")
        record["stages"][0]["rounds"].append(pipeline.new_round())
        record["round"] = 2
        record = self.ran(record, "pnpm test --fixed")
        self.assertEqual(
            [(one["command"], one["round"]) for one in pipeline.stage_commands(record)],
            [("pnpm test", 1), ("pnpm test --fixed", 2)],
            "a loop's second attempt reads as its own",
        )

    def test_each_review_skill_is_counted_including_the_one_that_found_nothing(self) -> None:
        record = pipeline.reported(staged(CRITIQUE), "code-review", ["a", "b", "c"])
        record = pipeline.reported(record, "log-triage", [])
        self.assertEqual(
            [(one["skill"], len(one["findings"])) for one in pipeline.stage_findings(record)],
            [("code-review", 3), ("log-triage", 0)],
        )

    def test_what_a_run_did_is_still_there_when_it_stalls(self) -> None:
        record = self.ran(staged(CRITIQUE), "pnpm test")
        record = pipeline.reported(record, "code-review", ["a leak", "a dead branch"])
        stalled = pipeline.moved(record, pipeline.advance(record, stopped="The run stopped."))
        self.assertEqual(pipeline.reason(stalled), "The run stopped.")
        self.assertEqual([one["command"] for one in pipeline.stage_commands(stalled)], ["pnpm test"])
        self.assertEqual(len(pipeline.stage_findings(stalled)[0]["findings"]), 2)

    def test_a_stage_a_task_has_not_reached_ran_nothing(self) -> None:
        record = self.ran(staged(BUILD), "pnpm test")
        self.assertEqual(pipeline.stage_commands(record, 2), [])
        self.assertEqual(pipeline.stage_findings(record, 2), [])

    def test_a_write_does_not_edit_the_record_it_was_given(self) -> None:
        record = self.ran(staged(BUILD), "pnpm test")
        pipeline.reported(record, "code-review", ["a"])
        self.assertEqual(len(pipeline.stage_findings(record)), 0, "the caller's record is its own")
        self.assertEqual(len(pipeline.stage_commands(record)), 1)

    def test_a_hand_edit_reads_without_throwing(self) -> None:
        record = staged(BUILD)
        record["stages"][0]["rounds"][0]["commands"] = ["pnpm test", None, {"command": ""}]
        record["stages"][0]["rounds"][0]["findings"] = ["code-review", {"skill": ""}, {"skill": "x"}]
        found = pipeline.read(record)
        self.assertEqual(pipeline.stage_commands(found), [])
        self.assertEqual(pipeline.stage_findings(found), [{"skill": "x", "findings": []}])

    def test_a_finished_task_has_no_stage_in_hand_to_record_on(self) -> None:
        record = staged(DONE)
        self.assertEqual(pipeline.ran(record, "pnpm test")["stages"], record["stages"])
        self.assertEqual(
            pipeline.reported(record, "code-review", ["a"])["stages"], record["stages"]
        )


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
