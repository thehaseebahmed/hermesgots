"""Smoke test: every plugin module must import without SyntaxError.

A syntax error or import-time failure in any module listed in
``plugin/__init__.py`` takes down the entire plugin — the import in
``__init__.py`` is top-level, so a broken module means broken routes,
broken routes mean broken features (project cloning, PR creation, etc.).
This test catches those regressions early.
"""

import importlib
import unittest


class PluginImportTests(unittest.TestCase):
    MODULES = [
        "alerts", "attachments", "chats", "clarify", "cleanup",
        "clones", "community", "compactions", "context", "delegation", "events", "github",
        "host_model", "link", "mcp", "media", "merges", "migrate", "outbox", "paths", "skill_catalog",
        "projects", "repos", "sessions", "push", "ship",
        "stream", "todos", "usage",
    ]

    def test_all_modules_import(self):
        """Every module in plugin/__init__.py must import cleanly."""
        for name in self.MODULES:
            with self.subTest(module=name):
                mod = importlib.import_module(f"plugin.{name}")
                self.assertIsNotNone(mod)

    def test_github_and_ship_import(self):
        """The two modules central to cloning and pushing must import."""
        from plugin import github, ship
        self.assertTrue(hasattr(github, "clone"))
        self.assertTrue(hasattr(github, "token"))
        self.assertTrue(hasattr(ship, "ship"))
        self.assertTrue(hasattr(ship, "close"))


if __name__ == "__main__":
    unittest.main()
