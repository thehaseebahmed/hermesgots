"""Setting the profile's main model from the app.

Run: python3 -m unittest plugin.tests.test_host_model -v
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


def hermes(config, result):
    """Stand-ins for the two Hermes modules set_main imports, recording what it called."""
    calls = {}

    def switch_model(**kwargs):
        calls["switch"] = kwargs
        return result

    def persist_model_selection(res, path):
        calls["persist"] = (res, path)

    run = types.ModuleType("gateway.run")
    run._load_gateway_config = lambda config_path=None: config
    switch = types.ModuleType("hermes_cli.model_switch")
    switch.switch_model = switch_model
    switch.persist_model_selection = persist_model_selection
    modules = {
        "gateway": types.ModuleType("gateway"),
        "gateway.run": run,
        "hermes_cli": types.ModuleType("hermes_cli"),
        "hermes_cli.model_switch": switch,
    }
    return mock.patch.dict(sys.modules, modules), calls


class CleanTest(unittest.TestCase):
    def test_trims(self) -> None:
        self.assertEqual(host_model.clean({"provider": " anthropic ", "model": "claude-opus-4-5 "}), ("anthropic", "claude-opus-4-5"))

    def test_needs_both(self) -> None:
        for body in (None, [], {"provider": "anthropic"}, {"model": "x"}, {"provider": "", "model": "x"}, {"provider": "a", "model": 3}):
            with self.assertRaises(ValueError):
                host_model.clean(body)


class SetMainTest(unittest.TestCase):
    path = Path("/home/h/config.yaml")

    def test_persists_hermes_choice(self) -> None:
        config = {"model": {"default": "old", "provider": "openrouter", "base_url": "https://x"}, "providers": {"p": {}}}
        result = Result(True, "claude-opus-4-5", "anthropic")
        patch, calls = hermes(config, result)
        with patch:
            chosen = host_model.set_main(self.path, "anthropic", "claude-opus-4-5")
        self.assertEqual(chosen, {"provider": "anthropic", "model": "claude-opus-4-5"})
        self.assertEqual(calls["persist"], (result, self.path))
        switch = calls["switch"]
        self.assertEqual(switch["explicit_provider"], "anthropic")
        self.assertEqual(switch["current_model"], "old")
        self.assertEqual(switch["current_base_url"], "https://x")
        self.assertTrue(switch["is_global"])
        self.assertEqual(switch["user_providers"], {"p": {}})

    def test_refusal_writes_nothing(self) -> None:
        patch, calls = hermes({}, Result(False, error="Unknown provider 'x'."))
        with patch, self.assertRaisesRegex(ValueError, "Unknown provider"):
            host_model.set_main(self.path, "x", "y")
        self.assertNotIn("persist", calls)
        self.assertEqual(calls["switch"]["current_provider"], "openrouter")


if __name__ == "__main__":
    unittest.main()
