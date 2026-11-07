"""What the store leaves behind and what ``info`` advertises once Apps are gone (ADR 0113).

Run: python3 -m unittest plugin.tests.test_store -v
"""

from __future__ import annotations

import asyncio
import sqlite3
import unittest
from pathlib import Path

import plugin
from plugin.store import SCHEMA_VERSION, connect, db_path
from plugin.tests._helpers import FakeWeb, RouteAdapter, route, temp_hermes_home, wire


def tables(path: Path) -> set:
    conn = sqlite3.connect(path)
    try:
        return {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    finally:
        conn.close()


class AppsAreGone(unittest.TestCase):
    def test_a_v58_store_migrates_with_no_apps_tables(self) -> None:
        path = db_path(temp_hermes_home(self))
        old = connect(path)
        old.execute(
            "CREATE TABLE IF NOT EXISTS apps (id TEXT PRIMARY KEY, title TEXT NOT NULL,"
            " library_version TEXT NOT NULL, created_at INTEGER NOT NULL, builtin_key TEXT,"
            " builtin_version INTEGER, edited INTEGER NOT NULL DEFAULT 0,"
            " hidden INTEGER NOT NULL DEFAULT 0, consent TEXT)"
        )
        old.execute(
            "CREATE TABLE IF NOT EXISTS app_pages (app_id TEXT NOT NULL, page_id TEXT NOT NULL,"
            " position INTEGER NOT NULL, source TEXT NOT NULL, previous_source TEXT,"
            " PRIMARY KEY (app_id, page_id))"
        )
        old.execute("INSERT INTO apps (id, title, library_version, created_at) VALUES ('a', 'A', '1', 1)")
        old.execute("INSERT INTO app_pages VALUES ('a', 'root', 0, '# id: root', NULL)")
        old.execute("INSERT INTO chats (id, at, value) VALUES ('c1', 5, '{}')")
        old.execute("PRAGMA user_version = 58")
        old.close()
        connect(path).close()
        found = tables(path)
        self.assertNotIn("apps", found)
        self.assertNotIn("app_pages", found)
        kept = sqlite3.connect(path)
        try:
            self.assertEqual(kept.execute("PRAGMA user_version").fetchone()[0], SCHEMA_VERSION)
            self.assertEqual(kept.execute("SELECT at FROM chats WHERE id = 'c1'").fetchone()[0], 5)
        finally:
            kept.close()

    def test_a_store_from_before_apps_migrates_with_no_apps_tables(self) -> None:
        path = db_path(temp_hermes_home(self))
        old = connect(path)
        old.execute("DROP TABLE IF EXISTS app_pages")
        old.execute("DROP TABLE IF EXISTS apps")
        old.execute("PRAGMA user_version = 54")
        old.close()
        connect(path).close()
        found = tables(path)
        self.assertNotIn("apps", found)
        self.assertNotIn("app_pages", found)

    def test_a_fresh_store_has_no_apps_tables(self) -> None:
        path = db_path(temp_hermes_home(self))
        connect(path).close()
        self.assertTrue({"apps", "app_pages"}.isdisjoint(tables(path)))

    def test_features_carry_no_apps(self) -> None:
        temp_hermes_home(self)
        app = wire(self, RouteAdapter())
        request = FakeWeb.Request()
        request.match_info, request.headers = {}, {}
        answer = asyncio.run(route(app, plugin.PREFIX + "/info")(request))
        self.assertEqual(answer["status"], 200)
        self.assertNotIn("apps", answer["payload"]["features"])
        self.assertNotIn("apps", answer["payload"])


if __name__ == "__main__":
    unittest.main()
