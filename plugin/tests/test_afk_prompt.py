import unittest
from typing import Any, Dict

from plugin import prompt_builder

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


if __name__ == "__main__":
    unittest.main()
