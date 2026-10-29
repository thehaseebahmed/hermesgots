"""Progress reminders: the bot's level sets how often it is asked, which calls count, and that a
model which ignores the reminder is never stuck.

Run: python3 -m unittest plugin.tests.test_progress -v
"""

from __future__ import annotations

import unittest
from typing import Dict, List, Optional

from plugin import progress
from plugin.store import db_path, put_setting
from plugin.tests._helpers import temp_hermes_home

SESSION = "memento-abc"
TURN = "turn-1"
# An AFK run's own id, minted by afk.new_session_id: it follows the bot's level like any other chat.
AFK_SESSION = "memento-afk-1a2b3c4d5e6f"


class ProgressTest(unittest.TestCase):
    def setUp(self) -> None:
        progress._calls.clear()
        self.addCleanup(progress._calls.clear)
        self.home = temp_hermes_home(self)
        self.store = db_path(self.home)

    def at(self, level: str) -> None:
        """What this bot's host holds for it."""
        progress.set_level(self.store, level)

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
        self, count: int, session: str = SESSION
    ) -> List[Optional[Dict[str, str]]]:
        """What the hook answered a stretch of the turn's calls."""
        return [self.call(session=session) for _ in range(count)]

    def model_call(self, chars: int, session: str = SESSION, turn: str = TURN) -> None:
        progress.after_model_call(
            session_id=session, task_id=session, turn_id=turn, assistant_content_chars=chars
        )

    # The bot's level -------------------------------------------------------

    def test_a_bot_that_chose_nothing_is_asked_at_normal(self) -> None:
        self.assertEqual(progress.level(self.store), progress.DEFAULT_LEVEL)
        self.assertEqual(self.calls(progress.AFTER["normal"]), [None] * progress.AFTER["normal"])
        self.assertIsNotNone(self.call())

    def test_a_frequent_bot_is_asked_sooner(self) -> None:
        self.at("frequent")
        sooner = progress.AFTER["frequent"]
        self.assertEqual(self.calls(sooner), [None] * sooner)
        blocked = self.call()
        self.assertEqual(blocked["action"], "block")
        self.assertIn(f"{sooner} tool calls", blocked["message"])

    def test_an_off_bot_is_never_asked(self) -> None:
        self.at("off")
        self.assertEqual(self.calls(100), [None] * 100)

    def test_a_level_changed_mid_stretch_lands_on_the_next_call(self) -> None:
        self.calls(progress.AFTER["frequent"] + 4)
        self.at("frequent")
        self.assertIsNotNone(self.call())
        self.at("off")
        self.assertIsNone(self.call())

    def test_a_value_the_host_does_not_know_reads_as_normal(self) -> None:
        put_setting(self.store, progress.LEVEL_KEY, "loud")
        self.assertEqual(progress.level(self.store), progress.DEFAULT_LEVEL)

    def test_an_unreadable_store_reads_as_normal(self) -> None:
        # The path a store is opened at, holding a directory: the read raises, and a host that can't
        # answer must not take the reminders away from every bot.
        broken = db_path(self.home)
        broken.parent.mkdir(parents=True, exist_ok=True)
        broken.mkdir()
        self.assertEqual(progress.level(broken), progress.DEFAULT_LEVEL)

    def test_an_unknown_level_is_refused_rather_than_stored(self) -> None:
        with self.assertRaises(ValueError):
            progress.set_level(self.store, "shouty")
        self.assertEqual(progress.level(self.store), progress.DEFAULT_LEVEL)

    def test_two_bots_keep_their_own(self) -> None:
        other = temp_hermes_home(self)
        self.at("off")
        progress.set_level(db_path(other), "frequent")
        self.assertEqual(progress.level(self.store), "off")
        self.assertEqual(progress.level(db_path(other)), "frequent")

    def test_the_record_names_the_level_and_the_levels_a_client_may_send(self) -> None:
        self.assertEqual(
            progress.record("frequent"),
            {"object": progress.OBJECT, "level": "frequent", "levels": ["off", "normal", "frequent"]},
        )

    # The count ------------------------------------------------------------

    def test_the_reminder_asks_for_an_update(self) -> None:
        self.calls(progress.AFTER["normal"])
        blocked = self.call()
        self.assertEqual(blocked["action"], "block")
        self.assertIn("update", blocked["message"])

    def test_a_model_ignoring_the_reminder_gets_its_tool_back(self) -> None:
        # The block must not be a wall: the same call goes through next, or the turn could never end.
        self.calls(progress.AFTER["normal"])
        self.assertIsNotNone(self.call())
        self.assertIsNone(self.call())

    def test_asking_again_takes_another_full_stretch(self) -> None:
        stretch = progress.AFTER["normal"]
        self.calls(stretch + 1)
        self.assertEqual(self.calls(stretch), [None] * stretch)
        self.assertIsNotNone(self.call())

    def test_a_call_a_policy_blocked_is_not_counted(self) -> None:
        # Plan mode blocks every mutating call of a turn; none of them ran, so none is silent work
        # the user waited on, and a run of them must never reach the reminder.
        blocked_elsewhere = [self.call(status="blocked") for _ in range(progress.AFTER["normal"] + 5)]
        self.assertEqual(blocked_elsewhere, [None] * len(blocked_elsewhere))

    def test_a_reply_with_text_starts_a_new_stretch(self) -> None:
        stretch = progress.AFTER["normal"]
        self.calls(stretch)
        self.model_call(120)
        self.assertEqual(self.calls(stretch), [None] * stretch)

    def test_a_reply_of_tool_calls_alone_does_not(self) -> None:
        self.calls(progress.AFTER["normal"])
        self.model_call(0)
        self.assertIsNotNone(self.call())

    def test_a_reply_without_the_count_still_counts_as_speaking(self) -> None:
        # A host too old to count the characters is read from the message it sent. The stretch is
        # spent first, so what the second stretch proves is the reset and nothing else.
        self.calls(progress.AFTER["normal"])
        progress.after_model_call(
            session_id=SESSION, turn_id=TURN, assistant_message={"content": "Done."}
        )
        self.assertEqual(self.calls(progress.AFTER["normal"]), [None] * progress.AFTER["normal"])

    def test_a_new_turn_starts_at_zero(self) -> None:
        self.calls(progress.AFTER["normal"])
        progress.turn_started(session_id=SESSION, turn_id="turn-2")
        self.assertIsNone(self.call(turn="turn-2"))

    def test_two_sessions_are_counted_apart(self) -> None:
        self.calls(progress.AFTER["normal"])
        self.assertIsNone(self.call(session="memento-other"))

    def test_an_afk_run_follows_the_same_level(self) -> None:
        # Nothing is watching a stage, but its transcript is what the user reads afterwards, so it is
        # asked like any other chat rather than left silent.
        self.calls(progress.AFTER["normal"], session=AFK_SESSION)
        self.assertIsNotNone(self.call(session=AFK_SESSION))

    def test_a_session_that_is_not_gots_is_left_alone(self) -> None:
        # A CLI or Telegram session is nothing the app draws, and a delegated child is a session of
        # its own whose reply reaches its parent, not the user.
        spent = progress.AFTER["normal"] + 1
        for session in ("20261029_101500_ab12cd", "sa-k3j9"):
            self.assertEqual(self.calls(spent, session=session), [None] * spent)

    def test_the_table_does_not_grow_without_bound(self) -> None:
        for index in range(progress.KEEP_SESSIONS + 10):
            self.call(session=f"memento-{index}")
        self.assertLessEqual(len(progress._calls), progress.KEEP_SESSIONS)


if __name__ == "__main__":
    unittest.main()
