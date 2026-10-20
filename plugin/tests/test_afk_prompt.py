import unittest
from typing import Any, Dict

from plugin import pipeline, prompt_builder

TASK: Dict[str, Any] = {
    "repo": "mock-user/memento",
    "number": 265,
    "title": "The frontier is read from GitHub and listed",
    "url": "https://github.com/mock-user/memento/issues/265",
    "created_at": "2026-10-01T00:00:00Z",
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

    def test_it_asks_for_the_work_in_the_order_it_has_to_happen(self) -> None:
        text = self.text()
        for step in ("Read.", "Plan.", "Implement.", "Verify.", "Ship.", "Report."):
            self.assertIn(step, text)
        self.assertIn("test first", text)
        self.assertIn("Conventional Commits", text)
        self.assertIn("A suite you didn't run isn't passing", text)

    def test_it_ships_a_draft_pull_request_and_leaves_the_closing_line_to_the_tool(self) -> None:
        text = self.text()
        self.assertIn("action 'ship'", text)
        self.assertIn("draft pull request", text)
        self.assertIn("#265", text, "the brief names the issue it implements")
        self.assertIn("Don't write the `Closes` line yourself", text)
        self.assertIn("Don't close the issue or merge anything yourself", text)

    def test_it_has_nobody_to_ask_and_a_second_opinion_to_take(self) -> None:
        text = self.text()
        self.assertIn("Never ask the user anything", text)
        self.assertIn("never leave a plan waiting for approval", text)
        self.assertIn("delegate_task", text)
        self.assertIn("decide", text)

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


class BuildStageTests(unittest.TestCase):
    """What a staged task's build run is told: it ends at the gate, not at a pull request."""

    RECORD = {**RECORD, "pipeline": pipeline.start("plan", ["code-review", "log-triage"])}

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
        self.assertIn('built by your skill "plan"', text)
        self.assertIn('skill_view(name="plan")', text)
        self.assertIn("A skill governs method only", text, "no skill unlocks the gate")

    def test_a_staged_build_with_no_build_skill_names_none(self) -> None:
        record = {**RECORD, "pipeline": pipeline.start(None, ["code-review"])}
        self.assertNotIn("skill_view", self.text(record))

    def test_an_unstaged_run_is_told_nothing_about_stages(self) -> None:
        text = prompt_builder.afk_prompt(RECORD, TASK)
        self.assertNotIn("Build stage", text)
        self.assertNotIn("afk_gate", text, "a project with no critique skill is one run, as before")

    def test_the_task_and_the_worktree_are_still_named(self) -> None:
        text = self.text()
        self.assertIn("mock-user/memento#265", text)
        self.assertIn("/trees/afk-265", text)


class CritiquePromptTests(unittest.TestCase):
    """What the critique run is told: the work it reviews, by the skills chosen, and that it ships."""

    RECORD = {**RECORD, "pipeline": {**pipeline.start("plan", ["code-review", "log-triage"]), "stage": "critique"}}

    def text(self, base: str = "main") -> str:
        return prompt_builder.critique_prompt(self.RECORD, TASK, base)

    def test_it_reviews_what_the_build_did(self) -> None:
        text = self.text()
        self.assertIn("Critique stage", text)
        self.assertIn("reviewing the build of mock-user/memento#265", text)
        self.assertIn(TASK["url"], text, "the issue is where the reviewer reads the spec")
        self.assertIn("/trees/afk-265", text)

    def test_it_names_the_base_branch(self) -> None:
        self.assertIn("The work is against the base branch main.", self.text())
        self.assertNotIn(
            "The work is against the base branch",
            prompt_builder.critique_prompt(self.RECORD, TASK, None),
            "an unknown base is left out rather than guessed",
        )

    def test_it_delegates_one_reviewer_per_skill(self) -> None:
        text = self.text()
        self.assertIn('"code-review"', text)
        self.assertIn('"log-triage"', text)
        self.assertIn("delegate_task", text)
        self.assertIn("one reviewer per skill", text)

    def test_one_skill_asks_for_one_reviewer(self) -> None:
        record = {**RECORD, "pipeline": {**pipeline.start(None, ["code-review"]), "stage": "critique"}}
        text = prompt_builder.critique_prompt(record, TASK, "main")
        self.assertIn("The critique skill is", text)
        self.assertIn("one reviewer", text)

    def test_each_reviewer_is_briefed_with_its_skill_the_issue_the_base_and_the_worktree(
        self,
    ) -> None:
        briefs = prompt_builder.critique_briefs(self.RECORD, TASK, "main")
        self.assertEqual(len(briefs), 2, "a skill each, so two lenses rather than one review")
        for name, brief in zip(("code-review", "log-triage"), briefs):
            self.assertIn(f'"{name}"', brief, "the reviewer knows which lens it is")
            self.assertIn(f'skill_view(name="{name}")', brief, "and loads that skill itself")
            self.assertIn(f"mock-user/memento#265 ({TASK['url']})", brief)
            self.assertIn("base main", brief, "the branch the pull request is against")
            self.assertIn("/trees/afk-265", brief, "the worktree the review reads")
            self.assertIn("reports rather than implements", brief)
            self.assertIn("changes nothing, commits nothing and ships nothing", brief)
            self.assertNotIn("'ship'", brief, "a reviewer never ships")
        self.assertNotEqual(briefs[0], briefs[1], "one brief each, not one brief twice")

    def test_the_prompt_hands_over_every_brief(self) -> None:
        text = self.text()
        for brief in prompt_builder.critique_briefs(self.RECORD, TASK, "main"):
            self.assertIn(brief, text)

    def test_a_brief_without_a_base_leaves_it_out(self) -> None:
        for brief in prompt_builder.critique_briefs(self.RECORD, TASK, None):
            self.assertNotIn("base ", brief, "an unknown base is left out rather than guessed")
            self.assertIn("/trees/afk-265", brief)

    def test_a_multi_repo_brief_names_every_worktree(self) -> None:
        record = {
            **RECORD,
            "repos": [
                *RECORD["repos"],
                {
                    "name": "mock-user/api",
                    "repo_root": "/api",
                    "path": "/trees/api-265",
                    "branch": "hermes/afk-265",
                },
            ],
        }
        for brief in prompt_builder.critique_briefs(record, TASK, "main"):
            self.assertIn("/trees/afk-265 and /trees/api-265", brief)

    def test_a_skill_that_prescribes_its_own_arrangement_gets_it(self) -> None:
        text = self.text()
        self.assertIn("prescribes its own arrangement", text)
        self.assertIn("wins over its brief", text)
        self.assertIn("rather than wrapping it in a single reviewer", text)
        self.assertIn("reports rather than implements all the same", text)

    def test_a_skill_shapes_method_only(self) -> None:
        text = self.text()
        self.assertIn("shapes method only", text)
        self.assertIn("no skill unlocks the gate", text)
        self.assertIn("nobody is asked anything", text)
        self.assertIn("shipped last", text)

    def test_it_fixes_once_and_ships_last(self) -> None:
        text = self.text()
        self.assertIn("fix it in one pass", text)
        self.assertIn("there is no second review", text, "the user's read is the next pass")
        self.assertIn("action 'ship'", text)
        self.assertIn("The pull request stays a draft", text)
        self.assertIn("what the critique found and what changed", text)
        self.assertIn("Leave the Closes line to the tool", text)

    def test_its_input_names_what_it_reviews(self) -> None:
        self.assertEqual(
            prompt_builder.critique_input(TASK),
            f"Critique the build of #265 ({TASK['url']})",
        )


if __name__ == "__main__":
    unittest.main()
