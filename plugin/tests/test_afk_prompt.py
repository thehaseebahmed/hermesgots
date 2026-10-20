import unittest
from typing import Any, Dict

from plugin import pipeline, prompt_builder
from plugin.tests._helpers import placed, preset, staged as staged_record

TASK: Dict[str, Any] = {
    "repo": "mock-user/memento",
    "number": 265,
    "title": "The frontier is read from GitHub and listed",
    "url": "https://github.com/mock-user/memento/issues/265",
    "created_at": "2026-10-01T00:00:00Z",
    "body": (
        "## What to build\n"
        "\n"
        "The frontier is read from GitHub, oldest first.\n"
        "\n"
        "- every open issue carrying the ready mark\n"
        "- a claimed one left out\n"
    ),
}

RECORD: Dict[str, Any] = {
    "session_id": "memento-afk-0123456789ab",
    "project_id": "p1",
    "mode": "auto",
    "path": "/trees/afk-265",
    "branch": "hermes/afk-265",
    "repo_root": "/checkout",
    "files_dir": "/checkout/files/afk-265",
    "repos": [
        {
            "name": "mock-user/memento",
            "repo_root": "/checkout",
            "path": "/trees/afk-265",
            "branch": "hermes/afk-265",
        }
    ],
}


class AfkPromptTests(unittest.TestCase):
    def text(self, record: Dict[str, Any] = None, task: Dict[str, Any] = None) -> str:
        return prompt_builder.afk_prompt(record or RECORD, task or TASK)

    def test_it_names_the_issue_and_where_its_text_is(self) -> None:
        text = self.text()
        self.assertIn("mock-user/memento#265", text)
        self.assertIn(TASK["url"], text)
        self.assertIn("gh issue view", text, "it reads the issue itself")
        self.assertNotIn(
            TASK["title"], text, "the issue's own text isn't copied into the prompt"
        )

    def test_it_is_implementation_of_a_planned_issue(self) -> None:
        text = self.text()
        self.assertIn("planned before they left", text)
        self.assertIn("Implement it — don't re-open the plan", text)
        self.assertIn("one issue", text, "it doesn't go looking for more work")

    def test_the_brief_is_the_fixed_points_rather_than_a_method(self) -> None:
        text = self.text()
        for step in ("The workflow:", "1. Read.", "2. Plan.", "3. Implement.", "4. Verify."):
            self.assertNotIn(step, text, "the six-step method is the prompt's now, not the brief's")
        for point in (
            "the issue is the spec",
            "Never ask the user anything",
            "the pull request ships last",
            "Nothing is merged or closed by you",
            "secrets",
            "leave the tree consistent",
        ):
            self.assertIn(point, text, f"the brief keeps {point!r}, whatever a prompt says")

    def test_the_fixed_points_hold_whatever_a_skill_or_a_prompt_says(self) -> None:
        self.assertIn(
            "A skill or a Prompt governs method only",
            self.text(),
            "the sentence that puts the brief above both",
        )

    def test_the_default_method_is_served_by_the_host(self) -> None:
        text = self.text()
        self.assertIn(prompt_builder.DEFAULT_PROMPT, text, "a project that wrote none is still told it")
        for part in (
            "checkpoints",
            "fails before the code that passes it",
            "the repo's own gates",
            "Read your own diff",
            "`simplify-code` and `requesting-code-review`",
            "summary",
        ):
            self.assertIn(part, text)

    def test_the_brief_is_told_before_the_prompt(self) -> None:
        text = self.text()
        self.assertLess(
            text.index("The rules:"), text.index("How to work:"), "the fixed points come first"
        )

    def test_a_projects_prompt_is_told_in_place_of_the_default(self) -> None:
        text = prompt_builder.afk_prompt(RECORD, TASK, "Squash every checkpoint into one commit.")
        self.assertIn("Squash every checkpoint into one commit.", text)
        self.assertNotIn(prompt_builder.DEFAULT_PROMPT, text, "an empty Prompt means the default")
        self.assertLess(text.index("The rules:"), text.index("Squash every checkpoint"))

    def test_a_staged_task_is_briefed_for_its_stage_and_told_no_prompt(self) -> None:
        staged = {**RECORD, "pipeline": staged_record(pipeline.BUILD)}
        text = prompt_builder.afk_prompt(staged, TASK, "Squash every checkpoint into one commit.")
        self.assertNotIn("Squash every checkpoint", text, "a workflow is what its work runs by")
        self.assertEqual(
            text, prompt_builder.afk_prompt(staged, TASK), "the stage's brief is as it was"
        )
        self.assertEqual(
            text.count("governs method only"),
            1,
            "a stage is told the skill's scope, not both it and the Prompt's",
        )
        self.assertIn("This task is worked in stages", text)

    def test_a_staged_build_keeps_the_method_the_prompt_took_from_the_brief(self) -> None:
        # The Prompt carries the method for a run that isn't staged; a stage has no Prompt, so its
        # brief keeps the six steps it had, and the build stage's "shipping step above" still has one.
        text = prompt_builder.afk_prompt({**RECORD, "pipeline": staged_record(pipeline.BUILD)}, TASK)
        for step in ("1. Read.", "2. Plan.", "3. Implement.", "4. Verify.", "5. Ship.", "6. Report."):
            self.assertIn(step, text)
        self.assertIn("which issue it implements, `#265`", text)
        self.assertIn("delegate_task", text, "the second opinion is still offered")
        self.assertNotIn(prompt_builder.DEFAULT_PROMPT, text)

    def test_a_run_that_is_not_staged_is_not_told_the_six_steps(self) -> None:
        text = prompt_builder.afk_prompt(RECORD, TASK)
        self.assertNotIn("1. Read.", text, "its method is the Prompt")

    def test_it_says_what_to_do_when_the_work_cannot_be_finished(self) -> None:
        text = self.text()
        self.assertIn("leave the tree consistent", text)
        self.assertIn("what blocks it", text)

    def test_it_keeps_the_sessions_own_prompt(self) -> None:
        text = self.text()
        self.assertIn("You are working in a git worktree of mock-user/memento", text)
        self.assertIn("pull_request tool", text, "the session's shipping rules still hold")
        self.assertIn("/checkout/files/afk-265", text, "and where its generated files go")

    def test_a_run_with_nobody_to_ask_says_the_pull_request_is_ready(self) -> None:
        text = self.text()
        self.assertIn("it is ready to merge", text)
        self.assertNotIn("ask the user with clarify", text)

    def test_a_record_in_plan_mode_still_carries_the_plan_shape(self) -> None:
        self.assertIn("# Plan:", self.text({**RECORD, "mode": "plan"}))

    def test_the_url_falls_back_to_github_when_the_row_has_none(self) -> None:
        text = self.text(task={key: value for key, value in TASK.items() if key != "url"})
        self.assertIn("https://github.com/mock-user/memento/issues/265", text)


