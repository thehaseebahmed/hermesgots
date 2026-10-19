"""A bot's fallback models: what the Gots plugin keeps in its profile's config.yaml.

They are Hermes's own failover chain, at the top of the file, so these tests pin the keys Hermes
reads (``fallback_providers``, and the legacy ``fallback_model`` Hermes still accepts) and what a
write leaves in the file.

Run: python3 -m unittest plugin.tests.test_host_model_fallbacks -v
"""

from __future__ import annotations

import unittest
from pathlib import Path

from plugin import host_model
from plugin.tests._host import Result, hermes


class CleanFallbacksTest(unittest.TestCase):
    def test_trims_and_keeps_order(self) -> None:
        self.assertEqual(
            host_model.clean_fallbacks(
                {"fallbacks": [{"provider": " openrouter ", "model": " a/b "}, {"provider": "deepseek", "model": "deepseek-v4-pro"}]}
            ),
            [{"provider": "openrouter", "model": "a/b"}, {"provider": "deepseek", "model": "deepseek-v4-pro"}],
        )

    def test_missing_key_clears(self) -> None:
        self.assertEqual(host_model.clean_fallbacks({}), [])
        self.assertEqual(host_model.clean_fallbacks({"fallbacks": None}), [])

    def test_a_bad_entry_names_itself(self) -> None:
        for body in (None, [], "openrouter/x", 3):
            with self.assertRaisesRegex(ValueError, "Body must be a JSON object"):
                host_model.clean_fallbacks(body)
        for entries, complaint in (
            ("openrouter/x", "fallbacks must be a list"),
            (["openrouter"], "Fallback 1 must be an object"),
            ([{"provider": "openrouter"}], "Fallback 1 needs a model"),
            ([{"model": "a/b"}], "Fallback 1 needs a provider"),
            ([{"provider": "a", "model": "x"}, {"provider": "", "model": "x"}], "Fallback 2 needs a provider"),
            ([{"provider": "a", "model": 3}], "Fallback 1 needs a model"),
        ):
            with self.assertRaisesRegex(ValueError, complaint):
                host_model.clean_fallbacks({"fallbacks": entries})


class SetFallbacksTest(unittest.TestCase):
    path = Path("/home/h/config.yaml")

    def config(self, **top):
        return {
            "model": {"default": "old", "provider": "openrouter", "base_url": "https://x"},
            "display": {"skin": "ares"},
            **top,
        }

    def test_the_picks_become_hermes_chain_in_order(self) -> None:
        patch, calls, _ = hermes(self.config())
        with patch:
            saved = host_model.set_fallbacks(
                self.path,
                [{"provider": "openrouter", "model": "anthropic/claude-sonnet-4.5"}, {"provider": "deepseek", "model": "deepseek-v4-pro"}],
            )
        self.assertEqual(
            saved,
            [{"provider": "openrouter", "model": "anthropic/claude-sonnet-4.5"}, {"provider": "deepseek", "model": "deepseek-v4-pro"}],
        )
        # Hermes's own chain key, at the top of the file. There is no legacy key to drop, so the
        # usual write is one pass over the file, and every other key stays put.
        self.assertEqual(
            calls["write"],
            [(self.path, "fallback_providers", saved)],
        )
        self.assertEqual(calls["switch"][0]["current_model"], "old")
        self.assertEqual(calls["switch"][0]["current_base_url"], "https://x")
        self.assertTrue(calls["switch"][0]["is_global"])

    def test_clearing_leaves_nothing_behind(self) -> None:
        patch, calls, config = hermes(self.config(fallback_providers=[{"provider": "openrouter", "model": "a/b"}]))
        with patch:
            self.assertEqual(host_model.set_fallbacks(self.path, []), [])
        self.assertEqual(calls["write"], [(self.path, "fallback_providers", None)])
        self.assertEqual(calls["switch"], [])
        self.assertEqual(config.get("fallback_providers"), None)

    def test_three_is_too_many(self) -> None:
        entry = {"provider": "openrouter", "model": "a/b"}
        patch, calls, _ = hermes(self.config())
        with patch, self.assertRaisesRegex(ValueError, "at most 2 fallback models"):
            host_model.set_fallbacks(self.path, [entry, entry, {"provider": "deepseek", "model": "c/d"}])
        self.assertEqual(calls["write"], [])
        self.assertEqual(calls["switch"], [])

    def test_a_longer_chain_can_be_shortened_but_not_grown(self) -> None:
        # Three picks a user built with ``hermes fallback``: the app may take one away (that is what
        # its rows show) but may not add a fourth.
        three = [{"provider": "openrouter", "model": "a/b"}, {"provider": "deepseek", "model": "c/d"}, {"provider": "anthropic", "model": "e/f"}]
        patch, calls, _ = hermes(self.config(fallback_providers=list(three)))
        with patch:
            self.assertEqual(len(host_model.set_fallbacks(self.path, three[:2])), 2)
        self.assertEqual(calls["write"][0][2], three[:2])
        patch, calls, _ = hermes(self.config(fallback_providers=list(three)))
        with patch, self.assertRaisesRegex(ValueError, "at most 2 fallback models"):
            host_model.set_fallbacks(self.path, three + [{"provider": "ollama-cloud", "model": "g/h"}])
        self.assertEqual(calls["write"], [])

    def test_a_refused_pick_writes_nothing(self) -> None:
        refusal = Result(False, error="Unknown provider 'nope'.")
        patch, calls, _ = hermes(self.config(), [Result(True, "a/b", "openrouter"), refusal])
        with patch, self.assertRaisesRegex(ValueError, "Unknown provider 'nope'"):
            host_model.set_fallbacks(
                self.path, [{"provider": "openrouter", "model": "a/b"}, {"provider": "nope", "model": "c/d"}]
            )
        self.assertEqual(calls["write"], [])

    def test_the_hosts_resolved_names_are_what_gets_recorded(self) -> None:
        patch, _, _ = hermes(self.config(), [Result(True, "claude-sonnet-4.5", "anthropic")])
        with patch:
            saved = host_model.set_fallbacks(self.path, [{"provider": "anthropic", "model": "sonnet"}])
        self.assertEqual(saved, [{"provider": "anthropic", "model": "claude-sonnet-4.5"}])

    def test_a_hand_written_entry_keeps_what_it_carried(self) -> None:
        # A relay's entry holds its endpoint and credential; the app only knows provider and model,
        # so an edit that leaves that route alone must not strip them.
        relay = {"provider": "relay", "model": "gpt-5", "base_url": "https://relay.example/v1", "api_key": "sk-x"}
        patch, _, _ = hermes(self.config(fallback_providers=[relay]))
        with patch:
            saved = host_model.set_fallbacks(
                self.path, [{"provider": "relay", "model": "gpt-5"}, {"provider": "deepseek", "model": "deepseek-v4-pro"}]
            )
        self.assertEqual(saved[0], relay)
        self.assertEqual(saved[1], {"provider": "deepseek", "model": "deepseek-v4-pro"})

    def test_a_kept_pick_is_not_checked_again(self) -> None:
        # A pick already in the chain is one Hermes resolved when it went in: re-checking it would
        # spend a live provider probe on a pick that hasn't moved, and could refuse a chain that is
        # already running. Only the new pick is checked.
        stored = {"provider": "openrouter", "model": "a/b"}
        patch, calls, _ = hermes(self.config(fallback_providers=[stored]))
        with patch:
            saved = host_model.set_fallbacks(
                self.path, [dict(stored), {"provider": "deepseek", "model": "c/d"}]
            )
        self.assertEqual(saved, [stored, {"provider": "deepseek", "model": "c/d"}])
        self.assertEqual([call["raw_input"] for call in calls["switch"]], ["c/d"])

    def test_the_legacy_key_is_dropped(self) -> None:
        legacy = {"provider": "openrouter", "model": "a/b", "base_url": "https://x"}
        patch, calls, config = hermes(self.config(fallback_model=dict(legacy)))
        with patch:
            saved = host_model.set_fallbacks(self.path, [{"provider": "openrouter", "model": "a/b"}])
        self.assertEqual(calls["write"][-1], (self.path, "fallback_model", None))
        # The chain reads back as the one entry it is, not the same route twice.
        self.assertEqual(saved, [legacy])
        self.assertEqual(config.get("fallback_model"), None)


