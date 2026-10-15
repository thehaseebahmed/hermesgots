"""A bot's fallback models: what the Gots plugin records in its profile's config.yaml.

Run: python3 -m unittest plugin.tests.test_host_model_fallbacks -v
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
    """Stand-ins for the three Hermes modules the fallback paths import, recording every write.

    ``config`` is this bot's config.yaml; ``others`` maps a further path to another bot's, so a test
    can show a write stays in its own bot's file. ``results`` are the answers ``switch_model`` gives
    in order — a refusal is one of them — so a test can refuse the second pick only. The fake writer
    applies its single key the way Hermes's own writer does, which is what makes a write readable
    back, and records the call.
    """
    calls = {"switch": [], "write": []}
    answers = list(results)
    homes = dict(others or {})

    def switch_model(**kwargs):
        calls["switch"].append(kwargs)
        return answers.pop(0) if answers else Result(True, kwargs["raw_input"], kwargs["explicit_provider"])

    def load(config_path=None):
        return homes.get(config_path, config)

    def atomic_roundtrip_yaml_update(path, key, value):
        calls["write"].append((path, key, value))
        target = homes.get(path, config)
        section, name = key.split(".", 1)
        if value is None:
            target.get(section, {}).pop(name, None)
        else:
            target.setdefault(section, {})[name] = value

    run = types.ModuleType("gateway.run")
    run._load_gateway_config = load
    switch = types.ModuleType("hermes_cli.model_switch")
    switch.switch_model = switch_model
    switch.persist_model_selection = lambda res, path: None
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

    def test_three_is_too_many(self) -> None:
        entry = {"provider": "openrouter", "model": "a/b"}
        with self.assertRaisesRegex(ValueError, "at most 2 fallback models"):
            host_model.clean_fallbacks({"fallbacks": [entry, entry, entry]})

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

    def config(self):
        return {
            "model": {"default": "old", "provider": "openrouter", "base_url": "https://x"},
            "display": {"skin": "ares"},
        }

    def test_records_the_picks_in_order_under_one_key(self) -> None:
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
        # One key, named: the sibling keys in the model block and every other section stay put.
        self.assertEqual(
            calls["write"],
            [(self.path, "model.fallbacks", saved)],
        )
        self.assertEqual(calls["switch"][0]["current_model"], "old")
        self.assertEqual(calls["switch"][0]["current_base_url"], "https://x")
        self.assertTrue(calls["switch"][0]["is_global"])

    def test_clearing_writes_nothing_behind(self) -> None:
        patch, calls, _ = hermes(self.config())
        with patch:
            self.assertEqual(host_model.set_fallbacks(self.path, []), [])
        self.assertEqual(calls["write"], [(self.path, "model.fallbacks", None)])
        self.assertEqual(calls["switch"], [])

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


class ReadFallbacksTest(unittest.TestCase):
    path = Path("/home/h/config.yaml")

    def test_reads_what_was_written(self) -> None:
        config = {"model": {"default": "old", "provider": "openrouter"}}
        patch, _, _ = hermes(config)
        written = [{"provider": "openrouter", "model": "a/b"}, {"provider": "deepseek", "model": "deepseek-v4-pro"}]
        with patch:
            host_model.set_fallbacks(self.path, written)
            self.assertEqual(host_model.read_fallbacks(self.path), written)

    def test_a_hand_edited_file_drops_what_it_cannot_use(self) -> None:
        patch, _, _ = hermes({"model": {"fallbacks": [{"provider": "openrouter"}, "junk", {"provider": "a", "model": "b"}, {"provider": "c", "model": "d"}]}})
        with patch:
            self.assertEqual(host_model.read_fallbacks(self.path), [{"provider": "a", "model": "b"}, {"provider": "c", "model": "d"}])

    def test_no_fallbacks_is_an_empty_list(self) -> None:
        for config in ({}, {"model": {}}, {"model": {"fallbacks": []}}):
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
