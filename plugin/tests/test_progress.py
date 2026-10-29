"""A long silent tool loop is asked to check in: the count of continuous calls, what resets it, and
that a model which ignores the ask is never stuck.

Run: python3 -m unittest plugin.tests.test_progress -v
"""

from __future__ import annotations

import unittest

from plugin import progress

SESSION = "memento-abc"
TURN = "turn-1"


class ProgressTest(unittest.TestCase):
    def setUp(self) -> None:
        progress._calls.clear()
        self.addCleanup(progress._calls.clear)

    def call(self, tool: str = "read_file", session: str = SESSION, turn: str = TURN):
        return progress.before_tool(
            tool_name=tool, args={}, task_id=session, session_id=session, turn_id=turn
        )

    def model_call(self, chars: int, session: str = SESSION, turn: str = TURN) -> None:
        progress.after_model_call(
            session_id=session, task_id=session, turn_id=turn, assistant_content_chars=chars
        )

    def test_the_calls_before_the_check_in_run(self) -> None:
        for _ in range(progress.CHECK_IN_AFTER):
            self.assertIsNone(self.call())

    def test_the_call_after_them_asks_for_an_update(self) -> None:
        for _ in range(progress.CHECK_IN_AFTER):
            self.call()
        blocked = self.call()
        self.assertEqual(blocked["action"], "block")
        self.assertIn(f"{progress.CHECK_IN_AFTER} tool calls", blocked["message"])
        self.assertIn("update", blocked["message"])

    def test_a_model_ignoring_the_ask_gets_its_tool_back(self) -> None:
        # The block must not be a wall: the same call goes through next, or the turn could never end.
        for _ in range(progress.CHECK_IN_AFTER):
            self.call()
        self.assertIsNotNone(self.call())
        self.assertIsNone(self.call())

    def test_asking_again_takes_another_full_stretch(self) -> None:
        for _ in range(progress.CHECK_IN_AFTER + 1):
            self.call()
        for _ in range(progress.CHECK_IN_AFTER):
            self.assertIsNone(self.call())
        self.assertIsNotNone(self.call())

    def test_a_reply_with_text_starts_a_new_stretch(self) -> None:
        for _ in range(progress.CHECK_IN_AFTER):
            self.call()
        self.model_call(120)
        for _ in range(progress.CHECK_IN_AFTER):
            self.assertIsNone(self.call())

    def test_a_reply_of_tool_calls_alone_does_not(self) -> None:
        for _ in range(progress.CHECK_IN_AFTER):
            self.call()
        self.model_call(0)
        self.assertIsNotNone(self.call())

    def test_a_reply_without_the_count_still_counts_as_speaking(self) -> None:
        progress.after_model_call(
            session_id=SESSION, turn_id=TURN, assistant_message={"content": "Done."}
        )
        for _ in range(progress.CHECK_IN_AFTER):
            self.assertIsNone(self.call())

    def test_a_new_turn_starts_at_zero(self) -> None:
        for _ in range(progress.CHECK_IN_AFTER):
            self.call()
        progress.turn_started(session_id=SESSION, turn_id="turn-2")
        self.assertIsNone(self.call(turn="turn-2"))

    def test_two_sessions_are_counted_apart(self) -> None:
        for _ in range(progress.CHECK_IN_AFTER):
            self.call()
        self.assertIsNone(self.call(session="memento-other"))

    def test_another_surfaces_session_is_left_alone(self) -> None:
        # A CLI or Telegram session is nothing the app draws, so there is no update to ask for.
        for _ in range(progress.CHECK_IN_AFTER + 1):
            self.assertIsNone(self.call(session="20261029_101500_ab12cd"))

    def test_a_delegated_child_is_left_alone(self) -> None:
        # A subagent's own "reply" reaches its parent, not the user, so it is never asked to check in.
        for _ in range(progress.CHECK_IN_AFTER + 1):
            self.assertIsNone(self.call(session="sa-k3j9"))

    def test_the_table_does_not_grow_without_bound(self) -> None:
        for index in range(progress.KEEP_SESSIONS + 10):
            self.call(session=f"{progress.SESSION_PREFIX}{index}")
        self.assertLessEqual(len(progress._calls), progress.KEEP_SESSIONS)


if __name__ == "__main__":
    unittest.main()
