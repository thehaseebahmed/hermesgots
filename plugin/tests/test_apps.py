"""A bot's apps and their pages: the record the store gains and the two reads that answer it.

Run: python3 -m unittest plugin.tests.test_apps -v
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
import unittest
from unittest import mock
from pathlib import Path
from typing import Any, NamedTuple, Optional, Sequence, Set, Tuple

import plugin
from plugin import apps, openui
from plugin.store import SCHEMA_VERSION, connect, db_path
from plugin.tests._helpers import FakeWeb, RouteAdapter, route, temp_hermes_home, wire


class Page(NamedTuple):
    position: int
    page_id: str
    source: str
    previous_source: Optional[str]


def plant(
    path: Path,
    app_id: str,
    *,
    title: str = "House",
    library_version: str = "1.0.1",
    at: int = 1,
    pages: Sequence[Page] = (),
) -> None:
    """Writes one app and its pages in one transaction, the way a build writes them."""
    conn = connect(path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute(
            "INSERT INTO apps (id, title, library_version, created_at) VALUES (?, ?, ?, ?)",
            (app_id, title, library_version, at),
        )
        for position, page_id, source, previous_source in pages:
            conn.execute(
                "INSERT INTO app_pages (app_id, page_id, position, source, previous_source)"
                " VALUES (?, ?, ?, ?, ?)",
                (app_id, page_id, position, source, previous_source),
            )
        conn.execute("COMMIT")
    except BaseException:
        if conn.in_transaction:
            conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()


class Migration(unittest.TestCase):
    """The acceptance criterion: a fresh home and an upgraded home both gain the tables."""

    def tables(self, path: Path) -> Tuple[Set[str], int]:
        conn = sqlite3.connect(path)
        try:
            found = {
                row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
            }
            version = conn.execute("PRAGMA user_version").fetchone()[0]
        finally:
            conn.close()
        return found, version

    def test_a_fresh_home_gains_the_app_tables(self) -> None:
        path = db_path(temp_hermes_home(self))
        connect(path).close()
        found, version = self.tables(path)
        self.assertIn("apps", found)
        self.assertIn("app_pages", found)
        self.assertEqual(version, SCHEMA_VERSION, "the fresh store is stamped as it is built")

    def test_an_upgraded_home_gains_the_tables_and_keeps_its_rows(self) -> None:
        path = db_path(temp_hermes_home(self))
        # A store as the last schema version really leaves it: everything the migrations built
        # before this change, minus the tables it adds — what a home in use upgrades from.
        old = connect(path)
        old.execute("DROP TABLE app_pages")
        old.execute("DROP TABLE apps")
        old.execute("INSERT INTO chats (id, at, value) VALUES ('c1', 5, '{}')")
        old.execute("PRAGMA user_version = 54")
        old.close()
        self.assertEqual(apps.listing(path), [], "the upgraded store answers its new read at once")
        found, version = self.tables(path)
        self.assertIn("apps", found)
        self.assertIn("app_pages", found)
        self.assertEqual(version, SCHEMA_VERSION, "one pass takes the store all the way")
        kept = sqlite3.connect(path)
        try:
            row = kept.execute("SELECT at FROM chats WHERE id = 'c1'").fetchone()
        finally:
            kept.close()
        self.assertEqual(row[0], 5, "nothing the store held is touched on the way")


class Schema(unittest.TestCase):
    """A page's position decides which page is the root, so the store holds one page per position
    and no negative ones: an order the reader has to invent is an app that opens on a page nobody
    chose."""

    def setUp(self) -> None:
        self.path = db_path(temp_hermes_home(self))

    def test_a_second_page_cannot_take_a_position_another_page_holds(self) -> None:
        with self.assertRaises(sqlite3.IntegrityError):
            plant(
                self.path,
                "house",
                pages=[Page(0, "home", "# id: home", None), Page(0, "cellar", "# id: cellar", None)],
            )
        self.assertEqual(
            apps.listing(self.path),
            [],
            "the half-written app is written whole or not at all",
        )

    def test_a_page_cannot_take_a_negative_position(self) -> None:
        with self.assertRaises(sqlite3.IntegrityError):
            plant(self.path, "house", pages=[Page(-1, "cellar", "# id: cellar", None)])


class Reads(unittest.TestCase):
    def setUp(self) -> None:
        self.path = db_path(temp_hermes_home(self))

    def test_the_list_names_an_apps_title_and_page_ids_and_never_a_source(self) -> None:
        plant(self.path, "house", title="House", at=1, pages=[Page(0, "home", "# id: home\nroot", None)])
        plant(
            self.path,
            "trip",
            title="Lisbon",
            at=2,
            pages=[
                Page(0, "home", "# id: home\nroot", "# id: home\nwas"),
                Page(1, "days", "# id: days", None),
            ],
        )
        self.assertEqual(
            apps.listing(self.path),
            [
                {"id": "trip", "title": "Lisbon", "library_version": "1.0.1", "pages": ["home", "days"]},
                {"id": "house", "title": "House", "library_version": "1.0.1", "pages": ["home"]},
            ],
            "every app is its title, its library version and its page ids, newest app first — and no source",
        )

    def test_the_page_ids_keep_their_positions_so_the_root_is_first(self) -> None:
        plant(
            self.path,
            "house",
            pages=[Page(1, "days", "# id: days", None), Page(0, "home", "# id: home", None)],
        )
        self.assertEqual(
            apps.listing(self.path)[0]["pages"],
            ["home", "days"],
            "the page a build answered first is the root the app opens on",
        )

    def test_a_page_answers_its_source_and_whether_an_undo_is_available(self) -> None:
        plant(
            self.path,
            "house",
            pages=[
                Page(0, "home", "# id: home\nnow", "# id: home\nbefore"),
                Page(1, "room", "# id: room\nnow", None),
            ],
        )
        self.assertEqual(
            apps.page(self.path, "house", "home"),
            {"id": "home", "app_id": "house", "source": "# id: home\nnow", "undoable": True},
            "the source its last change replaced is one step of undo",
        )
        self.assertEqual(
            apps.page(self.path, "house", "room"),
            {"id": "room", "app_id": "house", "source": "# id: room\nnow", "undoable": False},
            "nothing has replaced this page's source, so there is nothing to undo",
        )

    def test_a_page_whose_app_does_not_exist_is_not_found(self) -> None:
        with self.assertRaises(apps.AppsError) as caught:
            apps.page(self.path, "ghost", "home")
        self.assertEqual(caught.exception.status, 404)
        self.assertEqual(str(caught.exception), "No such app.")

    def test_a_read_on_a_home_with_no_store_leaves_no_store_behind(self) -> None:
        self.assertEqual(apps.listing(self.path), [], "a home with no store holds no apps")
        with self.assertRaises(apps.AppsError) as caught:
            apps.page(self.path, "ghost", "home")
        self.assertEqual(caught.exception.status, 404)
        self.assertFalse(self.path.exists(), "a read is read-only: it builds nothing")

    def test_a_page_that_is_not_there_is_not_found(self) -> None:
        plant(self.path, "house", pages=[Page(0, "home", "# id: home", None)])
        with self.assertRaises(apps.AppsError) as caught:
            apps.page(self.path, "house", "attic")
        self.assertEqual(caught.exception.status, 404)
        self.assertEqual(str(caught.exception), "No such page.")

    def test_a_page_row_left_behind_by_a_deleted_app_is_not_found(self) -> None:
        plant(self.path, "house", pages=[Page(0, "home", "# id: home", None)])
        conn = connect(self.path)
        conn.execute("DELETE FROM apps WHERE id = 'house'")
        conn.close()
        with self.assertRaises(apps.AppsError) as caught:
            apps.page(self.path, "house", "home")
        self.assertEqual(caught.exception.status, 404, "an app that is gone stays gone")


class Routes(unittest.TestCase):
    """The two reads as the app asks them: the registered paths and the answers on the wire."""

    def setUp(self) -> None:
        self.home = temp_hermes_home(self)
        self.path = db_path(self.home)
        self.adapter = RouteAdapter()
        self.app = wire(self, self.adapter)

    def listing(self) -> Any:
        request = FakeWeb.Request()
        request.match_info, request.headers = {}, {}
        return asyncio.run(route(self.app, plugin.PREFIX + "/apps", "GET")(request))

    def page(self, app_id: str, page_id: str) -> Any:
        request = FakeWeb.Request()
        request.match_info = {"app_id": app_id, "page_id": page_id}
        request.headers = {}
        return asyncio.run(
            route(self.app, plugin.PREFIX + "/apps/{app_id}/pages/{page_id}", "GET")(request)
        )

    def test_the_list_answers_every_app_without_a_source(self) -> None:
        plant(
            self.path,
            "house",
            title="House",
            pages=[Page(0, "home", "# id: home\nroot = Stack([])", None)],
        )
        answer = self.listing()
        self.assertEqual(answer["status"], 200)
        self.assertEqual(
            answer["payload"],
            {
                "object": "memento.apps",
                "apps": [
                    {
                        "id": "house",
                        "title": "House",
                        "library_version": "1.0.1",
                        "pages": ["home"],
                    }
                ],
            },
        )
        self.assertNotIn("source", json.dumps(answer["payload"]), "a source is never listed")

    def test_the_page_answers_its_source_and_whether_an_undo_is_available(self) -> None:
        plant(
            self.path,
            "house",
            pages=[
                Page(0, "home", "# id: home\nnow", "# id: home\nbefore"),
                Page(1, "room", "# id: room\nnow", None),
            ],
        )
        changed = self.page("house", "home")
        self.assertEqual(changed["status"], 200)
        self.assertEqual(
            changed["payload"],
            {
                "object": "memento.app.page",
                "page": {
                    "id": "home",
                    "app_id": "house",
                    "source": "# id: home\nnow",
                    "undoable": True,
                },
            },
        )
        untouched = self.page("house", "room")
        self.assertFalse(untouched["payload"]["page"]["undoable"])

    def test_a_page_whose_app_does_not_exist_answers_not_found(self) -> None:
        answer = self.page("ghost", "home")
        self.assertEqual(answer["status"], 404)
        self.assertEqual(answer["payload"], {"error": {"message": "No such app."}})

    def test_the_reads_need_the_bots_key(self) -> None:
        plant(self.path, "house", pages=[Page(0, "home", "# id: home", None)])
        self.adapter.denied = {"status": 401, "payload": {}}
        self.assertEqual(self.listing(), {"status": 401, "payload": {}})
        self.assertEqual(self.page("house", "home"), {"status": 401, "payload": {}})

    def test_info_advertises_the_apps_the_host_keeps(self) -> None:
        request = FakeWeb.Request()
        request.match_info, request.headers = {}, {}
        answer = asyncio.run(route(self.app, plugin.PREFIX + "/info")(request))
        self.assertEqual(answer["status"], 200)
        self.assertIn("apps", answer["payload"]["features"])


class Writes(unittest.TestCase):
    """Creating an app and writing, then undoing, one page's whole source over the API."""

    def setUp(self) -> None:
        self.home = temp_hermes_home(self)
        self.path = db_path(self.home)
        self.adapter = RouteAdapter()
        self.app = wire(self, self.adapter)

    def send(self, path: str, match: Any, body: Any) -> Any:
        request = FakeWeb.Request()
        request.match_info, request.headers = match, {}

        async def read() -> Any:
            return body

        request.json = read
        return asyncio.run(route(self.app, plugin.PREFIX + path, "POST")(request))

    def create(self, title: Any = "House", source: Any = "# id: home\nroot = Stack([])") -> Any:
        return self.send("/apps", {}, {"title": title, "source": source})

    def write(self, app_id: str, page_id: str, source: Any) -> Any:
        return self.send(
            "/apps/{app_id}/pages/{page_id}", {"app_id": app_id, "page_id": page_id}, {"source": source}
        )

    def undo(self, app_id: str, page_id: str) -> Any:
        return self.send(
            "/apps/{app_id}/pages/{page_id}/undo", {"app_id": app_id, "page_id": page_id}, {}
        )

    def test_creating_an_app_keeps_its_source_as_the_root_page(self) -> None:
        answer = self.create()
        self.assertEqual(answer["status"], 201)
        made = answer["payload"]["app"]
        self.assertEqual((made["title"], made["pages"]), ("House", ["home"]))
        self.assertEqual(apps.listing(self.path), [made])
        read = apps.page(self.path, made["id"], "home")
        self.assertEqual(read["source"], "# id: home\nroot = Stack([])")
        self.assertFalse(read["undoable"])

    def test_a_source_without_an_id_line_is_the_root_page(self) -> None:
        made = self.create(source="root = Stack([])")["payload"]["app"]
        self.assertEqual(made["pages"], ["root"])

    def test_a_build_of_three_pages_keeps_all_three_with_the_first_as_the_root(self) -> None:
        pages = [f"# id: {name}\nroot = Stack([])" for name in ("home", "room", "trend")]
        answer = self.send("/apps", {}, {"title": "House", "pages": pages})
        self.assertEqual(answer["status"], 201)
        made = answer["payload"]["app"]
        self.assertEqual(made["pages"], ["home", "room", "trend"])
        self.assertEqual(apps.listing(self.path)[0]["pages"], ["home", "room", "trend"])
        self.assertEqual(apps.page(self.path, made["id"], "trend")["source"], pages[2])

    def test_a_build_with_one_page_refused_writes_none_of_them(self) -> None:
        pages = ["# id: home\nroot = Stack([])", "x" * (apps.PAGE_MAX_CHARS + 1)]
        self.assertEqual(self.send("/apps", {}, {"title": "House", "pages": pages})["status"], 413)
        twins = ["# id: home\nroot = Stack([])"] * 2
        self.assertEqual(self.send("/apps", {}, {"title": "House", "pages": twins})["status"], 400)
        self.assertEqual(self.send("/apps", {}, {"title": "House", "pages": []})["status"], 400)
        self.assertEqual(apps.listing(self.path), [])

    def test_a_build_session_is_marked_as_an_app_run(self) -> None:
        answer = self.send("/apps/builds", {}, {"session_id": "run-1"})
        self.assertEqual(answer["status"], 201)
        self.assertTrue(openui.is_app_run({"session_id": "run-1"}, self.path))
        self.assertEqual(self.send("/apps/builds", {}, {})["status"], 400)

    def test_a_second_write_keeps_the_first_source_and_undo_answers_it(self) -> None:
        app_id = self.create()["payload"]["app"]["id"]
        written = self.write(app_id, "home", "# id: home\nroot = Stack([a])\na = Callout(\"info\", \"Hi\")")
        self.assertEqual(written["status"], 200)
        self.assertTrue(written["payload"]["page"]["undoable"])
        undone = self.undo(app_id, "home")
        self.assertEqual(undone["status"], 200)
        self.assertEqual(undone["payload"]["page"]["source"], "# id: home\nroot = Stack([])")
        self.assertFalse(undone["payload"]["page"]["undoable"], "one step, so the next has none")
        self.assertEqual(self.undo(app_id, "home")["status"], 409)

    def test_a_write_to_an_app_or_page_that_is_not_there_creates_nothing(self) -> None:
        app_id = self.create()["payload"]["app"]["id"]
        before = apps.listing(self.path)
        ghost = self.write("ghost", "home", "root = Stack([])")
        self.assertEqual((ghost["status"], ghost["payload"]["error"]["message"]), (404, "No such app."))
        room = self.write(app_id, "cellar", "root = Stack([])")
        self.assertEqual((room["status"], room["payload"]["error"]["message"]), (404, "No such page."))
        self.assertEqual(self.undo("ghost", "home")["status"], 404)
        self.assertEqual(apps.listing(self.path), before)
        self.assertEqual(apps.listing(self.path)[0]["pages"], ["home"])

    def test_a_write_to_a_store_that_is_not_there_does_not_bring_it_into_being(self) -> None:
        self.assertEqual(self.write("ghost", "home", "root = Stack([])")["status"], 404)
        self.assertEqual(self.undo("ghost", "home")["status"], 404)
        self.assertFalse(self.path.exists())

    def test_a_source_past_the_page_cap_is_refused_and_names_the_cap(self) -> None:
        app_id = self.create()["payload"]["app"]["id"]
        big = "x" * (apps.PAGE_MAX_CHARS + 1)
        refused = self.write(app_id, "home", big)
        self.assertEqual(refused["status"], 413)
        self.assertIn("page cap", refused["payload"]["error"]["message"])
        self.assertIn(str(apps.PAGE_MAX_CHARS), refused["payload"]["error"]["message"])
        self.assertEqual(apps.page(self.path, app_id, "home")["source"], "# id: home\nroot = Stack([])")
        before = apps.listing(self.path)
        self.assertEqual(self.create(source=big)["status"], 413)
        self.assertEqual(apps.listing(self.path), before, "a refused build creates nothing")

    def test_a_source_at_the_cap_is_kept_whole(self) -> None:
        source = "x" * apps.PAGE_MAX_CHARS
        made = self.create(source=source)["payload"]["app"]
        self.assertEqual(apps.page(self.path, made["id"], "root")["source"], source)

    def test_an_empty_source_or_title_is_refused(self) -> None:
        self.assertEqual(self.create(source="  ")["status"], 400)
        self.assertEqual(self.create(title="")["status"], 400)

    def test_the_writes_need_the_bots_key(self) -> None:
        self.adapter.denied = {"status": 401, "payload": {}}
        self.assertEqual(self.create(), {"status": 401, "payload": {}})
        self.assertEqual(self.write("a", "b", "x"), {"status": 401, "payload": {}})
        self.assertEqual(apps.listing(self.path), [])


