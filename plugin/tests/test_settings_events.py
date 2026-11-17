"""A settings write made here is news for every other device.

What a page writes into a bot's ``config.yaml`` is drawn on devices this one will never touch: the
composer's mic, which keeps its answer for five minutes. So the route that writes one key notes a
``settings`` change after it lands, and every open stream carries it within a tick (ADR 0164). The
other writer — the CLI, another process, which no hook sees — is ``stream.watch_config``'s, and its
own test is ``test_stream_settings``.

Run: python3 -m unittest plugin.tests.test_settings_events -v
"""

from __future__ import annotations

import asyncio
import sys
import unittest
from pathlib import Path
from types import ModuleType
from unittest import mock

import plugin
from plugin import events
from plugin.store import db_path
from plugin.tests import _helpers

# Hermes's own defaults for the keys the page writes, as ``hermes_cli.config_defaults`` answers them.
DEFAULTS = {
    "stt": {
        "enabled": True,
        "provider": "local",
        "language": "en",
        "local": {"model": "small"},
    }
}
# The Dashboard's schema: the categories are not read here, only the kinds a key takes.
SCHEMA = {
    "stt.enabled": {"type": "boolean", "category": "speech"},
    "stt.provider": {"type": "string", "category": "speech"},
    "stt.language": {"type": "string", "category": "speech"},
    "stt.local.model": {"type": "string", "category": "speech"},
}


class FakeRequest:
    """A request as ``json_body`` reads one."""

    def __init__(self, body: object) -> None:
        self._body = body
        self.query: dict = {}

    async def json(self) -> object:
        return self._body


class HostModules:
    """The slice of Hermes a settings write reaches: its defaults, its file reader and its writer."""

    def __init__(self) -> None:
        self.config = {"stt": {"enabled": True}}
        self.writes: list[tuple[str, object]] = []

    def __enter__(self) -> "HostModules":
        modules = {
            "hermes_cli": ModuleType("hermes_cli"),
            "hermes_cli.config_defaults": ModuleType("hermes_cli.config_defaults"),
            "hermes_cli.web_server_config": ModuleType("hermes_cli.web_server_config"),
            "gateway": ModuleType("gateway"),
            "gateway.run": ModuleType("gateway.run"),
            "utils": ModuleType("utils"),
        }
        modules["hermes_cli.config_defaults"].DEFAULT_CONFIG = DEFAULTS  # type: ignore[attr-defined]
        modules["hermes_cli.web_server_config"].CONFIG_SCHEMA = SCHEMA  # type: ignore[attr-defined]
        modules["gateway.run"]._load_gateway_config = lambda config_path=None: self.config  # type: ignore[attr-defined]
        modules["utils"].atomic_roundtrip_yaml_update = self._write  # type: ignore[attr-defined]
        self._modules = mock.patch.dict(sys.modules, modules)
        self._modules.start()
        return self

    def __exit__(self, *rest) -> bool:
        self._modules.stop()
        return False

    def _write(self, path, key, value) -> None:
        self.writes.append((key, value))
        keys = key.split(".")
        target = self.config
        for name in keys[:-1]:
            target = target.setdefault(name, {})
        if value is None:
            target.pop(keys[-1], None)
        else:
            target[keys[-1]] = value


def settings_rows(path: Path) -> list[tuple[str, str]]:
    rows, _more = events.read_since(path, 0)
    return [(row["kind"], row["session_id"]) for row in rows if row["kind"] == "settings"]


class SettingsWriteTest(unittest.TestCase):
    def setUp(self) -> None:
        self.home = _helpers.temp_hermes_home(self)
        self.store = db_path(self.home)

    def handler(self):
        adapter = _helpers.RouteAdapter()
        app = _helpers.wire(self, adapter)
        return _helpers.route(app, plugin.PREFIX + "/stt", "POST")

    def post(self, body: object) -> object:
        handler = self.handler()
        return asyncio.run(handler(FakeRequest(body)))

    def test_a_settings_write_is_noted_for_every_other_device(self) -> None:
        with HostModules() as host:
            answer = self.post({"key": "stt.enabled", "value": False})
        self.assertEqual(host.writes, [("stt.enabled", False)])
        self.assertEqual(answer["status"], 200)  # type: ignore[index]
        self.assertEqual(settings_rows(self.store), [("settings", None)])

    def test_a_write_the_host_refuses_is_not_noted(self) -> None:
        # Nothing changed on the host, so nothing is news: a device told to re-read would read the
        # answer it already had, and the row would say a switch moved that did not.
        with HostModules() as host:
            answer = self.post({"key": "stt.enabled", "value": "not a switch"})
        self.assertEqual(host.writes, [])
        self.assertEqual(answer["status"], 400)  # type: ignore[index]
        self.assertEqual(settings_rows(self.store), [])


if __name__ == "__main__":
    unittest.main()
