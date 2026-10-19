"""The model a bot's delegated tasks run on: what the Gots plugin keeps in its profile's config.yaml.

It is Hermes's own delegation model — the ``delegation`` section's ``provider`` and ``model`` — so a
child a session delegates to runs it, and nothing set there means a child inherits the bot's model.
These tests pin the keys Hermes reads and what a write leaves in the file.

Run: python3 -m unittest plugin.tests.test_host_model_delegation -v
"""

from __future__ import annotations

import unittest
from pathlib import Path

from plugin import host_model
from plugin.tests._host import Result, hermes


class CleanDelegationTest(unittest.TestCase):
    def test_trims_the_pick(self) -> None:
        self.assertEqual(
            host_model.clean_delegation(
                {"delegation": {"provider": " openrouter ", "model": " a/b "}}
            ),
            {"provider": "openrouter", "model": "a/b"},
        )

    def test_nothing_is_the_bots_own_model(self) -> None:
        self.assertIsNone(host_model.clean_delegation({"delegation": None}))

    def test_a_body_that_says_nothing_is_a_client_bug(self) -> None:
        for body in ({}, {"delegationModel": {"provider": "a", "model": "b"}}):
            with self.assertRaisesRegex(ValueError, "needs a delegation key"):
                host_model.clean_delegation(body)

    def test_a_bad_pick_names_what_is_missing(self) -> None:
        for body in (None, [], "openrouter/x"):
            with self.assertRaisesRegex(ValueError, "Body must be a JSON object"):
                host_model.clean_delegation(body)
        with self.assertRaisesRegex(ValueError, "delegation must be an object"):
            host_model.clean_delegation({"delegation": "openrouter/x"})
        with self.assertRaisesRegex(ValueError, "Delegation needs a model"):
            host_model.clean_delegation({"delegation": {"provider": "openrouter"}})
        with self.assertRaisesRegex(ValueError, "Delegation needs a provider"):
            host_model.clean_delegation({"delegation": {"model": "a/b"}})