class FirstMessageTests(unittest.TestCase):
    """The run that starts a task opens with the issue itself, and only that run does (ADR 0027)."""

    def test_the_first_message_is_the_issue_itself(self) -> None:
        self.assertEqual(
            prompt_builder.afk_input(TASK),
            f"Title: {TASK['title']}\nDescription:\n{TASK['body']}\n\n[Issue #265]({TASK['url']})",
        )

    def test_the_description_is_the_body_verbatim(self) -> None:
        text = prompt_builder.afk_input(TASK)
        self.assertIn(TASK["body"], text, "markdown and its blank lines reach the agent untouched")
        self.assertTrue(
            text.endswith(TASK["body"] + f"\n\n[Issue #265]({TASK['url']})"),
            "the description is copied whole to its last line: a truncated one makes a wrong plan",
        )

    def test_an_issue_with_no_body_still_reads_as_the_block(self) -> None:
        text = prompt_builder.afk_input({**TASK, "body": ""})
        self.assertEqual(
            text,
            f"Title: {TASK['title']}\nDescription:\n\n[Issue #265]({TASK['url']})",
            "the title, an empty description and the link",
        )

    def test_a_task_read_before_the_body_was_kept_reads_the_same(self) -> None:
        task = {key: value for key, value in TASK.items() if key != "body"}
        self.assertEqual(prompt_builder.afk_input(task), prompt_builder.afk_input({**TASK, "body": ""}))

    def test_a_later_stage_keeps_its_one_line(self) -> None:
        text = prompt_builder.stage_input(TASK, "Review")
        self.assertEqual(text, f"Review #265 ({TASK['url']})")
        self.assertNotIn("Description:", text, "the issue opens the task, not each of its stages")

    def test_the_instructions_carry_no_issue_text(self) -> None:
        text = prompt_builder.afk_prompt({**RECORD, "pipeline": None}, TASK)
        self.assertIn("mock-user/memento#265", text)
        self.assertNotIn(TASK["body"], text, "the body rides in the message, so the prompt is cached")

    def test_the_issue_text_is_framed_as_quoted_and_never_overriding(self) -> None:
        for record in ({**RECORD, "pipeline": None}, RECORD):
            text = prompt_builder.afk_prompt(record, TASK)
            self.assertIn("its author can change it", text)
            self.assertIn("never overrides these instructions", text)

    def test_the_instructions_point_at_the_comments_the_run_was_not_given(self) -> None:
        text = prompt_builder.afk_prompt({**RECORD, "pipeline": None}, TASK)
        self.assertIn("in the message this session opened with", text)
        self.assertNotIn(
            "isn't repeated here", text, "the run that starts a task was handed the issue"
        )


