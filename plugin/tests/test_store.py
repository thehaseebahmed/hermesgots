"""What the store leaves behind and what ``info`` advertises once Apps are gone (ADR 0113).

Run: python3 -m unittest plugin.tests.test_store -v
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
import unittest
from pathlib import Path

import plugin
from plugin import builds, canvases
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


class ACanvasKeepsItsGrants(unittest.TestCase):
    """A v61 store gains the grants table without losing what its canvases hold."""

    def test_a_v61_store_upgrades_keeping_canvases_versions_and_data(self) -> None:
        path = db_path(temp_hermes_home(self))
        old = connect(path)
        old.execute(
            "INSERT INTO canvases (id, title, session_id, chat_id, version, pinned, archived, at,"
            " created_at) VALUES ('c1', 'Tip', 's1', 'chat-1', 1, 0, 0, 7, 5)"
        )
        old.execute(
            "INSERT INTO canvas_versions (canvas_id, version, html, tools, at)"
            " VALUES ('c1', 1, '<h1>Tip</h1>', '[\"files.search\"]', 7)"
        )
        old.execute(
            "INSERT INTO canvas_docs (canvas_id, collection, id, value, at)"
            " VALUES ('c1', 'notes', 'a', '{\"text\":\"one\"}', 7)"
        )
        # A store of the build before this one: no grants table, and the version it stops at.
        old.execute("DROP TABLE IF EXISTS canvas_grants")
        old.execute("PRAGMA user_version = 61")
        old.close()

        conn = connect(path)
        try:
            self.assertEqual(conn.execute("PRAGMA user_version").fetchone()[0], SCHEMA_VERSION)
            self.assertEqual(
                conn.execute("SELECT title, version FROM canvases WHERE id = 'c1'").fetchone(),
                ("Tip", 1),
            )
            self.assertEqual(
                conn.execute(
                    "SELECT html, tools FROM canvas_versions WHERE canvas_id = 'c1' AND version = 1"
                ).fetchone(),
                ("<h1>Tip</h1>", '["files.search"]'),
            )
            self.assertEqual(
                conn.execute(
                    "SELECT value FROM canvas_docs WHERE canvas_id = 'c1' AND id = 'a'"
                ).fetchone()[0],
                '{"text":"one"}',
            )
        finally:
            conn.close()

        # The answer the user gives is the canvas's, and it is on disk: a reopen still reads it.
        answered = canvases.grant(path, "c1", "files.search", True)
        self.assertEqual(
            {field: answered["grant"][field] for field in ("tool", "allowed")},
            {"tool": "files.search", "allowed": True},
        )
        self.assertEqual(answered["grants"], [answered["grant"]])
        self.assertEqual(
            canvases.current(path, "c1")["grants"], [answered["grant"]]
        )


class ABuildKeepsItsPlanColumns(unittest.TestCase):
    """A v77 store gains the plan columns on its builds, and keeps the builds it holds."""

    def test_a_v77_store_upgrades_keeping_its_builds(self) -> None:
        path = db_path(temp_hermes_home(self))
        old = connect(path)
        old.execute(
            "INSERT INTO canvases (id, title, session_id, chat_id, version, pinned, archived, at,"
            " created_at) VALUES ('c1', 'Tip', 's1', 'chat-1', 1, 0, 0, 7, 5)"
        )
        old.execute(
            "INSERT INTO canvas_builds (id, canvas_id, session_id, phase, requests, summary,"
            " run_id, at, created_at) VALUES ('b1', 'c1', 'canvas-b1', 'open', ?," 
            " NULL, NULL, 7, 5)",
            (json.dumps(["make it blue"]),),
        )
        # A store of the build before this one: no plan columns, and the version it stops at.
        old.execute("ALTER TABLE canvas_builds DROP COLUMN plan")
        old.execute("ALTER TABLE canvas_builds DROP COLUMN wait")
        old.execute("PRAGMA user_version = 77")
        old.close()

        conn = connect(path)
        try:
            self.assertEqual(conn.execute("PRAGMA user_version").fetchone()[0], SCHEMA_VERSION)
            self.assertEqual(
                tuple(
                    conn.execute(
                        "SELECT phase, requests, plan, wait FROM canvas_builds WHERE id = 'b1'"
                    ).fetchone()
                ),
                ("open", json.dumps(["make it blue"]), None, 0),
            )
        finally:
            conn.close()
        # The build the store holds is still the one its canvas reads, and a plan may be filed on it.
        self.assertEqual(builds.of_canvas(path, "c1")["id"], "b1")
        self.assertTrue(
            builds.plan(path, "b1", {"changes": "Blue.", "checks": [], "wait": True})
        )


class AFlagKeepsItsStateWhenItIsRenamed(unittest.TestCase):
    """The record's folded-away flag is the reader's "Archived"; a store written before that name
    keeps what it held."""

    def test_a_store_with_the_first_column_name_opens_with_its_state_kept(self) -> None:
        path = db_path(temp_hermes_home(self))
        old = connect(path)
        old.execute("ALTER TABLE canvases RENAME COLUMN archived TO hidden")
        old.execute(
            "INSERT INTO canvases (id, title, session_id, chat_id, version, pinned, hidden, at,"
            " created_at) VALUES ('c1', 'Tip', 's1', 'chat-1', 1, 1, 1, 7, 5)"
        )
        # The build that wrote the first name, opening at the version before this one's.
        old.execute("PRAGMA user_version = 62")
        old.close()

        conn = connect(path)
        try:
            self.assertEqual(
                conn.execute("SELECT pinned, archived FROM canvases WHERE id = 'c1'").fetchone(),
                (1, 1),
            )
        finally:
            conn.close()
        self.assertIs(canvases.current(path, "c1")["archived"], True)


class ADeclaredNameNothingCanCall(unittest.TestCase):
    """The v62 pass: a name the one rule refuses is no declaration, so a row keeps only the rest."""

    def test_a_v61_store_drops_declared_names_nothing_can_call(self) -> None:
        # A name kept from before the rule tightened is a row the options draw and the grant route
        # refuses, so the switch could never be set and consent would be asked for a call that can
        # never be made: the migration filters every version's list, keeping the names it accepts.
        path = db_path(temp_hermes_home(self))
        old = connect(path)
        old.execute(
            "INSERT INTO canvases (id, title, session_id, chat_id, version, pinned, archived, at,"
            " created_at) VALUES ('c1', 'Tip', 's1', 'chat-1', 1, 0, 0, 7, 5)"
        )
        old.execute(
            "INSERT INTO canvas_versions (canvas_id, version, html, tools, at)"
            " VALUES ('c1', 1, '<h1>Tip</h1>', ?, 7)",
            (json.dumps(["todo_list", "files.search", "data.put", "files. search"]),),
        )
        old.execute("DROP TABLE IF EXISTS canvas_grants")
        old.execute("PRAGMA user_version = 61")
        old.close()

        conn = connect(path)
        try:
            self.assertEqual(
                conn.execute(
                    "SELECT tools FROM canvas_versions WHERE canvas_id = 'c1' AND version = 1"
                ).fetchone()[0],
                json.dumps(["files.search"]),
            )
        finally:
            conn.close()
        # And what is left is what the host can grant and the page can call.
        self.assertEqual(canvases.page(path, "c1")["tools"], ["files.search"])


if __name__ == "__main__":
    unittest.main()