class Queries(unittest.TestCase):
    """A page's `Query` as the host answers it: only a host shape, and a refusal that says why."""

    def setUp(self) -> None:
        self.home = temp_hermes_home(self)
        self.adapter = RouteAdapter()
        self.app = wire(self, self.adapter)

    def ask(self, body: Any) -> Any:
        request = FakeWeb.Request()
        request.match_info, request.headers = {}, {}

        async def read() -> Any:
            if body is None:
                raise ValueError("not json")
            return body

        request.json = read
        return asyncio.run(route(self.app, plugin.PREFIX + "/apps/query", "POST")(request))

    def test_sessions_answers_the_hosts_chats(self) -> None:
        answer = self.ask({"shape": "sessions"})
        self.assertEqual(answer["status"], 200)
        self.assertEqual(answer["payload"]["object"], "memento.app.query")
        self.assertEqual(answer["payload"]["shape"], "sessions")
        self.assertEqual(answer["payload"]["value"], {"sessions": {}})

    def test_usage_answers_what_the_usage_route_does(self) -> None:
        fetched = {"provider": "codex", "plan": "pro", "windows": []}
        with mock.patch.object(plugin.usage, "fetch", return_value=fetched) as fetch:
            answer = self.ask({"shape": "usage", "args": {"provider": " Codex "}})
        fetch.assert_called_once_with("codex")
        self.assertEqual(answer["payload"]["value"], fetched)

    def test_usage_without_a_provider_is_refused(self) -> None:
        answer = self.ask({"shape": "usage"})
        self.assertEqual(answer["status"], 400)
        self.assertIn("provider", answer["payload"]["error"]["message"])

    def test_anything_but_a_host_shape_is_refused_naming_the_shapes(self) -> None:
        for shape in ("mcp_call", "skills", None, 3, "", ["usage"], {}):
            answer = self.ask({"shape": shape})
            self.assertEqual(answer["status"], 400, shape)
            for name in ("usage", "routines", "projects", "sessions"):
                self.assertIn(name, answer["payload"]["error"]["message"])

    def test_a_body_that_is_not_an_object_is_refused(self) -> None:
        self.assertEqual(self.ask(None)["status"], 400)
        self.assertEqual(self.ask([1])["status"], 400)

    def test_the_query_needs_the_bots_key(self) -> None:
        self.adapter.denied = {"status": 401, "payload": {}}
        self.assertEqual(self.ask({"shape": "sessions"}), {"status": 401, "payload": {}})


if __name__ == "__main__":
    unittest.main()