class BuildStageTests(unittest.TestCase):
    """What a staged task's build run is told: it ends at the gate, not at a pull request."""

    RECORD = {
        **RECORD,
        "pipeline": staged_record(pipeline.BUILD, steps=("code-review", "log-triage")),
    }

    def text(self, record: Dict[str, Any] = None) -> str:
        return prompt_builder.afk_prompt(record or self.RECORD, TASK)

    def test_it_ends_at_the_gate_rather_than_at_a_pull_request(self) -> None:
        text = self.text()
        self.assertIn("Build stage", text)
        self.assertIn("The shipping step above is not yours", text, "the ship step is given back explicitly")
        self.assertIn("afk_gate", text)
        self.assertIn("end the run", text)
        self.assertIn("refuses 'ship' from this stage", text)

    def test_it_names_the_skill_the_build_follows(self) -> None:
        text = self.text()
        self.assertIn('follows your skill "plan"', text)
        self.assertIn('skill_view(name="plan")', text)
        self.assertIn("A skill governs method only", text, "no skill unlocks the gate")

    def test_a_staged_build_with_no_build_skill_names_none(self) -> None:
        record = {**RECORD, "pipeline": staged_record(pipeline.BUILD, build=None)}
        self.assertNotIn("skill_view", self.text(record))

    def test_an_unstaged_run_is_told_nothing_about_stages(self) -> None:
        text = prompt_builder.afk_prompt(RECORD, TASK)
        self.assertNotIn("Build stage", text)
        self.assertNotIn("afk_gate", text, "a project with no critique skill is one run, as before")

    def test_the_task_and_the_worktree_are_still_named(self) -> None:
        text = self.text()
        self.assertIn("mock-user/memento#265", text)
        self.assertIn("/trees/afk-265", text)

    def test_the_staged_first_run_is_told_its_issue_is_in_the_message(self) -> None:
        text = self.text()
        self.assertIn(
            "in the message this session opened with",
            text,
            "the run that starts a staged task was handed the issue too",
        )
        self.assertNotIn("isn't repeated here", text)

    def test_a_later_stage_run_reads_the_issue_itself(self) -> None:
        text = prompt_builder.stage_prompt(self.RECORD, TASK)
        self.assertIn(
            "isn't repeated here", text, "a later run's input only names the stage and the issue"
        )