class ReadFallbacksTest(unittest.TestCase):
    path = Path("/home/h/config.yaml")

    def test_reads_what_was_written(self) -> None:
        config = {"model": {"default": "old", "provider": "openrouter"}}
        patch, _, _ = hermes(config)
        written = [{"provider": "openrouter", "model": "a/b"}, {"provider": "deepseek", "model": "deepseek-v4-pro"}]
        with patch:
            host_model.set_fallbacks(self.path, written)
            self.assertEqual(host_model.read_fallbacks(self.path), written)

    def test_the_legacy_entry_is_part_of_the_chain(self) -> None:
        patch, _, _ = hermes(
            {
                "fallback_providers": [{"provider": "openrouter", "model": "a/b"}],
                "fallback_model": {"provider": "deepseek", "model": "c/d"},
            }
        )
        with patch:
            self.assertEqual(
                host_model.read_fallbacks(self.path),
                [{"provider": "openrouter", "model": "a/b"}, {"provider": "deepseek", "model": "c/d"}],
            )

    def test_an_entry_comes_back_as_provider_and_model_only(self) -> None:
        patch, _, _ = hermes(
            {"fallback_providers": [{"provider": "relay", "model": "gpt-5", "base_url": "https://relay.example/v1", "api_key": "sk-x"}]}
        )
        with patch:
            self.assertEqual(host_model.read_fallbacks(self.path), [{"provider": "relay", "model": "gpt-5"}])

    def test_a_hand_edited_file_drops_what_it_cannot_use(self) -> None:
        patch, _, _ = hermes({"fallback_providers": [{"provider": "openrouter"}, "junk", {"provider": "a", "model": "b"}, {"provider": "", "model": "d"}]})
        with patch:
            self.assertEqual(host_model.read_fallbacks(self.path), [{"provider": "a", "model": "b"}])

    def test_no_fallbacks_is_an_empty_list(self) -> None:
        for config in ({}, {"model": {}}, {"fallback_providers": []}, {"fallback_model": None}):
            patch, _, _ = hermes(config)
            with patch:
                self.assertEqual(host_model.read_fallbacks(self.path), [])

    def test_a_write_touches_one_bot_only(self) -> None:
        theirs = {"model": {}}
        patch, calls, _ = hermes({"model": {}}, others={Path("/home/them/config.yaml"): theirs})
        with patch:
            host_model.set_fallbacks(self.path, [{"provider": "openrouter", "model": "a/b"}])
            self.assertEqual(calls["write"][0][0], self.path)
            self.assertEqual(
                host_model.read_fallbacks(self.path), [{"provider": "openrouter", "model": "a/b"}]
            )
            self.assertEqual(host_model.read_fallbacks(Path("/home/them/config.yaml")), [])
            self.assertEqual(theirs, {"model": {}})


if __name__ == "__main__":
    unittest.main()
