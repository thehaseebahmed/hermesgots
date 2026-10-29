"""A long silent tool loop is asked to check in: the count of continuous calls, what resets it, and
that a model which ignores the ask is never stuck.

Run: python3 -m unittest plugin.tests.test_progress -v
"""

from __future__ import annotations

import unittest
from typing import Dict, List, Optional

from plugin import progress

SESSION = "memento-abc"
TURN = "turn-1"


class ProgressTest(unittest.TestCase):
    def setUp(self) -> None:
        progress._calls.clear()
        self.addCleanup(progress._calls.clear)

    def call(self, session: str = SESSION, turn: str = TURN) -> Optional[Dict[str, str]]:
        return progress.before_tool(
            tool_name="read_file", args={}, task_id=session, session_id=session, turn_id=turn
        )

    def calls(self, count: int = progress.CHECK_IN_AFTER) -> List[Optional[Dict[str, str]]]:
        """What the hook answered a full stretch of the turn's calls."""
        return [self.call() for _ in range(count)]

    def model_call(self, chars: int, session: str = SESSION, turn: str = TURN) -> None:
        progress.after_model_call(
            session_id=session, task_id=session, turn_id=turn, assistant_content_chars=chars
        )

    def test_the_calls_before_the_check_in_run(self) -> None:
        self.assertEqual(self.calls(), [None] * progress.CHECK_IN_AFTER)

    def test_the_call_after_them_asks_for_an_update(self) -> None:
        self.calls()
        blocked = self.call()
        self.assertEqual(blocked["action"], "block")
        self.assertIn(f"{progress.CHECK_IN_AFTER} tool calls", blocked["message"])
        self.assertIn("update", blocked["message"])

    def test_a_model_ignoring_the_ask_gets_its_tool_back(self) -> None:
        # The block must not be a wall: the same call goes through next, or the turn could never end.
        self.calls()
        self.assertIsNotNone(self.call())
        self.assertIsNone(self.call())

    def test_asking_again_takes_another_full_stretch(self) -> None:
        self.calls(progress.CHECK_IN_AFTER + 1)
        self.assertEqual(self.calls(), [None] * progress.CHECK_IN_AFTER)
        self.assertIsNotNone(self.call())

    def test_a_reply_with_text_starts_a_new_stretch(self) -> None:
        self.calls()
        self.model_call(120)
        self.assertEqual(self.calls(), [None] * progress.CHECK_IN_AFTER)

    def test_a_reply_of_tool_calls_alone_does_not(self) -> None:
        self.calls()
        self.model_call(0)
        self.assertIsNotNone(self.call())

    def test_a_reply_without_the_count_still_counts_as_speaking(self) -> None:
        # A host too old to count the characters is read from the message it sent.
        progress.after_model_call(
            session_id=SESSION, turn_id=TURN, assistant_message={"content": "Done."}
        )
        self.assertEqual(self.calls(), [None] * progress.CHECK_IN_AFTER)

    def test_a_new_turn_starts_at_zero(self) -> None:
        self.calls()
        progress.turn_started(session_id=SESSION, turn_id="turn-2")
        self.assertIsNone(self.call(turn="turn-2"))

    def test_two_sessions_are_counted_apart(self) -> None:
        self.calls()
        self.assertIsNone(self.call(session="memento-other"))

    def test_a_session_that_is_not_gots_is_left_alone(self) -> None:
        # A CLI or Telegram session is nothing the app draws, and a delegated child is a session of
        # its own whose reply reaches its parent, not the user: neither has an update to ask for.
        for session in ("20261029_101500_ab12cd", "sa-k3j9"):
            for _ in range(progress.CHECK_IN_AFTER + 1):
                self.assertIsNone(self.call(session=session))

    def test_the_table_does_not_grow_without_bound(self) -> None:
        for index in range(progress.KEEP_SESSIONS + 10):
            self.call(session=f"memento-{index}")
        self.assertLessEqual(len(progress._calls), progress.KEEP_SESSIONS)


if __name__ == "__main__":
    unittest.main()
