"""A token mint: the shape, the hash kept in the token's place, the compare, and the optional life.

Nothing here reaches a route or names a kind of token. A key is a string the caller spells and a life
is the caller's to state; what is pinned is the mechanic every kind keeping a token shares, so a
second kind is a wrapper over this.
"""

from __future__ import annotations

import hashlib
import re
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from plugin import store, token_mint

KEY = "one"
OTHER = "two"
MINTED = 1_700_000_000_000
LIFE = 600_000


class Mints(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.path = Path(tmp.name) / "gots.db"

    def held(self, key: str = KEY):
        return store.get_setting(self.path, key)

    def clock(self, moment: int):
        """The module's clock, held at ``moment`` so a life is judged without waiting one out."""
        return mock.patch.object(token_mint, "now_ms", lambda: moment)

    def test_a_minted_token_is_kept_as_its_hash_and_never_written_whole(self) -> None:
        token = token_mint.mint(self.path, KEY)
        self.assertRegex(token, token_mint.TOKEN, "a token a caller can hand on")
        self.assertEqual(self.held()["sha256"], hashlib.sha256(token.encode("utf-8")).hexdigest())
        self.assertNotIn(
            token.encode("utf-8"), self.path.read_bytes(), "the token is nowhere in the store"
        )

    def test_a_second_mint_spends_the_first_into_one_row(self) -> None:
        first = token_mint.mint(self.path, KEY)
        second = token_mint.mint(self.path, KEY)
        self.assertNotEqual(first, second, "minting again mints a new one")
        self.assertFalse(token_mint.verify(self.path, KEY, first, lifetime=None), "and spends the first")
        self.assertTrue(token_mint.verify(self.path, KEY, second, lifetime=None))
        self.assertEqual(sorted(self.held()), ["at", "sha256"], "one token per key, not a list of them")

    def test_two_keys_are_two_doors(self) -> None:
        token = token_mint.mint(self.path, KEY)
        token_mint.mint(self.path, OTHER)
        self.assertTrue(token_mint.verify(self.path, KEY, token, lifetime=None))
        self.assertFalse(
            token_mint.verify(self.path, OTHER, token, lifetime=None), "one key's token is not another's"
        )

    def test_a_store_nothing_was_minted_on_refuses_every_token(self) -> None:
        self.assertFalse(token_mint.verify(self.path, KEY, "0" * 64, lifetime=None))
        self.assertFalse(
            token_mint.verify(self.path, KEY, "0" * 64, lifetime=LIFE),
            "a life answers nothing about a key nothing was minted under",
        )
        self.assertIsNone(self.held(), "and reading one mints nothing")

    def test_the_shape_is_the_width_a_token_is_minted_at(self) -> None:
        width = token_mint.TOKEN_BYTES * 2
        self.assertRegex("0" * width, token_mint.TOKEN)
        for value in ("0" * (width - 1), "0" * (width + 1), "A" * width, "0" * width + "\n"):
            with self.subTest(width=len(value)):
                self.assertIsNone(token_mint.TOKEN.match(value))

    def test_a_presented_string_of_the_wrong_shape_is_refused_rather_than_raising(self) -> None:
        token_mint.mint(self.path, KEY)
        for value in ("", "nope", "0" * 63, "0" * 65, "A" * 64, None, 42):
            with self.subTest(value=value):
                self.assertFalse(token_mint.verify(self.path, KEY, value, lifetime=None))

    def test_a_row_whose_hash_is_not_a_shaped_string_is_refused(self) -> None:
        for held in (
            {},
            {"at": MINTED},
            {"sha256": "nope"},
            {"sha256": 7},
            {"sha256": "é" * 32},
            {"sha256": "0" * 64 + "\n"},
            "not a row",
        ):
            with self.subTest(held=held):
                store.put_setting(self.path, KEY, held)
                self.assertFalse(token_mint.verify(self.path, KEY, "0" * 64, lifetime=None))

    def test_a_short_lived_token_is_live_up_to_its_last_millisecond(self) -> None:
        with self.clock(MINTED):
            token = token_mint.mint(self.path, KEY)
        with self.clock(MINTED + LIFE):
            self.assertTrue(
                token_mint.verify(self.path, KEY, token, lifetime=LIFE),
                "the last millisecond is inside the life",
            )
        with self.clock(MINTED + LIFE + 1):
            self.assertFalse(
                token_mint.verify(self.path, KEY, token, lifetime=LIFE), "one past it, the door is shut"
            )

    def test_a_token_minted_long_ago_still_verifies_with_no_life(self) -> None:
        with self.clock(MINTED):
            token = token_mint.mint(self.path, KEY)
        with self.clock(MINTED + LIFE * 100):
            self.assertTrue(
                token_mint.verify(self.path, KEY, token, lifetime=None), "forever does not look at the stamp"
            )

    def test_a_row_with_no_moment_to_measure_from_is_dead_only_under_a_life(self) -> None:
        token = token_mint.mint(self.path, KEY)
        known = self.held()["sha256"]
        for row in (
            {"sha256": known},
            {"sha256": known, "at": "yesterday"},
            {"sha256": known, "at": True},
            {"sha256": known, "at": float("Infinity")},
        ):
            with self.subTest(row=row):
                store.put_setting(self.path, KEY, row)
                self.assertFalse(
                    token_mint.verify(self.path, KEY, token, lifetime=LIFE),
                    "a life has no moment to be measured from",
                )
                self.assertTrue(
                    token_mint.verify(self.path, KEY, token, lifetime=None),
                    "and the row still answers with no life stated",
                )

    def test_a_row_is_judged_at_its_digests_width_whatever_the_token_width_is(self) -> None:
        narrow = re.compile(rf"\A[0-9a-f]{{{16 * 2}}}\Z")
        with (
            mock.patch.object(token_mint, "TOKEN_BYTES", 16),
            mock.patch.object(token_mint, "TOKEN", narrow),
        ):
            token = token_mint.mint(self.path, KEY)
            self.assertTrue(
                token_mint.verify(self.path, KEY, token, lifetime=None),
                "a narrower token still leaves a 64-hex digest in the row",
            )


if __name__ == "__main__":
    unittest.main()