class StagePromptTests(unittest.TestCase):
    """What a stage's run is told, in the words of the stage it is in: its name, its skills in order,
    and what the round before it failed on."""

    REVIEW = {
        **RECORD,
        "pipeline": staged_record(pipeline.CRITIQUE, steps=("code-review", "log-triage")),
    }

    def text(self, pipeline_record=None, base: str = "main") -> str:
        record = dict(self.REVIEW, pipeline=pipeline_record or self.REVIEW["pipeline"])
        return prompt_builder.stage_prompt(record, TASK, base)

    def test_it_reviews_what_the_build_did(self) -> None:
        text = self.text()
        self.assertIn("Review stage", text)
        self.assertIn("reviewing the build of mock-user/memento#265", text)
        self.assertIn(TASK["url"], text, "the issue is where the reviewer reads the spec")
        self.assertIn("/trees/afk-265", text)

    def test_it_names_the_base_branch(self) -> None:
        self.assertIn("The work is against the base branch main.", self.text())
        self.assertNotIn(
            "The work is against the base branch",
            self.text(base=None),
            "an unknown base is left out rather than guessed",
        )

    def test_a_stage_that_does_not_ship_is_not_told_the_base(self) -> None:
        build = staged_record(pipeline.BUILD)
        self.assertNotIn("base branch", self.text(build), "only the review opens the pull request")

    def test_it_applies_its_skills_in_order_rather_than_delegating_them(self) -> None:
        text = self.text()
        self.assertIn('"code-review", "log-triage"', text, "the stage's steps, in the order it has them")
        self.assertEqual(text.count("code-review"), 1, "the skills are named in one line, not one each")
        self.assertEqual(text.count("log-triage"), 1)
        self.assertIn("Load each with skill_view", text)
        self.assertIn("apply it to the diff", text, "the review's work is the diff, so its skills go on that")
        self.assertNotIn("one reviewer per skill", text)
        self.assertNotIn("reviewer", text.lower(), "the per-skill reviewer briefs are gone")

    def test_a_skill_that_asks_for_reviewers_is_not_contradicted(self) -> None:
        text = self.text().lower()
        for child in ("delegate", "spawn", "subagent"):
            self.assertNotIn(child, text, "the brief neither asks for children nor forbids them")
        self.assertIn("governs method only", text, "the skill's own words decide how it is done")

    def test_a_stage_with_no_skills_still_states_the_fixed_points(self) -> None:
        record = staged_record(pipeline.CRITIQUE, steps=())
        text = prompt_builder.stage_prompt({**RECORD, "pipeline": record}, TASK, "main")
        self.assertNotIn("skill_view", text, "nothing is loaded")
        self.assertIn(prompt_builder._SKILL_SCOPE, text, "the fixed points hold with no skill to check")

    def test_every_stage_states_the_guard_once(self) -> None:
        records = [
            self.REVIEW["pipeline"],
            staged_record(pipeline.BUILD),
            staged_record(pipeline.CRITIQUE, steps=("code-review", "log-triage")),
            pipeline.start(preset("preset:one-run")),
        ]
        for record in records:
            text = prompt_builder.stage_prompt({**RECORD, "pipeline": record}, TASK, "main")
            self.assertEqual(
                text.count(prompt_builder._SKILL_SCOPE),
                1,
                f"{pipeline.stage_name(record)} states the fixed points once",
            )

    def test_a_skill_shapes_method_only(self) -> None:
        text = self.text()
        self.assertIn("governs method only", text)
        self.assertIn("no skill unlocks the gate", text)
        self.assertIn("nobody is asked anything", text)
        self.assertIn("shipped last", text)

    def test_the_guard_is_the_same_one_the_build_is_given(self) -> None:
        build = prompt_builder.afk_prompt({**RECORD, "pipeline": staged_record()}, TASK)
        self.assertIn(prompt_builder._SKILL_SCOPE, build, "one guard, every stage")
        self.assertIn(prompt_builder._SKILL_SCOPE, self.text())

    def test_it_fixes_once_and_ships_last(self) -> None:
        text = self.text()
        self.assertIn("fix it in one pass", text)
        self.assertIn("there is no second review", text, "the user's read is the next pass")
        self.assertIn("action 'ship'", text)
        self.assertIn("The pull request stays a draft", text)
        self.assertIn("what the review found and what changed", text)
        self.assertIn("Leave the Closes line to the tool", text)

    def test_its_input_names_the_stage_and_the_issue(self) -> None:
        self.assertEqual(
            prompt_builder.stage_input(TASK, "Review"),
            f"Review #265 ({TASK['url']})",
        )
        self.assertEqual(
            prompt_builder.stage_input(TASK, None),
            f"Continue #265 ({TASK['url']})",
            "a task past its last stage still names the issue",
        )

    def test_a_summary_stage_wraps_up_and_ships_nothing(self) -> None:
        summary = staged_record(pipeline.CRITIQUE)
        summary["stage"] = len(summary["stages"]) - 1 if len(summary["stages"]) > 3 else 3
        record = prompt_builder.stage_prompt(
            {**RECORD, "pipeline": self.summary_record()}, TASK, "main"
        )
        self.assertIn("Summary stage", record)
        self.assertIn("wrapping up", record)
        self.assertIn("write the wrap-up", record)
        self.assertIn("Don't ship", record)

    def summary_record(self):
        """The preset's record, in its Summary stage, with a skill so its run exists."""
        record = pipeline.start(preset("preset:staged"))
        record["stage"] = 3
        record["stages"][3]["steps"] = ["weekly-review"]
        record["stages"][3]["rounds"] = [pipeline.new_round()]
        return pipeline.read(record)

    def test_one_run_implements_gates_and_ships_in_the_same_run(self) -> None:
        once = pipeline.start(preset("preset:one-run"))
        text = prompt_builder.stage_prompt({**RECORD, "pipeline": once}, TASK)
        self.assertIn("worked in one run", text)
        self.assertIn("afk_gate", text)
        self.assertIn("action 'ship'", text)
        self.assertNotIn("The shipping step above is not yours", text)

    def test_a_loops_next_round_is_told_the_command_that_failed(self) -> None:
        failing = placed(preset("preset:loop"), 0, gate={"commands": [{"command": "pnpm test", "code": 1}]})
        record = pipeline.moved(failing, pipeline.advance(failing, worktree=[{"changed": 0, "ahead": 1}]))
        text = prompt_builder.stage_prompt({**RECORD, "pipeline": record}, TASK)
        self.assertIn("The round before this one failed its gate: pnpm test exited 1.", text)
        self.assertIn("run the gate again", text)

    def test_a_first_round_is_told_nothing_failed(self) -> None:
        self.assertNotIn("The round before this one", self.text(staged_record()))


if __name__ == "__main__":
    unittest.main()
