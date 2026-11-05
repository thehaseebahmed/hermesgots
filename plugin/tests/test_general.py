"""Tests for the bot's General page (``plugin/general.py``).

The host's schema, its defaults and its ``config.yaml`` are scripted, so these assert the promises
the page rests on: the rows are the host's own General keys and nothing else — another tab's key is
never drawn, and a key this app edits elsewhere (the model pair, the fallback chain) is left alone;
only the keys the file holds read as values, and a key at its default reads the host's own; the two
keys the host only opens at startup say so; a write is one dotted path with its siblings intact, a
null clears the one key, and a refused write touches nothing.
"""

from __future__ import annotations

import sys
import types
import unittest
from pathlib import Path
from unittest import mock

from plugin import general

# The host's schema, as ``hermes_cli.web_server_config.CONFIG_SCHEMA`` answers it: dot paths, and the
# category the Dashboard's tab is drawn from (``session``/``doctor``/``updates`` folded into
# ``general``, exactly as the host folds them).
SCHEMA = {
    "model": {"type": "string", "category": "general"},
    "fallback_providers": {"type": "list", "category": "general"},
    "toolsets": {"type": "list", "category": "general"},
    "max_concurrent_sessions": {"type": "string", "category": "general"},
    "max_live_sessions": {"type": "number", "category": "general"},
    "session.terminal_continue": {"type": "boolean", "category": "general"},
    "context_file_max_chars": {"type": "string", "category": "general"},
    "timezone": {
        "type": "select",
        "category": "general",
        "options": ["", "UTC", "Europe/London"],
        "searchable": True,
        "clearable": True,
    },
    "hooks_auto_accept": {"type": "boolean", "category": "general"},
    "doctor.live_probe_timeout": {"type": "number", "category": "general"},
    # The Dashboard's own field for a key Hermes keeps inside the model.
    "model_context_length": {
        "type": "number",
        "category": "general",
        "description": "Context window override (0 = auto-detect from model metadata)",
    },
    "updates.check": {"type": "boolean", "category": "general"},
    "updates.backup_keep": {"type": "number", "category": "general"},
    "updates.pre_update_backup": {
        "type": "select",
        "category": "general",
        "options": ["quick", "full", "off"],
    },
    # Another tab's key: the page must never draw it.
    "stt.enabled": {"type": "boolean", "category": "speech"},
    "terminal.backend": {"type": "select", "category": "terminal", "options": ["local"]},
    # A shape the page can't write back, so it is left out rather than drawn as a dead field.
    "providers": {"type": "object", "category": "general"},
}

DEFAULTS = {
    "model": "",
    "fallback_providers": [],
    "toolsets": ["hermes-cli"],
    "max_concurrent_sessions": None,
    "max_live_sessions": 16,
    "session": {"terminal_continue": True},
    "context_file_max_chars": None,
    "timezone": "",
    "hooks_auto_accept": False,
    "doctor": {"live_probe_timeout": 10},
    "updates": {"check": True, "pre_update_backup": "quick"},
}

CONFIG = {
    "timezone": "Europe/London",
    "session": {"terminal_continue": False},
    "updates": {"backup_keep": 5, "check": False},
    "unrelated": {"kept": True},
}


class GeneralHost:
    """The host modules ``general`` reaches for, scripted.

    ``config`` is the profile's ``config.yaml``; the writer applies one dotted path the way Hermes's
    round-trip writer does — a value set, or a key removed — so a test can show what a write leaves
    beside it.
    """

    def __init__(self, config=None, schema=None, defaults=None, schema_available=True):
        self.config = {} if config is None else config
        self.schema = SCHEMA if schema is None else schema
        self.defaults = DEFAULTS if defaults is None else defaults
        self.schema_available = schema_available
        self.writes = []

    def __enter__(self):
        self._modules = mock.patch.dict(sys.modules, self._host_modules())
        self._modules.start()
        return self

    def __exit__(self, *rest):
        self._modules.stop()
        return False

    def _host_modules(self):
        modules = {
            "hermes_cli": types.ModuleType("hermes_cli"),
            "hermes_cli.config_defaults": types.ModuleType("hermes_cli.config_defaults"),
            "gateway": types.ModuleType("gateway"),
            "gateway.run": types.ModuleType("gateway.run"),
            "utils": types.ModuleType("utils"),
        }
        modules["hermes_cli.config_defaults"].DEFAULT_CONFIG = self.defaults
        modules["gateway.run"]._load_gateway_config = lambda config_path=None: self.config
        modules["utils"].atomic_roundtrip_yaml_update = self._write
        if self.schema_available:
            web = types.ModuleType("hermes_cli.web_server_config")
            web.CONFIG_SCHEMA = self.schema
            modules["hermes_cli.web_server_config"] = web
        return modules

    def _write(self, path, key, value):
        self.writes.append((key, value))
        keys = key.split(".")
        target = self.config
        for name in keys[:-1]:
            target = target.setdefault(name, {})
        if value is None:
            target.pop(keys[-1], None)
        else:
            target[keys[-1]] = value


