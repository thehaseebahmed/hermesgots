"""A bot's talk token: minted for a charm to speak with, kept as its hash, never answered twice.

Nothing here reaches a route. A token's rule is what the store keeps and what a presented string is
judged against; ``plugin/tests/test_talk_route.py`` is where the app is handed one.
"""

from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from plugin import store, talk_tokens

BOT = "0123456789abcdef"
OTHER = "fedcba9876543210"


class Tokens(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.path = Path(tmp.name) / "gots.db"

    def held(self, bot: str = BOT):
        return store.get_setting(self.path, f"{talk_tokens.SETTING}:{bot}")

    def test_a_minted_token_is_kept_as_its_hash(self) -> None:
        token = talk_tokens.mint(self.path, BOT)
        self.assertRegex(token, talk_tokens.TOKEN, "a token the app can hand a charm")
        kept = self.held()
        self.assertNotIn(token, json.dumps(kept), "the token itself is never written")
        self.assertEqual(kept["sha256"], hashlib.sha256(token.encode("utf-8")).hexdigest())
        self.assertNotIn(token.encode("utf-8"), self.path.read_bytes(), "nor anywhere in the store")

    def test_the_token_a_bot_was_minted_verifies_for_that_bot_alone(self) -> None:
        token = talk_tokens.mint(self.path, BOT)
        self.assertTrue(talk_tokens.verify(self.path, BOT, token))
        self.assertFalse(talk_tokens.verify(self.path, OTHER, token), "one bot's token is not another's")

    def test_a_second_mint_replaces_the_first(self) -> None:
        first = talk_tokens.mint(self.path, BOT)
        second = talk_tokens.mint(self.path, BOT)
        self.assertNotEqual(first, second, "re-provisioning mints a new one")
        self.assertFalse(talk_tokens.verify(self.path, BOT, first), "and the charm's old token is spent")
        self.assertTrue(talk_tokens.verify(self.path, BOT, second))
        self.assertEqual(list(self.held()), ["sha256", "at"], "one token per bot, not a list of them")

    def test_a_bot_no_token_was_minted_for_is_refused(self) -> None:
        talk_tokens.mint(self.path, BOT)
        self.assertFalse(talk_tokens.verify(self.path, OTHER, talk_tokens.mint(self.path, OTHER)[::-1]))
        self.assertFalse(talk_tokens.verify(self.path, OTHER, "0" * 64), "and a guess is not one")

    def test_a_token_on_a_store_nothing_was_minted_on_is_refused(self) -> None:
        self.assertFalse(talk_tokens.verify(self.path, BOT, "0" * 64))

    def test_a_bot_id_that_is_not_one_is_refused(self) -> None:
        for value in ("", "a bot", "a" * 65, None, 7):
            with self.subTest(value=value):
                with self.assertRaises(talk_tokens.TalkTokenError):
                    talk_tokens.mint(self.path, value)

    def test_a_string_that_is_not_a_token_is_refused_rather_than_raising(self) -> None:
        talk_tokens.mint(self.path, BOT)
        for value in ("", "nope", "0" * 63, "0" * 65, "A" * 64, None, 42):
            with self.subTest(value=value):
                self.assertFalse(talk_tokens.verify(self.path, BOT, value))


if __name__ == "__main__":
    unittest.main()
