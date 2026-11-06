"""A bot's apps and their pages: the record the store gains and the two reads that answer it.

Run: python3 -m unittest plugin.tests.test_apps -v
"""

from __future__ import annotations

import asyncio
import json
import shutil
import sqlite3
import tempfile
import unittest
from unittest import mock
from pathlib import Path
from typing import Any, Dict, NamedTuple, Optional, Sequence, Set, Tuple
from unittest import mock

import plugin
from plugin import apps, openui
from plugin.store import SCHEMA_VERSION, connect, db_path
from plugin.tests._helpers import FakeWeb, RouteAdapter, route, temp_hermes_home, wire


def bundle_of(test: unittest.TestCase, apps_: Dict[str, Dict[str, Any]]) -> Path:
    """A bundle folder the test owns, standing in for the plugin's own: ``apps_`` maps a key to
    ``{"version", "title", "pages": {file name: source}}``. ``apps.BUNDLE`` points at it until the
    test ends."""
    root = Path(tempfile.mkdtemp())
    test.addCleanup(shutil.rmtree, root, True)
    manifest: Dict[str, Any] = {"set_version": 1, "apps": {}}
    for key, entry in apps_.items():
        manifest["apps"][key] = {
            "version": entry["version"],
            "title": entry["title"],
            "pages": list(entry["pages"]),
        }
        for name, source in entry["pages"].items():
            (root / name).parent.mkdir(parents=True, exist_ok=True)
            (root / name).write_text(source, encoding="utf-8")
    (root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    patch = mock.patch.object(apps, "BUNDLE", root)
    patch.start()
    test.addCleanup(patch.stop)
    return root


NONE = {"reads": [], "acts": []}
GENERATED = {"builtin": None, "hidden": False, "update": False, "tools": NONE, "pending": NONE}


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

    def setUp(self) -> None:
        bundle_of(self, {})

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
        bundle_of(self, {})
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
        bundle_of(self, {})
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
                {"id": "trip", "title": "Lisbon", "library_version": "1.0.1", "pages": ["home", "days"], **GENERATED},
                {"id": "house", "title": "House", "library_version": "1.0.1", "pages": ["home"], **GENERATED},
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
        bundle_of(self, {})
        self.home = temp_hermes_home(self)
        self.path = db_path(self.home)
        self.adapter = RouteAdapter()
        self.app = wire(self, self.adapter)

    def listing(self) -> Any:
        request = FakeWeb.Request()
        request.match_info, request.headers, request.query = {}, {}, {}
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
                "object": "gots.apps",
                "apps": [
                    {
                        "id": "house",
                        "title": "House",
                        "library_version": "1.0.1",
                        "pages": ["home"],
                        "builtin": None,
                        "hidden": False,
                        "update": False,
                        "tools": NONE,
                        "pending": NONE,
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
                "object": "gots.app.page",
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
        bundle_of(self, {})
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


class Consent(unittest.TestCase):
    """What an app may call is read off its pages, kept with it, and grown only by agreeing."""

    def test_the_cases_the_app_also_reads_name_the_same_tools(self) -> None:
        from plugin.app_tools import tools_of

        cases = json.loads((Path(__file__).parent / "consent-cases.json").read_text())
        for case in cases:
            self.assertEqual(tools_of(case["sources"]), case["consent"], case["name"])

    def test_a_row_left_without_a_list_by_a_cut_short_migration_is_filled_on_the_next_open(
        self,
    ) -> None:
        made = apps.create(self.path, "House", '# id: root\nroot = Stack([a])\na = Query("light", {})')
        conn = connect(self.path)
        conn.execute("UPDATE apps SET consent = NULL")
        conn.execute("PRAGMA user_version = 56")
        conn.commit()
        conn.close()
        self.assertEqual(apps.listing(self.path)[0]["tools"], {"reads": ["light"], "acts": []})
        self.assertTrue(apps.may_call(self.path, made["id"], "light"))

    def setUp(self) -> None:
        bundle_of(self, {})
        self.path = db_path(temp_hermes_home(self))

    def test_saving_groups_the_tools_as_reads_and_acts_and_leaves_the_hosts_own_out(self) -> None:
        source = (
            '# id: root\nroot = Stack([a, b, c, d])\na = Query("light", {}, {})\n'
            'b = Mutation("switch", {})\nc = Query("usage", {}, {})\n'
            'd = Query("/apps/query", {}, {})'
        )
        made = apps.create(self.path, "House", source)
        self.assertEqual(made["tools"], {"reads": ["light"], "acts": ["switch"]})
        self.assertEqual(made["pending"], NONE)

    def test_a_page_that_names_a_new_tool_asks_for_only_the_difference(self) -> None:
        made = apps.create(
            self.path, "House", '# id: root\nroot = Stack([a])\na = Query("light", {}, {})'
        )
        apps.write(
            self.path,
            made["id"],
            "root",
            '# id: root\nroot = Stack([a, b, c])\na = Query("light", {}, {})\n'
            'b = Query("lock", {}, {})\nc = Mutation("switch", {})',
        )
        (listed,) = apps.listing(self.path)
        self.assertEqual(listed["tools"], {"reads": ["light"], "acts": []})
        self.assertEqual(listed["pending"], {"reads": ["lock"], "acts": ["switch"]})

    def test_agreeing_takes_the_list_shown_and_nothing_else(self) -> None:
        made = apps.create(self.path, "House", '# id: root\nroot = Query("light", {}, {})')
        apps.write(self.path, made["id"], "root", '# id: root\nr = Query("lock", {}, {})')
        with self.assertRaises(apps.AppsError) as stale:
            apps.consent(self.path, made["id"], {"reads": ["alarm"], "acts": []})
        self.assertEqual(stale.exception.status, 409)
        with self.assertRaises(apps.AppsError) as junk:
            apps.consent(self.path, made["id"], {"reads": "lock"})
        self.assertEqual(junk.exception.status, 400)
        agreed = apps.consent(self.path, made["id"], {"reads": ["lock"], "acts": []})
        self.assertEqual(agreed["tools"], {"reads": ["lock"], "acts": []})
        self.assertEqual(apps.listing(self.path)[0]["pending"], NONE)
        self.assertTrue(apps.may_call(self.path, made["id"], "lock"))

    def test_a_tool_dropped_and_named_again_is_asked_about_again(self) -> None:
        made = apps.create(self.path, "House", '# id: root\nroot = Query("light", {}, {})')
        apps.write(self.path, made["id"], "root", "# id: root\nroot = Stack([])")
        apps.consent(self.path, made["id"], NONE)
        apps.write(self.path, made["id"], "root", '# id: root\nroot = Query("light", {}, {})')
        self.assertEqual(apps.listing(self.path)[0]["pending"], {"reads": ["light"], "acts": []})

    def test_consent_for_an_app_that_is_gone_is_a_404(self) -> None:
        with self.assertRaises(apps.AppsError) as gone:
            apps.consent(self.path, "app-x", NONE)
        self.assertEqual(gone.exception.status, 404)

    def test_an_upgraded_store_agrees_its_apps_to_what_they_already_name(self) -> None:
        connect(self.path).close()
        plant(
            self.path,
            "old",
            pages=[Page(0, "root", '# id: root\nroot = Query("light", {}, {})', None)],
        )
        conn = connect(self.path)
        conn.execute("ALTER TABLE apps DROP COLUMN consent")
        conn.execute("PRAGMA user_version = 56")
        conn.close()
        (listed,) = apps.listing(self.path)
        self.assertEqual(listed["tools"], {"reads": ["light"], "acts": []})

    def test_a_built_in_app_is_agreed_to_what_its_bundle_names(self) -> None:
        bundle_of(
            self,
            {"home": built(1, root='# id: root\nroot = Query("light", {}, {})')},
        )
        (listed,) = apps.listing(self.path)
        self.assertEqual(listed["tools"], {"reads": ["light"], "acts": []})

    def test_the_consent_route_needs_the_key_and_answers_the_list(self) -> None:
        adapter = RouteAdapter()
        app = wire(self, adapter)
        made = apps.create(self.path, "House", '# id: root\nroot = Query("light", {}, {})')
        apps.write(self.path, made["id"], "root", '# id: root\nr = Query("lock", {}, {})')
        request = FakeWeb.Request()
        request.match_info, request.headers = {"app_id": made["id"]}, {}

        async def read() -> Any:
            return {"reads": ["lock"], "acts": []}

        request.json = read
        handler = route(app, plugin.PREFIX + "/apps/{app_id}/consent", "POST")
        adapter.denied = {"status": 401, "payload": {}}
        self.assertEqual(asyncio.run(handler(request)), {"status": 401, "payload": {}})
        adapter.denied = None
        answer = asyncio.run(handler(request))
        self.assertEqual(answer["status"], 200)
        self.assertEqual(answer["payload"]["app"]["tools"], {"reads": ["lock"], "acts": []})


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

    def test_the_hosts_reserved_names_are_the_shapes_its_query_route_answers(self) -> None:
        from plugin.app_tools import HOST_SHAPES

        for shape in HOST_SHAPES:
            self.assertNotEqual(self.ask({"shape": shape})["status"], 403, shape)
        self.assertEqual(self.ask({"shape": "ghost"})["status"], 403)

    def test_sessions_answers_the_hosts_chats(self) -> None:
        answer = self.ask({"shape": "sessions"})
        self.assertEqual(answer["status"], 200)
        self.assertEqual(answer["payload"]["object"], "gots.app.query")
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

    def test_a_tool_no_app_was_agreed_to_is_refused_where_the_call_happens(self) -> None:
        for shape in ("mcp_call", "skills", None, 3, "", ["usage"], {}):
            answer = self.ask({"shape": shape})
            self.assertEqual(answer["status"], 403, shape)
            self.assertIn("never agreed", answer["payload"]["error"]["message"])

    def test_an_app_is_refused_a_tool_its_pages_named_after_it_was_saved(self) -> None:
        path = db_path(self.home)
        made = apps.create(path, "House", '# id: root\nroot = Stack([])\nl = Query("light", {}, {})')
        self.assertEqual(self.ask({"app": made["id"], "shape": "light"})["status"], 501)
        apps.write(path, made["id"], "root", '# id: root\nr = Query("lock", {}, {})')
        self.assertEqual(self.ask({"app": made["id"], "shape": "lock"})["status"], 403)

    def test_an_agreed_server_tool_is_answered_by_the_mcp_client(self) -> None:
        path = db_path(self.home)
        source = '# id: root\nroot = Stack([])\nl = Query("home.light", {}, {})'
        made = apps.create(path, "House", source)
        with mock.patch.object(plugin.mcp_call, "call", return_value={"on": True}) as called:
            answer = self.ask({"app": made["id"], "shape": "home.light", "args": {"id": 1}})
        self.assertEqual(answer["status"], 200)
        self.assertEqual(answer["payload"]["value"], {"on": True})
        self.assertEqual(called.call_args.args[1:], ("home.light", {"id": 1}))

    def test_a_server_that_cannot_answer_is_a_502_with_its_reason(self) -> None:
        path = db_path(self.home)
        made = apps.create(path, "House", '# id: root\nl = Query("home.light", {}, {})')
        refusal = plugin.mcp.McpError("The MCP server 'home' is off.", 502)
        with mock.patch.object(plugin.mcp_call, "call", side_effect=refusal):
            answer = self.ask({"app": made["id"], "shape": "home.light"})
        self.assertEqual(answer["status"], 502)
        self.assertIn("is off", answer["payload"]["error"]["message"])

    def test_an_unagreed_server_tool_is_never_called(self) -> None:
        with mock.patch.object(plugin.mcp_call, "call") as called:
            answer = self.ask({"app": "ghost", "shape": "home.light"})
        self.assertEqual(answer["status"], 403)
        called.assert_not_called()

    def test_an_agreed_act_is_answered_by_the_mcp_client(self) -> None:
        path = db_path(self.home)
        made = apps.create(path, "House", '# id: root\nroot = Mutation("home.switch", {})')
        with mock.patch.object(plugin.mcp_call, "call", return_value={"on": False}) as called:
            answer = self.ask(
                {"app": made["id"], "shape": "home.switch", "args": {"on": False}, "write": True}
            )
        self.assertEqual(answer["status"], 200)
        self.assertEqual(answer["payload"]["value"], {"on": False})
        self.assertEqual(called.call_args.args[1:], ("home.switch", {"on": False}))

    def test_an_agreed_act_is_never_answered_as_a_read_and_a_read_never_as_a_write(self) -> None:
        path = db_path(self.home)
        source = '# id: root\nroot = Stack([])\na = Mutation("home.switch", {})\nr = Query("home.light", {})'
        made = apps.create(path, "House", source)
        with mock.patch.object(plugin.mcp_call, "call") as called:
            as_read = self.ask({"app": made["id"], "shape": "home.switch"})
            as_write = self.ask({"app": made["id"], "shape": "home.light", "write": True})
        self.assertEqual((as_read["status"], as_write["status"]), (403, 403))
        called.assert_not_called()

    def test_a_host_shape_is_never_answered_as_a_write(self) -> None:
        answer = self.ask({"shape": "sessions", "write": True})
        self.assertEqual(answer["status"], 400)

    def test_an_act_the_app_was_never_agreed_to_is_never_called(self) -> None:
        path = db_path(self.home)
        made = apps.create(path, "House", '# id: root\nroot = Mutation("home.switch", {})')
        apps.write(path, made["id"], "root", '# id: root\nroot = Mutation("home.lock", {})')
        with mock.patch.object(plugin.mcp_call, "call") as called:
            answer = self.ask({"app": made["id"], "shape": "home.lock", "write": True})
        self.assertEqual(answer["status"], 403)
        called.assert_not_called()

    def test_the_hosts_own_reads_carry_no_consent(self) -> None:
        self.assertEqual(self.ask({"shape": "sessions"})["status"], 200)

    def test_a_body_that_is_not_an_object_is_refused(self) -> None:
        self.assertEqual(self.ask(None)["status"], 400)
        self.assertEqual(self.ask([1])["status"], 400)

    def test_the_query_needs_the_bots_key(self) -> None:
        self.adapter.denied = {"status": 401, "payload": {}}
        self.assertEqual(self.ask({"shape": "sessions"}), {"status": 401, "payload": {}})
def built(version: int = 1, **pages: str) -> Dict[str, Any]:
    return {
        "version": version,
        "title": "Home",
        "pages": pages or {"home/root.txt": "# id: root\nroot = Stack([])", "home/room.txt": "# id: room"},
    }


class Decision(unittest.TestCase):
    def test_a_missing_app_is_created(self) -> None:
        self.assertEqual(apps.decide(1, None, False), "create")

    def test_an_untouched_app_behind_the_bundle_is_replaced(self) -> None:
        self.assertEqual(apps.decide(2, 1, False), "replace")

    def test_an_untouched_app_at_the_bundles_version_is_not_written(self) -> None:
        self.assertEqual(apps.decide(1, 1, False), "none")

    def test_an_edited_app_behind_the_bundle_reports_an_update(self) -> None:
        self.assertEqual(apps.decide(2, 1, True), "update")

    def test_an_edited_app_at_the_bundles_version_owes_nothing(self) -> None:
        self.assertEqual(apps.decide(1, 1, True), "none")


class BuiltIns(unittest.TestCase):
    def setUp(self) -> None:
        self.path = db_path(temp_hermes_home(self))

    def bundle(self, **entries: Dict[str, Any]) -> None:
        bundle_of(self, entries)

    def rows(self, sql: str = "SELECT * FROM apps ORDER BY id") -> list:
        conn = sqlite3.connect(self.path)
        try:
            return conn.execute(sql).fetchall()
        finally:
            conn.close()

    def test_the_first_list_read_seeds_every_built_in_with_its_pages_in_order(self) -> None:
        self.bundle(home=built(), gtd={**built(), "title": "Tasks"})
        listed = apps.listing(self.path)
        self.assertEqual({row["builtin"] for row in listed}, {"home", "gtd"})
        home = next(row for row in listed if row["builtin"] == "home")
        self.assertEqual(home["pages"], ["root", "room"], "the first page the bundle lists is the root")
        self.assertEqual(apps.page(self.path, home["id"], "root")["source"], "# id: root\nroot = Stack([])")

    def test_a_second_read_writes_nothing(self) -> None:
        self.bundle(home=built())
        apps.listing(self.path)
        before = self.path.read_bytes()
        mtime = self.path.stat().st_mtime_ns
        apps.listing(self.path)
        self.assertEqual(self.path.stat().st_mtime_ns, mtime)
        self.assertEqual(self.path.read_bytes(), before)

    def test_a_reinstall_creates_no_duplicate(self) -> None:
        self.bundle(home=built())
        apps.listing(self.path)
        bundle_of(self, {"home": built()})
        apps.listing(self.path)
        self.assertEqual(len(self.rows()), 1)

    def test_seeding_is_the_first_read_and_not_install(self) -> None:
        self.bundle(home=built())
        self.assertFalse(self.path.exists())
        apps.listing(self.path)
        self.assertTrue(self.path.exists())

    def test_a_built_in_is_refused_a_delete_and_a_generated_app_is_not(self) -> None:
        self.bundle(home=built())
        builtin = apps.listing(self.path)[0]["id"]
        with self.assertRaises(apps.AppsError) as refused:
            apps.remove(self.path, builtin)
        self.assertEqual(refused.exception.status, 409)
        self.assertEqual(len(self.rows("SELECT 1 FROM app_pages")), 2, "nothing was deleted")
        made = apps.create(self.path, "Mine", "# id: root\nroot = Stack([])")
        apps.remove(self.path, made["id"])
        self.assertEqual([row["id"] for row in apps.listing(self.path)], [builtin])
        self.assertEqual(self.rows(f"SELECT 1 FROM app_pages WHERE app_id = '{made['id']}'"), [])
        with self.assertRaises(apps.AppsError) as gone:
            apps.remove(self.path, made["id"])
        self.assertEqual(gone.exception.status, 404)

    def test_hiding_is_a_mark_on_the_host_that_the_list_leaves_out_and_unhiding_brings_back(self) -> None:
        self.bundle(home=built())
        builtin = apps.listing(self.path)[0]["id"]
        apps.set_hidden(self.path, builtin, True)
        self.assertEqual(apps.listing(self.path), [])
        shown = apps.listing(self.path, include_hidden=True)
        self.assertEqual([(row["id"], row["hidden"]) for row in shown], [(builtin, True)])
        apps.set_hidden(self.path, builtin, False)
        self.assertEqual(len(apps.listing(self.path)), 1)
        self.assertEqual(self.rows("SELECT hidden FROM apps"), [(0,)])

    def test_a_hidden_built_in_stays_hidden_through_a_reinstall_and_is_not_recreated(self) -> None:
        self.bundle(home=built())
        builtin = apps.listing(self.path)[0]["id"]
        apps.set_hidden(self.path, builtin, True)
        bundle_of(self, {"home": built()})
        self.assertEqual(apps.listing(self.path), [])
        self.assertEqual(len(self.rows()), 1)

    def test_only_a_built_in_is_hidden(self) -> None:
        self.bundle()
        made = apps.create(self.path, "Mine", "# id: root\nroot = Stack([])")
        with self.assertRaises(apps.AppsError) as refused:
            apps.set_hidden(self.path, made["id"], True)
        self.assertEqual(refused.exception.status, 409)
        with self.assertRaises(apps.AppsError) as bad:
            apps.set_hidden(self.path, made["id"], "yes")
        self.assertEqual(bad.exception.status, 400)

    def test_an_untouched_built_in_is_replaced_wholesale_when_the_bundles_version_moves(self) -> None:
        self.bundle(home=built())
        builtin = apps.listing(self.path)[0]["id"]
        self.bundle(
            home={"version": 2, "title": "House", "pages": {"home/new.txt": "# id: root\nroot = Card(\"New\")"}}
        )
        listed = apps.listing(self.path)
        self.assertEqual(
            [(row["id"], row["title"], row["pages"], row["update"]) for row in listed],
            [(builtin, "House", ["root"], False)],
        )
        self.assertEqual(apps.page(self.path, builtin, "root")["source"], "# id: root\nroot = Card(\"New\")")
        self.assertEqual(self.rows("SELECT builtin_version FROM apps"), [(2,)])

    def test_a_hidden_untouched_built_in_still_updates(self) -> None:
        self.bundle(home=built())
        builtin = apps.listing(self.path)[0]["id"]
        apps.set_hidden(self.path, builtin, True)
        self.bundle(home=built(2, **{"home/n.txt": "# id: root\nroot = Card(\"New\")"}))
        apps.listing(self.path)
        self.assertEqual(apps.page(self.path, builtin, "root")["source"], "# id: root\nroot = Card(\"New\")")
        self.assertEqual(self.rows("SELECT hidden FROM apps"), [(1,)])

    def test_an_edited_built_in_reports_an_update_and_is_left_alone(self) -> None:
        self.bundle(home=built())
        builtin = apps.listing(self.path)[0]["id"]
        apps.write(self.path, builtin, "root", "# id: root\nroot = Card(\"Mine\")")
        self.bundle(home=built(2, **{"home/n.txt": "# id: root\nroot = Card(\"New\")"}))
        listed = apps.listing(self.path)
        self.assertTrue(listed[0]["update"])
        self.assertEqual(listed[0]["pages"], ["root", "room"])
        self.assertEqual(apps.page(self.path, builtin, "root")["source"], "# id: root\nroot = Card(\"Mine\")")

    def test_an_undo_is_an_edit_too(self) -> None:
        self.bundle(home=built())
        builtin = apps.listing(self.path)[0]["id"]
        apps.write(self.path, builtin, "root", "# id: root\nroot = Card(\"Mine\")")
        self.assertEqual(self.rows("SELECT edited FROM apps"), [(1,)])

    def test_taking_the_update_replaces_every_page_and_clears_the_mark(self) -> None:
        self.bundle(home=built())
        builtin = apps.listing(self.path)[0]["id"]
        apps.write(self.path, builtin, "room", "# id: room\nroot = Card(\"Mine\")")
        self.bundle(home=built(2, **{"home/n.txt": "# id: root\nroot = Card(\"New\")"}))
        apps.take_update(self.path, builtin)
        listed = apps.listing(self.path)
        self.assertEqual((listed[0]["pages"], listed[0]["update"]), (["root"], False))
        self.assertEqual(self.rows("SELECT edited, builtin_version FROM apps"), [(0, 2)])
        self.assertFalse(apps.page(self.path, builtin, "root")["undoable"])
        with self.assertRaises(apps.AppsError) as spent:
            apps.take_update(self.path, builtin)
        self.assertEqual(spent.exception.status, 409)

    def test_an_update_cannot_be_taken_for_a_generated_app(self) -> None:
        self.bundle()
        made = apps.create(self.path, "Mine", "# id: root\nroot = Stack([])")
        with self.assertRaises(apps.AppsError) as refused:
            apps.take_update(self.path, made["id"])
        self.assertEqual(refused.exception.status, 409)

    def test_a_bundle_that_drops_an_app_deletes_nothing_and_resumes_where_it_was(self) -> None:
        self.bundle(home=built(), gtd=built())
        listed = apps.listing(self.path)
        gtd = next(row["id"] for row in listed if row["builtin"] == "gtd")
        apps.write(self.path, gtd, "root", "# id: root\nroot = Card(\"Mine\")")
        self.bundle(home=built())
        after = apps.listing(self.path)
        self.assertEqual(len(after), 2)
        self.assertEqual(apps.page(self.path, gtd, "root")["source"], "# id: root\nroot = Card(\"Mine\")")
        self.assertFalse(next(row for row in after if row["id"] == gtd)["update"])
        with self.assertRaises(apps.AppsError):
            apps.take_update(self.path, gtd)
        self.bundle(home=built(), gtd=built(2))
        self.assertTrue(next(row for row in apps.listing(self.path) if row["id"] == gtd)["update"])

    def test_a_broken_bundle_leaves_the_list_working(self) -> None:
        root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, root, True)
        (root / "manifest.json").write_text("{not json", encoding="utf-8")
        with mock.patch.object(apps, "BUNDLE", root):
            with self.assertLogs("plugin.apps", level="WARNING"):
                self.assertEqual(apps.listing(self.path), [])

    def test_the_bundle_the_plugin_ships_seeds_and_every_page_is_kept(self) -> None:
        listed = apps.listing(self.path)
        self.assertEqual({row["builtin"] for row in listed}, {"home", "gtd"})
        for row in listed:
            self.assertEqual(row["pages"][0], "root")
            for page_id in row["pages"]:
                self.assertTrue(apps.page(self.path, row["id"], page_id)["source"].strip())


class BuiltInRoutes(unittest.TestCase):
    def setUp(self) -> None:
        self.path = db_path(temp_hermes_home(self))
        self.adapter = RouteAdapter()
        self.app = wire(self, self.adapter)
        bundle_of(self, {"home": built()})

    def call(self, verb: str, path: str, match: Any, body: Any = None, query: Any = None) -> Any:
        request = FakeWeb.Request()
        request.match_info, request.headers, request.query = match, {}, query or {}

        async def read() -> Any:
            return body

        request.json = read
        return asyncio.run(route(self.app, plugin.PREFIX + path, verb)(request))

    def test_a_delete_of_a_built_in_is_refused_and_it_is_hidden_over_the_wire(self) -> None:
        listed = self.call("GET", "/apps", {})["payload"]["apps"]
        builtin = listed[0]["id"]
        refused = self.call("DELETE", "/apps/{app_id}", {"app_id": builtin})
        self.assertEqual(refused["status"], 409)
        hid = self.call("POST", "/apps/{app_id}/hidden", {"app_id": builtin}, {"hidden": True})
        self.assertEqual(hid["status"], 200)
        self.assertEqual(self.call("GET", "/apps", {})["payload"]["apps"], [])
        shown = self.call("GET", "/apps", {}, query={"hidden": "1"})["payload"]["apps"]
        self.assertEqual([row["hidden"] for row in shown], [True])

    def test_a_generated_app_is_deleted_over_the_wire(self) -> None:
        made = apps.create(self.path, "Mine", "# id: root\nroot = Stack([])")
        answer = self.call("DELETE", "/apps/{app_id}", {"app_id": made["id"]})
        self.assertEqual(answer["status"], 200)
        self.assertEqual(self.call("DELETE", "/apps/{app_id}", {"app_id": made["id"]})["status"], 404)

    def test_the_update_is_taken_over_the_wire(self) -> None:
        builtin = self.call("GET", "/apps", {})["payload"]["apps"][0]["id"]
        apps.write(self.path, builtin, "root", "# id: root\nroot = Card(\"Mine\")")
        bundle_of(self, {"home": built(2)})
        self.assertTrue(self.call("GET", "/apps", {})["payload"]["apps"][0]["update"])
        taken = self.call("POST", "/apps/{app_id}/update", {"app_id": builtin})
        self.assertEqual(taken["status"], 200)
        self.assertFalse(self.call("GET", "/apps", {})["payload"]["apps"][0]["update"])

    def test_the_new_routes_need_the_bots_key(self) -> None:
        self.adapter.denied = {"status": 401, "payload": {}}
        for verb, path in (
            ("DELETE", "/apps/{app_id}"),
            ("POST", "/apps/{app_id}/hidden"),
            ("POST", "/apps/{app_id}/update"),
        ):
            self.assertEqual(
                self.call(verb, path, {"app_id": "x"}, {"hidden": True}),
                {"status": 401, "payload": {}},
            )
        self.assertFalse(self.path.exists())


if __name__ == "__main__":
    unittest.main()