class ReadTest(unittest.TestCase):

    def fields(self, **kwargs):
        with GeneralHost(**kwargs) as host:
            payload = general.read(Path("/tmp/config.yaml"))
        return host, payload

    def test_the_rows_are_the_hosts_general_keys_and_nothing_else(self) -> None:
        _, payload = self.fields()
        keys = [row["key"] for row in payload["fields"]]
        self.assertIn("max_live_sessions", keys)
        self.assertIn("session.terminal_continue", keys)
        # Another tab's key, and two the app edits on its Models page.
        self.assertNotIn("stt.enabled", keys)
        self.assertNotIn("terminal.backend", keys)
        self.assertNotIn("model", keys)
        self.assertNotIn("fallback_providers", keys)
        # A shape the page can't write back.
        self.assertNotIn("providers", keys)

    def test_a_key_whose_default_is_none_still_takes_a_number(self) -> None:
        _, payload = self.fields()
        rows = {row["key"]: row for row in payload["fields"]}
        self.assertEqual(rows["max_concurrent_sessions"]["kind"], "number")
        self.assertEqual(rows["context_file_max_chars"]["kind"], "number")
        self.assertEqual(rows["timezone"]["kind"], "select")
        self.assertEqual(rows["timezone"]["options"], ["", "UTC", "Europe/London"])
        self.assertTrue(rows["timezone"]["searchable"])
        self.assertEqual(rows["toolsets"]["kind"], "list")

    def test_only_the_keys_the_file_holds_are_values(self) -> None:
        _, payload = self.fields(config=dict(CONFIG))
        self.assertEqual(payload["values"]["timezone"], "Europe/London")
        self.assertEqual(payload["values"]["session.terminal_continue"], False)
        # Held at its default: the file doesn't hold it, so the row reads the host's own value.
        self.assertNotIn("hooks_auto_accept", payload["values"])
        self.assertEqual(payload["defaults"]["hooks_auto_accept"], False)
        self.assertEqual(payload["defaults"]["max_live_sessions"], 16)

    def test_the_context_window_is_read_from_inside_the_model(self) -> None:
        _, payload = self.fields(config={"model": {"default": "x", "context_length": 262144}})
        rows = {row["key"]: row for row in payload["fields"]}
        self.assertEqual(rows["model_context_length"]["kind"], "number")
        self.assertEqual(payload["values"]["model_context_length"], 262144)

    def test_a_window_nobody_pinned_reads_zero_as_the_dashboards_own_field_does(self) -> None:
        _, payload = self.fields(config={"model": {"default": "x"}})
        self.assertNotIn("model_context_length", payload["values"])
        self.assertEqual(payload["defaults"]["model_context_length"], 0)

    def test_the_window_carries_the_host_s_own_sentence_about_its_zero(self) -> None:
        _, payload = self.fields()
        rows = {row["key"]: row for row in payload["fields"]}
        self.assertEqual(
            rows["model_context_length"].get("note"),
            "Context window override (0 = auto-detect from model metadata)",
            "a row whose zero means something carries the host's words for it",
        )
        self.assertNotIn("note", rows["timezone"], "and a key that reads as itself carries none")

    def test_a_list_the_host_gives_no_default_for_is_left_out(self) -> None:
        with GeneralHost(defaults={"model": ""}):
            payload = general.read(Path("/tmp/config.yaml"))
        keys = [row["key"] for row in payload["fields"]]
        self.assertNotIn("toolsets", keys, "a list row that can't be judged is not offered")
        self.assertIn("timezone", keys, "while a key that reads as itself still is")

    def test_a_list_the_file_holds_reads_as_its_entries(self) -> None:
        _, payload = self.fields(config={"toolsets": ["hermes-cli", "mcp"]})
        self.assertEqual(payload["values"]["toolsets"], ["hermes-cli", "mcp"])
        self.assertEqual(payload["defaults"]["toolsets"], ["hermes-cli"])

    def test_a_row_is_filed_under_its_own_first_segment(self) -> None:
        _, payload = self.fields()
        rows = {row["key"]: row for row in payload["fields"]}
        self.assertEqual(rows["session.terminal_continue"]["section"], "session")
        self.assertEqual(rows["updates.check"]["section"], "updates")
        self.assertEqual(rows["doctor.live_probe_timeout"]["section"], "doctor")
        self.assertEqual(rows["timezone"]["section"], "")

    def test_the_keys_the_host_only_opens_at_startup_say_so(self) -> None:
        _, payload = self.fields()
        rows = {row["key"]: row for row in payload["fields"]}
        self.assertTrue(rows["max_concurrent_sessions"].get("restart"))
        self.assertTrue(rows["timezone"].get("restart"))
        self.assertFalse(rows["hooks_auto_accept"].get("restart"))

    def test_the_order_is_the_schema_s_own(self) -> None:
        _, payload = self.fields()
        keys = [row["key"] for row in payload["fields"]]
        self.assertEqual(keys[:3], ["toolsets", "max_concurrent_sessions", "max_live_sessions"])