class SetDelegationTest(unittest.TestCase):
    path = Path("/home/h/config.yaml")

    def config(self, **top):
        return {
            "model": {"default": "old", "provider": "openrouter", "base_url": "https://x"},
            "display": {"skin": "ares"},
            **top,
        }

    def test_the_pick_is_hermes_delegation_model(self) -> None:
        patch, calls, _ = hermes(self.config())
        with patch:
            saved = host_model.set_delegation(
                self.path, {"provider": "deepseek", "model": "deepseek-v4-pro"}
            )
        self.assertEqual(saved, {"provider": "deepseek", "model": "deepseek-v4-pro"})
        # Hermes's own keys, written in the section in one pass: a model under another provider's
        # endpoint is a route Hermes never meant, and the rest of the file stays put.
        self.assertEqual(
            calls["write"],
            [
                (
                    self.path,
                    "delegation",
                    {"provider": "deepseek", "model": "deepseek-v4-pro"},
                )
            ],
        )
        self.assertEqual(calls["switch"][0]["current_model"], "old")
        self.assertEqual(calls["switch"][0]["current_base_url"], "https://x")
        self.assertTrue(calls["switch"][0]["is_global"])

    def test_a_sections_other_settings_stay(self) -> None:
        # A budget or a concurrency a user set with ``hermes`` is theirs: the app picks the model.
        patch, _, config = hermes(self.config(delegation={"max_iterations": 60}))
        with patch:
            host_model.set_delegation(
                self.path, {"provider": "openrouter", "model": "anthropic/claude-sonnet-4.5"}
            )
        self.assertEqual(
            config["delegation"],
            {
                "max_iterations": 60,
                "provider": "openrouter",
                "model": "anthropic/claude-sonnet-4.5",
            },
        )

    def test_clearing_leaves_the_child_to_inherit(self) -> None:
        patch, calls, config = hermes(
            self.config(delegation={"provider": "deepseek", "model": "c/d", "max_iterations": 60})
        )
        with patch:
            self.assertIsNone(host_model.set_delegation(self.path, None))
        self.assertEqual(calls["write"], [(self.path, "delegation", {"max_iterations": 60})])
        self.assertEqual(config["delegation"], {"max_iterations": 60})
        self.assertEqual(calls["switch"], [])

    def test_clearing_a_section_with_nothing_to_clear_writes_nothing(self) -> None:
        for delegation in ({"max_iterations": 60}, {}):
            patch, calls, config = hermes(self.config(delegation=delegation))
            with patch:
                self.assertIsNone(host_model.set_delegation(self.path, None))
            self.assertEqual(calls["write"], [])
            self.assertEqual(config["delegation"], delegation)

    def test_clearing_the_last_keys_drops_the_section(self) -> None:
        patch, calls, _ = hermes(self.config(delegation={"provider": "a", "model": "b"}))
        with patch:
            host_model.set_delegation(self.path, None)
        self.assertEqual(calls["write"], [(self.path, "delegation", None)])

    def test_a_pick_drops_the_endpoint_a_user_wrote(self) -> None:
        # Hermes reads a ``base_url`` ahead of a provider, so leaving one behind would make the
        # field's answer a lie about where a child runs.
        patch, _, config = hermes(
            self.config(
                delegation={
                    "provider": "relay",
                    "model": "gpt-5",
                    "base_url": "https://relay.example/v1",
                    "api_key": "sk-x",
                    "max_iterations": 60,
                }
            )
        )
        with patch:
            host_model.set_delegation(self.path, {"provider": "deepseek", "model": "c/d"})
        self.assertEqual(
            config["delegation"],
            {"max_iterations": 60, "provider": "deepseek", "model": "c/d"},
        )

    def test_a_pick_on_the_same_provider_drops_it_too(self) -> None:
        patch, _, config = hermes(
            self.config(
                delegation={
                    "provider": "relay",
                    "model": "gpt-5",
                    "base_url": "https://relay.example/v1",
                }
            )
        )
        with patch:
            host_model.set_delegation(self.path, {"provider": "relay", "model": "gpt-5-mini"})
        self.assertEqual(
            config["delegation"], {"provider": "relay", "model": "gpt-5-mini"}
        )

    def test_clearing_drops_the_endpoint_as_well(self) -> None:
        patch, _, config = hermes(
            self.config(
                delegation={
                    "provider": "relay",
                    "model": "gpt-5",
                    "base_url": "https://relay.example/v1",
                    "max_iterations": 60,
                }
            )
        )
        with patch:
            host_model.set_delegation(self.path, None)
        self.assertEqual(config["delegation"], {"max_iterations": 60})

    def test_a_refused_pick_writes_nothing(self) -> None:
        patch, calls, _ = hermes(
            self.config(), [Result(False, error="Unknown provider 'nope'.")]
        )
        with patch, self.assertRaisesRegex(ValueError, "Unknown provider 'nope'"):
            host_model.set_delegation(self.path, {"provider": "nope", "model": "c/d"})
        self.assertEqual(calls["write"], [])

    def test_the_hosts_resolved_names_are_what_gets_recorded(self) -> None:
        patch, _, _ = hermes(self.config(), [Result(True, "claude-sonnet-4.5", "anthropic")])
        with patch:
            saved = host_model.set_delegation(self.path, {"provider": "anthropic", "model": "sonnet"})
        self.assertEqual(saved, {"provider": "anthropic", "model": "claude-sonnet-4.5"})

    def test_a_pick_already_held_is_not_checked_again(self) -> None:
        patch, calls, _ = hermes(
            self.config(delegation={"provider": "deepseek", "model": "c/d"})
        )
        with patch:
            saved = host_model.set_delegation(self.path, {"provider": "deepseek", "model": "c/d"})
        self.assertEqual(saved, {"provider": "deepseek", "model": "c/d"})
        self.assertEqual(calls["write"], [])
        self.assertEqual(calls["switch"], [])


