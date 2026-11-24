"""A charm's firmware fetch token: its own mint kind, kept as its hash, dead after its short life.

Nothing here reaches a route. A token's rule is what the store keeps and what a presented string is
judged against; ``plugin/tests/test_firmware.py`` is where the phone is handed one and the charm's
fetch is admitted by it. The one fact this suite pins beside the token's own rule is the plan's own
decision: minting a fetch token never touches the token the charm's voice holds — the talk mint
revokes on a re-mint, so a firmware fetch that reused it would cost a working charm its voice
mid-update.
"""

from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from plugin import fetch_tokens, store, talk_tokens

BOT = "0123456789abcdef"


class Tokens(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.path = Path(tmp.name) / "gots.db"

    def held(self):
        return store.get_setting(self.path, fetch_tokens.SETTING)

    def test_a_minted_token_is_kept_as_its_hash(self) -> None:
        token = fetch_tokens.mint(self.path)
        self.assertRegex(token, fetch_tokens.TOKEN, "a token the phone can hand a charm")
        kept = self.held()
        self.assertNotIn(token, json.dumps(kept), "the token itself is never written")
        self.assertEqual(kept["sha256"], hashlib.sha256(token.encode("utf-8")).hexdigest())
        self.assertNotIn(token.encode("utf-8"), self.path.read_bytes(), "nor anywhere in the store")

    def test_the_token_a_mint_answers_is_the_one_a_fetch_is_admitted_by(self) -> None:
        token = fetch_tokens.mint(self.path)
        self.assertTrue(fetch_tokens.verify(self.path, token))
        self.assertFalse(fetch_tokens.verify(self.path, token[::-1]), "a guess is not one")
        self.assertFalse(fetch_tokens.verify(self.path, "0" * 64), "and nor is a shape nothing minted")

    def test_a_second_mint_spends_the_first(self) -> None:
        first = fetch_tokens.mint(self.path)
        second = fetch_tokens.mint(self.path)
        self.assertNotEqual(first, second, "asking again mints a new one")
        self.assertFalse(fetch_tokens.verify(self.path, first), "and the first door is closed")
        self.assertTrue(fetch_tokens.verify(self.path, second))
        self.assertEqual(list(self.held()), ["sha256", "at"], "one token, not a list of them")

    def test_a_string_that_is_not_a_token_is_refused_rather_than_raising(self) -> None:
        fetch_tokens.mint(self.path)
        for value in ("", "nope", "0" * 63, "0" * 65, "A" * 64, None, 42):
            with self.subTest(value=value):
                self.assertFalse(fetch_tokens.verify(self.path, value))

    def test_a_store_nothing_was_minted_on_refuses_every_token(self) -> None:
        self.assertFalse(fetch_tokens.verify(self.path, "0" * 64))

    def test_a_tokens_shape_is_the_length_it_is_minted_at(self) -> None:
        width = fetch_tokens.TOKEN_BYTES * 2
        self.assertRegex("0" * width, fetch_tokens.TOKEN)
        for value in ("0" * (width - 1), "0" * (width + 1)):
            with self.subTest(value=value):
                self.assertIsNone(fetch_tokens.TOKEN.match(value))

    def test_a_token_lives_only_its_short_life(self) -> None:
        clock = [store.now_ms()]
        with mock.patch.object(fetch_tokens, "now_ms", lambda: clock[0]):
            minted = fetch_tokens.mint(self.path)
            self.assertTrue(fetch_tokens.verify(self.path, minted), "fresh from the mint")
            clock[0] += fetch_tokens.TTL_MS
            self.assertTrue(
                fetch_tokens.verify(self.path, minted),
                "the last moment of the life is still inside it",
            )
            clock[0] += 1
            self.assertFalse(
                fetch_tokens.verify(self.path, minted),
                "one millisecond past the life the door is shut",
            )

    def test_a_row_nobody_minted_is_refused(self) -> None:
        # A row a later hand-edit or a broken write leaves without its clock is not a live token.
        for value in ({}, {"sha256": "0" * 64}, {"sha256": "0" * 64, "at": "then"}, None):
            with self.subTest(value=value):
                store.put_setting(self.path, fetch_tokens.SETTING, value)
                self.assertFalse(fetch_tokens.verify(self.path, "0" * 64))

    def test_minting_a_fetch_token_never_revokes_the_charms_voice(self) -> None:
        """The plan's own decision: the talk mint revokes on a re-mint, so this is its own kind."""
        voice = talk_tokens.mint(self.path, BOT)
        fetch_tokens.mint(self.path)
        self.assertTrue(
            talk_tokens.verify(self.path, BOT, voice),
            "and the token the charm's voice holds is still the one this host honours",
        )
        self.assertNotEqual(fetch_tokens.SETTING, talk_tokens.SETTING, "two kinds, two rows")
        again = fetch_tokens.mint(self.path)
        self.assertTrue(fetch_tokens.verify(self.path, again))
        self.assertTrue(
            talk_tokens.verify(self.path, BOT, voice),
            "a re-mint of the fetch kind spends nothing of the voice's either",
        )


if __name__ == "__main__":
    unittest.main()