class WriteTest(unittest.TestCase):

    def write(self, key, value, config=None):
        with GeneralHost(config=config if config is not None else {}) as host:
            general.set_value(Path("/tmp/config.yaml"), key, value)
        return host

    def test_a_switch_writes_its_one_key_and_leaves_its_siblings(self) -> None:
        host = self.write("session.terminal_continue", False, config={"session": {"terminal_continue": True, "x": 1}})
        self.assertEqual(host.writes, [("session.terminal_continue", False)])
        self.assertEqual(host.config["session"], {"terminal_continue": False, "x": 1})

    def test_a_number_and_a_select_write_what_they_are_given(self) -> None:
        host = self.write("updates.backup_keep", 3)
        self.assertEqual(host.writes, [("updates.backup_keep", 3)])
        host = self.write("updates.pre_update_backup", "full")
        self.assertEqual(host.writes, [("updates.pre_update_backup", "full")])

    def test_the_context_window_is_written_inside_the_model_and_a_zero_clears_it(self) -> None:
        host = self.write("model_context_length", 262144, config={"model": {"default": "x"}})
        self.assertEqual(host.writes, [("model.context_length", 262144)])
        self.assertEqual(host.config["model"], {"default": "x", "context_length": 262144})
        host = self.write("model_context_length", 0, config={"model": {"default": "x", "context_length": 9}})
        self.assertEqual(host.writes, [("model.context_length", None)])
        self.assertNotIn("context_length", host.config["model"])

    def test_clearing_a_key_writes_null_so_the_host_default_takes_over(self) -> None:
        host = self.write("timezone", None, config={"timezone": "UTC"})
        self.assertEqual(host.writes, [("timezone", None)])
        self.assertNotIn("timezone", host.config)

    def test_a_key_the_read_never_offered_is_refused_before_any_write(self) -> None:
        for key in ("model", "fallback_providers", "stt.enabled", "providers", "nonsense"):
            with self.assertRaises(ValueError):
                self.write(key, True)

    def test_a_value_of_the_wrong_shape_is_refused_and_the_file_left_alone(self) -> None:
        cases = [
            ("session.terminal_continue", "true"),
            ("updates.backup_keep", "5"),
            ("updates.backup_keep", True),
            ("updates.pre_update_backup", "sometimes"),
            ("toolsets", "hermes-cli"),
            ("toolsets", [1, 2]),
            ("timezone", "Mars/Olympus"),
        ]
        for key, value in cases:
            with self.subTest(key=key, value=value):
                with self.assertRaises(ValueError):
                    self.write(key, value)


class GateTest(unittest.TestCase):

    def test_a_host_without_a_schema_offers_no_page(self) -> None:
        with GeneralHost(schema_available=False):
            self.assertTrue(general.available())

    def test_a_host_with_a_schema_offers_the_page(self) -> None:
        with GeneralHost():
            self.assertIsNone(general.available())
            self.assertEqual(general.FEATURES, (("general_page", general.available),))


if __name__ == "__main__":
    unittest.main()
