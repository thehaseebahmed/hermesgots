"""The model a bot's delegated tasks run on: what the Gots plugin keeps in its profile's config.yaml.

It is Hermes's own delegation model — the ``delegation`` section's ``provider`` and ``model`` — so a
child a session delegates to runs it, and nothing set there means a child inherits the bot's model.
These tests pin the keys Hermes reads and what a write leaves in the file.

Run: python3 -m unittest plugin.tests.test_host_model_delegation -v
"""

from __future__ import annotations

import sys
import types
import unittest
from pathlib import Path
from unittest import mock

from plugin import host_model


class Result:
    def __init__(self, success, model="", provider="", error=""):
        self.success = success
        self.new_model = model
        self.target_provider = provider
        self.error_message = error


def hermes(config, results=(), others=None):
    """Stand-ins for the Hermes modules the delegation paths import, recording every write.

    ``config`` is this bot's config.yaml; ``others`` maps a further path to another bot's, so a test
    can show a write stays in its own bot's file. ``results`` are the answers ``switch_model`` gives
    in order. The fake writer applies its key the way Hermes's own writer does (a dotted key goes
    into its section), which is what makes a write readable back, and records the call.
    """
    calls = {"switch": [], "write": []}
    answers = list(results)
    homes = dict(others or {})

    def switch_model(**kwargs):
        calls["switch"].append(kwargs)
        return (
            answers.pop(0)
            if answers
            else Result(True, kwargs["raw_input"], kwargs["explicit_provider"])
        )

    def load(config_path=None):
        return homes.get(config_path, config)

    def atomic_roundtrip_yaml_update(path, key, value):
        calls["write"].append((path, key, value))
        target = homes.get(path, config)
        if "." in key:
            section, name = key.split(".", 1)
            target = target.setdefault(section, {})
        else:
            name = key
        if value is None:
            target.pop(name, None)
        else:
            target[name] = value

    run = types.ModuleType("gateway.run")
    run._load_gateway_config = load
    switch = types.ModuleType("hermes_cli.model_switch")
    switch.switch_model = switch_model
    utils = types.ModuleType("utils")
    utils.atomic_roundtrip_yaml_update = atomic_roundtrip_yaml_update
    modules = {
        "gateway": types.ModuleType("gateway"),
        "gateway.run": run,
        "hermes_cli": types.ModuleType("hermes_cli"),
        "hermes_cli.model_switch": switch,
        "utils": utils,
    }
    return mock.patch.dict(sys.modules, modules), calls, config


class CleanDelegationTest(unittest.TestCase):
    def test_trims_the_pick(self) -> None:
        self.assertEqual(
            host_model.clean_delegation(
                {"delegation": {"provider": " openrouter ", "model": " a/b "}}
            ),
            {"provider": "openrouter", "model": "a/b"},
        )

    def test_nothing_is_the_bots_own_model(self) -> None:
        self.assertIsNone(host_model.clean_delegation({}))
        self.assertIsNone(host_model.clean_delegation({"delegation": None}))

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
        # Hermes's own keys, the section's own place: a single key at a time, so the rest of the
        # file — and the rest of the section — stays put.
        self.assertEqual(
            calls["write"],
            [
                (self.path, "delegation.provider", "deepseek"),
                (self.path, "delegation.model", "deepseek-v4-pro"),
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
        self.assertEqual(
            calls["write"],
            [
                (self.path, "delegation.model", None),
                (self.path, "delegation.provider", None),
            ],
        )
        self.assertEqual(config["delegation"], {"max_iterations": 60})
        self.assertEqual(calls["switch"], [])

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
        # It is the one Hermes resolved when it went in, so re-checking would spend a live provider
        # probe on a pick that hasn't moved — and write a file that already says it.
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

    def test_the_section_comes_back_as_provider_and_model_only(self) -> None:
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
            self.assertEqual(
                host_model.read_delegation(self.path),
                {"provider": "relay", "model": "gpt-5"},
            )

    def test_nothing_set_is_the_bots_own_model(self) -> None:
        for config in (
            {},
            {"model": {"default": "old", "provider": "openrouter"}},
            {"delegation": {}},
            {"delegation": {"provider": "deepseek"}},
            {"delegation": {"model": ""}},
            {"delegation": "auto"},
        ):
            patch, _, _ = hermes(config)
            with patch:
                self.assertIsNone(host_model.read_delegation(self.path))

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