class ReadDelegationTest(unittest.TestCase):
    path = Path("/home/h/config.yaml")

    def test_reads_what_was_written(self) -> None:
        config = {"model": {"default": "old", "provider": "openrouter"}}
        patch, _, _ = hermes(config)
        with patch:
            host_model.set_delegation(
                self.path, {"provider": "deepseek", "model": "deepseek-v4-pro"}
            )
            self.assertEqual(
                host_model.read_delegation(self.path),
                {"provider": "deepseek", "model": "deepseek-v4-pro"},
            )

    def test_a_model_on_its_own_runs_where_the_bot_runs(self) -> None:
        # Hermes keeps the bot's provider and credentials when only the model is set.
        patch, _, _ = hermes(
            {
                "model": {"default": "old", "provider": "openrouter"},
                "delegation": {"model": "anthropic/claude-sonnet-4.5"},
            }
        )
        with patch:
            self.assertEqual(
                host_model.read_delegation(self.path),
                {"provider": "openrouter", "model": "anthropic/claude-sonnet-4.5"},
            )
        # A file that names no main provider runs Hermes's own default.
        patch, _, _ = hermes({"model": {"default": "old"}, "delegation": {"model": "a/b"}})
        with patch:
            self.assertEqual(
                host_model.read_delegation(self.path), {"provider": "openrouter", "model": "a/b"}
            )

    def test_an_auto_provider_is_the_bots_own(self) -> None:
        patch, _, _ = hermes(
            {
                "model": {"default": "old", "provider": "openrouter"},
                "delegation": {"provider": "auto", "model": "a/b"},
            }
        )
        with patch:
            self.assertEqual(
                host_model.read_delegation(self.path),
                {"provider": "openrouter", "model": "a/b"},
            )

    def test_a_pick_reads_back_as_provider_and_model_only(self) -> None:
        patch, _, _ = hermes(
            {
                "model": {"default": "old", "provider": "openrouter"},
                "delegation": {"provider": "relay", "model": "gpt-5", "max_iterations": 60},
            }
        )
        with patch:
            self.assertEqual(
                host_model.read_delegation(self.path),
                {"provider": "relay", "model": "gpt-5"},
            )

    def test_a_hand_written_endpoint_reads_as_nothing(self) -> None:
        # Hermes runs the endpoint ahead of the provider, so the field can't name what the section
        # does; a write from the field drops it again.
        patch, _, _ = hermes(
            {
                "model": {"default": "old", "provider": "openrouter"},
                "delegation": {
                    "provider": "relay",
                    "model": "gpt-5",
                    "base_url": "https://relay.example/v1",
                    "api_key": "sk-x",
                },
            }
        )
        with patch:
            self.assertIsNone(host_model.read_delegation(self.path))

    def test_nothing_set_is_the_bots_own_model(self) -> None:
        for config in (
            {},
            {"model": {"default": "old", "provider": "openrouter"}},
            {"delegation": {}},
            {"delegation": {"model": ""}},
            {"delegation": "auto"},
        ):
            patch, _, _ = hermes(config)
            with patch:
                self.assertIsNone(host_model.read_delegation(self.path))

    def test_a_provider_on_its_own_runs_the_bots_model_there(self) -> None:
        # Hermes pins the provider and keeps the bot's model on it, so the field mustn't claim the
        # bot inherits.
        patch, _, _ = hermes(
            {
                "model": {"default": "old", "provider": "openrouter"},
                "delegation": {"provider": "deepseek"},
            }
        )
        with patch:
            self.assertEqual(
                host_model.read_delegation(self.path),
                {"provider": "deepseek", "model": "old"},
            )

    def test_a_write_touches_one_bot_only(self) -> None:
        theirs = {"model": {"provider": "openrouter"}}
        patch, calls, _ = hermes(
            {"model": {"provider": "openrouter"}}, others={Path("/home/them/config.yaml"): theirs}
        )
        with patch:
            host_model.set_delegation(self.path, {"provider": "deepseek", "model": "a/b"})
            self.assertEqual({write[0] for write in calls["write"]}, {self.path})
            self.assertIsNone(host_model.read_delegation(Path("/home/them/config.yaml")))
            self.assertEqual(theirs, {"model": {"provider": "openrouter"}})


if __name__ == "__main__":
    unittest.main()
