"""Setting the profile's main model from the app.

Run: python3 -m unittest plugin.tests.test_host_model -v
"""

from __future__ import annotations

import sys
import tempfile
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


class ReadMainTest(unittest.TestCase):
    """The model a run that names none would take: what a new session is pinned to."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.path = self.home / "config.yaml"
        self.path.write_text("model: {}\n")

    def test_it_reads_the_main_models_provider_and_default(self) -> None:
        config = {"model": {"default": "anthropic/claude-sonnet-4.5", "provider": "openrouter"}}
        patch, _ = hermes(config, Result(True))
        with patch:
            self.assertEqual(
                host_model.read_main(self.path),
                {"provider": "openrouter", "model": "anthropic/claude-sonnet-4.5"},
            )

    def test_a_file_naming_no_provider_pins_nothing(self) -> None:
        """`auto` means "whichever the credentials fit", which no provider here can name.

        A delegation section may fall back on the main model's provider, but the main model has
        nothing above it: naming `openrouter` for an unnamed one would move the run to a route the
        file never chose, so no pin is the honest answer and the run names no model.
        """
        for config in (
            {"default": "a/b"},
            {"default": "a/b", "provider": "auto"},
            {"default": " a/b "},
            {"provider": "openrouter"},
        ):
            patch, _ = hermes({"model": config}, Result(True))
            with patch:
                self.assertIsNone(host_model.read_main(self.path), config)

    def test_a_file_that_names_no_model_pins_nothing(self) -> None:
        for config in ({}, {"model": {"default": ""}}, {"model": "x/y"}):
            patch, _ = hermes(config, Result(True))
            with patch:
                self.assertIsNone(host_model.read_main(self.path), config)

    def test_a_home_with_no_file_pins_nothing(self) -> None:
        # Nothing to read, and nothing to guess: the run names no model, as every run did before.
        self.assertIsNone(host_model.read_main(self.home / "missing.yaml"))


class MainVersusDelegationTest(unittest.TestCase):
    """The file's main model as two readers see it: one may fill a missing half, the other may not.

    Both read the same shape — ``model.provider`` and ``model.default`` — so they read it one way.
    What they do with a half it doesn't name is the part that differs, and has to: a *delegation*
    section with only a model runs where the bot's credentials point, which Hermes fills with the
    main provider (or its default one). A *pin* has nothing above it, so naming a provider the file
    never chose would move a run somewhere it was never sent.
    """

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.path = self.home / "config.yaml"
        self.path.write_text("model: {}\n")

    def read(self, config):
        patch, _ = hermes(config, Result(True))
        with patch:
            return host_model.read_main(self.path), host_model.read_delegation(self.path)

    def test_a_file_naming_both_reads_the_same_either_way(self) -> None:
        main, delegation = self.read(
            {"model": {"provider": "openrouter", "default": "anthropic/claude-sonnet-4.5"}}
        )
        self.assertEqual(main, {"provider": "openrouter", "model": "anthropic/claude-sonnet-4.5"})
        self.assertIsNone(delegation, "no delegation section: a child inherits the bot's own")

    def test_a_model_with_no_provider_is_filled_for_a_child_and_never_for_a_pin(self) -> None:
        for config, pin, child in (
            ({}, None, "openrouter"),
            # ``auto`` is the file saying "whichever the credentials fit": a pin refuses it, while a
            # child keeps the file's own word for Hermes to resolve there.
            ({"provider": "auto"}, None, "auto"),
            ({"provider": "deepseek"}, {"provider": "deepseek", "model": "a/b"}, "deepseek"),
        ):
            main, delegation = self.read(
                {
                    "model": {"default": "a/b", **config},
                    "delegation": {"model": "c/d"},
                }
            )
            self.assertEqual(main, pin, f"{config}: a pin names only what the file chose")
            self.assertEqual(delegation, {"provider": child, "model": "c/d"}, config)

    def test_the_shape_is_read_once_wherever_it_is_read(self) -> None:
        # One reader of ``model.provider``/``model.default``, so the two answers can't drift.
        self.assertEqual(
            host_model._main_of({"model": {"provider": " openrouter ", "default": " a/b "}}),
            {"provider": "openrouter", "model": "a/b", "base_url": ""},
        )
        self.assertEqual(
            host_model._main_of({"model": "x/y"}),
            {"provider": "", "model": "", "base_url": ""},
            "a file that names no model has nothing to read",
        )


if __name__ == "__main__":
    unittest.main()
