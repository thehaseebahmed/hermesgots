"""A long silent tool loop is asked to check in: which calls count, what restarts the count, and
that a model which ignores the ask is never stuck.

Run: python3 -m unittest plugin.tests.test_progress -v
"""

from __future__ import annotations

import unittest
from typing import Dict, List, Optional

from plugin import progress

SESSION = "memento-abc"
TURN = "turn-1"
# An AFK run's own id, minted by afk.new_session_id.
AFK_SESSION = "memento-afk-1a2b3c4d5e6f"


class ProgressTest(unittest.TestCase):
    def setUp(self) -> None:
        progress._calls.clear()
        self.addCleanup(progress._calls.clear)

    def call(
        self, session: str = SESSION, turn: str = TURN, status: Optional[str] = None
    ) -> Optional[Dict[str, str]]:
        """One tool call as Hermes runs it: the policy hook before it, then the observer with the
        call's status — blocked when this hook refused it, else whatever the caller asked for.
        Hermes sends no status for a call that simply ran."""
        blocked = progress.before_tool(
            tool_name="read_file", args={}, task_id=session, session_id=session, turn_id=turn
        )
        progress.after_tool(
            tool_name="read_file", args={}, task_id=session, session_id=session, turn_id=turn,
            status="blocked" if blocked else status,
        )
        return blocked

    def calls(
        self, count: int = progress.CHECK_IN_AFTER, session: str = SESSION
    ) -> List[Optional[Dict[str, str]]]:
        """What the hook answered a full stretch of the turn's calls."""
        return [self.call(session=session) for _ in range(count)]

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

    def test_a_call_a_policy_blocked_is_not_counted(self) -> None:
        # Plan mode blocks every mutating call of a turn; none of them ran, so none is silent work
        # the user waited on, and a run of them must never reach the ask.
        blocked_elsewhere = [self.call(status="blocked") for _ in range(progress.CHECK_IN_AFTER + 5)]
        self.assertEqual(blocked_elsewhere, [None] * len(blocked_elsewhere))

    def test_a_reply_with_text_starts_a_new_stretch(self) -> None:
        self.calls()
        self.model_call(120)
        self.assertEqual(self.calls(), [None] * progress.CHECK_IN_AFTER)

    def test_a_reply_of_tool_calls_alone_does_not(self) -> None:
        self.calls()
        self.model_call(0)
        self.assertIsNotNone(self.call())

    def test_a_reply_without_the_count_still_counts_as_speaking(self) -> None:
        # A host too old to count the characters is read from the message it sent. The stretch is
        # spent first, so what the second stretch proves is the reset and nothing else.
        self.calls()
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
        spent = progress.CHECK_IN_AFTER + 1
        for session in ("20261029_101500_ab12cd", "sa-k3j9"):
            self.assertEqual(self.calls(spent, session=session), [None] * spent)

    def test_an_afk_run_is_left_alone(self) -> None:
        # Nobody watches an AFK stage, and its prompt already asks for the update, so a blocked call
        # there would cost the stage a step and tell the user nothing new.
        spent = progress.CHECK_IN_AFTER + 1
        self.assertEqual(self.calls(spent, session=AFK_SESSION), [None] * spent)

    def test_the_table_does_not_grow_without_bound(self) -> None:
        for index in range(progress.KEEP_SESSIONS + 10):
            self.call(session=f"memento-{index}")
        self.assertLessEqual(len(progress._calls), progress.KEEP_SESSIONS)


if __name__ == "__main__":
    unittest.main()
