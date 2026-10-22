"""The plugin's routes live under ``/api/plugins/gots`` and, for one release, still answer at the old
``/api/plugins/memento``, for the profile-scoped copies too, so an app that hasn't updated keeps working.

Run: python3 -m unittest plugin.tests.test_route_prefix -v
"""

from __future__ import annotations

import sys
import types
import unittest
from unittest import mock

import plugin


class Resource:
    def __init__(self, canonical: str):
        self.canonical = canonical


class Route:
    def __init__(self, method: str, path: str, handler):
        self.method = method
        self.resource = Resource(path)
        self.handler = handler


class Router:
    def __init__(self):
        self.added = []

    def routes(self):
        return [Route(m, p, h) for m, p, h in self.added]

    def add_route(self, method, path, handler):
        self.added.append((method, path, handler))


class App:
    def __init__(self, *routes):
        self.router = Router()
        for method, path in routes:
            self.router.add_route(method, path, f"handler:{method}:{path}")

    def paths(self):
        return sorted((m, p) for m, p, _ in self.router.added)


class LegacyPrefixTest(unittest.TestCase):
    def test_every_route_is_served_at_the_old_prefix_too(self) -> None:
        app = App(("GET", "/api/plugins/gots/info"), ("POST", "/api/plugins/gots/sessions/{id}/mode"))
        plugin.mirror_legacy_prefix(app)
        self.assertEqual(
            app.paths(),
            [
                ("GET", "/api/plugins/gots/info"),
                ("GET", "/api/plugins/memento/info"),
                ("POST", "/api/plugins/gots/sessions/{id}/mode"),
                ("POST", "/api/plugins/memento/sessions/{id}/mode"),
            ],
        )

    def test_the_old_route_runs_the_same_handler(self) -> None:
        app = App(("GET", "/api/plugins/gots/info"))
        plugin.mirror_legacy_prefix(app)
        handlers = {p: h for _, p, h in app.router.added}
        self.assertIs(handlers["/api/plugins/memento/info"], handlers["/api/plugins/gots/info"])

    def test_other_routes_and_head_are_left_alone(self) -> None:
        app = App(("GET", "/v1/models"), ("HEAD", "/api/plugins/gots/info"))
        plugin.mirror_legacy_prefix(app)
        self.assertEqual(len(app.router.added), 2)

    def test_profile_copies_exist_under_both_prefixes(self) -> None:
        app = App(("GET", "/api/plugins/gots/info"))
        plugin.mirror_legacy_prefix(app)
        scope = types.ModuleType("gateway.platforms.api_server")
        scope._api_request_profile = mock.Mock()
        modules = {
            "gateway": types.ModuleType("gateway"),
            "gateway.platforms": types.ModuleType("gateway.platforms"),
            "gateway.platforms.api_server": scope,
        }
        with mock.patch.dict(sys.modules, modules):
            plugin.mirror_for_profiles(app, mock.Mock())
        paths = {p for _, p, _ in app.router.added}
        self.assertIn("/api/plugins/gots/p/{profile}/info", paths)
        self.assertIn("/api/plugins/memento/p/{profile}/info", paths)


if __name__ == "__main__":
    unittest.main()
