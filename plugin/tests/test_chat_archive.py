"""A chat's and a run's archive is Hermes's own ``sessions.archived`` flag (ADR 0159).

Archive is not a Gots feature, it is Hermes's: the flag in the profile's ``state.db`` is what takes a
session out of ``hermes sessions list``, ``/resume`` and the Dashboard. So the plugin writes that
flag when a reader archives, keeps the chat record's own copy of it (so every device hears through
the ordinary merge, and a chat whose session later goes still reads as archived), and reads Hermes
back into every list answer so an archive made on the Dashboard hides the row here.

A compacted conversation archives as a unit: Hermes flips the whole compression lineage and lists the
chat by its newest row, so a write anchored on the chat's first session has to reach the live tip.

Run: python3 -m unittest plugin.tests.test_chat_archive -v
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
import unittest
from contextlib import closing
from pathlib import Path
from typing import Any, Dict, Iterable, Optional
from unittest import mock

import plugin
from plugin import chats, rooms, sessions
from plugin.store import db_path
from plugin.tests._helpers import FakeWeb, RouteAdapter, route, temp_hermes_home, wire

ARCHIVE_PATH = plugin.PREFIX + "/chats/{chat_id}/archived"


def store(home: Path, rows: Iterable[Dict[str, Any]], *, archived: bool = True) -> Path:
    """A Hermes ``state.db`` holding these sessions.

    ``archived`` off builds a schema from before the column existed, which is the host the app has
    to keep its own mark on.
    """
    home.mkdir(parents=True, exist_ok=True)
    path = home / "state.db"
    columns = (
        "id TEXT PRIMARY KEY, parent_session_id TEXT, end_reason TEXT,"
        " model_config TEXT, source TEXT"
    )
    if archived:
        columns += ", archived INTEGER NOT NULL DEFAULT 0"
    with closing(sqlite3.connect(path)) as conn:
        conn.execute(f"CREATE TABLE sessions ({columns})")
        for row in rows:
            names = ", ".join(row)
            marks = ", ".join("?" for _ in row)
            conn.execute(f"INSERT INTO sessions ({names}) VALUES ({marks})", tuple(row.values()))
        conn.commit()
    return path


def chain(*ids: str) -> list[Dict[str, Any]]:
    """Hermes's rows for a compression lineage, oldest first: every row but the tip compacted."""
    return [
        {
            "id": session_id,
            "parent_session_id": ids[i - 1] if i else None,
            "end_reason": "compression" if i < len(ids) - 1 else None,
        }
        for i, session_id in enumerate(ids)
    ]


def held(path: Path, session_id: str) -> Optional[int]:
    """The archive flag on one stored row, or None when the store has no such row."""
    with closing(sqlite3.connect(path)) as conn:
        row = conn.execute("SELECT archived FROM sessions WHERE id = ?", (session_id,)).fetchone()
    return None if row is None else row[0]


class TempHome(unittest.TestCase):
    def setUp(self) -> None:
        self.home = temp_hermes_home(self)


class SetArchived(TempHome):
    """The flag written on the chat's session, through the live tip Hermes lists it by."""

    def test_the_flag_lands_on_the_live_tip_as_well_as_the_first_session(self) -> None:
        path = store(self.home, chain("gots-root", "gots-mid", "gots-tip"))
        self.assertIsNone(sessions.set_archived(self.home, "gots-root", True))
        self.assertEqual(
            {name: held(path, name) for name in ("gots-root", "gots-mid", "gots-tip")},
            {"gots-root": 1, "gots-mid": 1, "gots-tip": 1},
            "a compacted chat archives as a unit, and Hermes lists the tip",
        )

    def test_an_id_from_the_middle_of_the_chain_writes_the_whole_chain(self) -> None:
        path = store(self.home, chain("gots-root", "gots-mid", "gots-tip"))
        self.assertIsNone(sessions.set_archived(self.home, "gots-mid", True))
        self.assertEqual([held(path, name) for name in ("gots-root", "gots-mid", "gots-tip")], [1, 1, 1])

    def test_unarchiving_clears_the_whole_chain(self) -> None:
        path = store(self.home, chain("gots-root", "gots-tip"))
        sessions.set_archived(self.home, "gots-root", True)
        self.assertIsNone(sessions.set_archived(self.home, "gots-root", False))
        self.assertEqual([held(path, name) for name in ("gots-root", "gots-tip")], [0, 0])

    def test_a_child_of_a_session_that_was_not_compacted_is_another_conversation(self) -> None:
        # A branch, a delegation or a reset names the same parent without continuing the chat:
        # Hermes's own lineage selector follows a parent only where it was written by a compaction,
        # so this write follows exactly the same edge.
        path = store(
            self.home,
            [
                {"id": "gots-root", "parent_session_id": None, "end_reason": "cli_close"},
                {"id": "gots-kid", "parent_session_id": "gots-root", "end_reason": None},
            ],
        )
        sessions.set_archived(self.home, "gots-root", True)
        self.assertEqual(held(path, "gots-root"), 1)
        self.assertEqual(held(path, "gots-kid"), 0, "another conversation, and not this chat's")

    def test_a_store_without_the_column_is_a_reason_and_not_a_crash(self) -> None:
        store(self.home, chain("gots-root"), archived=False)
        self.assertEqual(
            sessions.set_archived(self.home, "gots-root", True),
            sessions.NO_ARCHIVE_FLAG,
            "an older schema says so, rather than raising across the route",
        )

    def test_a_store_with_no_sessions_table_is_a_reason_too(self) -> None:
        with closing(sqlite3.connect(self.home / "state.db")) as conn:
            conn.execute("CREATE TABLE something_else (id TEXT)")
            conn.commit()
        self.assertEqual(sessions.set_archived(self.home, "gots-root", True), sessions.NO_ARCHIVE_FLAG)

    def test_a_home_with_no_store_is_a_reason_and_plants_nothing(self) -> None:
        self.assertEqual(sessions.set_archived(self.home, "gots-root", True), sessions.NO_STORE)
        self.assertFalse((self.home / "state.db").exists(), "a write never makes a store")

    def test_a_session_the_store_has_never_seen_is_a_reason(self) -> None:
        store(self.home, chain("gots-root"))
        self.assertEqual(sessions.set_archived(self.home, "gots-gone", True), sessions.NO_SESSION)

    def test_the_flags_are_read_in_one_pass_over_the_store(self) -> None:
        store(self.home, [{"id": "a", "archived": 1}, {"id": "b", "archived": 0}])
        self.assertEqual(sessions.archived_flags(self.home), {"a": True, "b": False})
        self.assertEqual(sessions.archived_flags(self.home / "elsewhere"), {}, "no store, no flags")


class CarryingArchive(unittest.TestCase):
    """The list answer, with Hermes's flag laid over the chats whose session it holds."""

    def record(self, **value: Any) -> Dict[str, Any]:
        return {"at": 5, "value": value}

    def test_a_flag_set_in_hermes_archives_the_chat_in_gots(self) -> None:
        records = {"c1": self.record(hermesSessionId="s1", title="Mine")}
        carried = chats.carrying_archive(records, {"s1": True})
        self.assertEqual(carried["c1"]["value"], {"hermesSessionId": "s1", "title": "Mine", "archived": True})
        self.assertEqual(records["c1"]["value"], {"hermesSessionId": "s1", "title": "Mine"})

    def test_a_flag_cleared_in_hermes_unarchives_it_again(self) -> None:
        records = {"c1": self.record(hermesSessionId="s1", title="Mine", archived=True)}
        carried = chats.carrying_archive(records, {"s1": False})
        self.assertEqual(
            carried["c1"]["value"],
            {"hermesSessionId": "s1", "title": "Mine"},
            "an unarchive on the Dashboard is an unarchive here",
        )

    def test_a_record_whose_session_the_store_does_not_name_keeps_its_own_mark(self) -> None:
        records = {
            "gone": self.record(hermesSessionId="elsewhere", archived=True),
            "unstarted": self.record(title="No session yet"),
        }
        carried = chats.carrying_archive(records, {"s1": True})
        self.assertEqual(carried, records, "nothing is said about a session this store doesn't hold")

    def test_a_rooms_mark_record_carries_no_archive(self) -> None:
        records = {"room-1": self.record(**{chats.ROOM_MARKS: {"archived": False}})}
        carried = chats.carrying_archive(records, {"room-1": True})
        self.assertEqual(carried, records, "a room keeps its own mark (ADR 0157)")

    def test_a_store_with_no_flags_leaves_every_record_as_it_was(self) -> None:
        records = {"c1": self.record(hermesSessionId="s1", archived=True)}
        self.assertEqual(chats.carrying_archive(records, {}), records)

    def test_a_deletion_is_still_a_deletion(self) -> None:
        records = {"c1": {"at": 5, "deleted": True}}
        self.assertEqual(chats.carrying_archive(records, {"c1": True}), records)


class _Url:
    """A request's URL, as far as a chat route reads one."""

    def __init__(self, path: str) -> None:
        self.path = path
        self.query: Dict[str, Any] = {}

    def __str__(self) -> str:
        return f"http://host{self.path}"


def ask(case, path: str, *, method: Optional[str] = None, match: Optional[Dict[str, str]] = None,
        body: Any = None, unreadable: bool = False) -> Dict[str, Any]:
    """One request through the plugin's own wiring, answered as the route answers it."""
    request = FakeWeb.Request()
    request.headers = {}
    request.match_info = dict(match or {})
    request.query = {}
    request.content_length = None
    request.path = path
    request.url = _Url(path)

    async def read() -> Any:
        if unreadable:
            raise ValueError("Expecting value: line 1 column 1 (char 0)")
        return body

    async def text() -> str:
        return "{not json" if unreadable else ("" if body is None else json.dumps(body))

    request.json = read
    request.text = text
    app = wire(case, RouteAdapter())
    return asyncio.run(route(app, path, method)(request))


class TheArchiveRoute(TempHome):
    """`POST /chats/{id}/archived`: Hermes's flag, the chat's own record, and one honest answer."""

    def seed(self, session_id: Optional[str] = "gots-1", **value: Any) -> Dict[str, Dict[str, Any]]:
        record = {"title": "A chat", "pinned": True, "pinnedAt": 7, **(value or {})}
        if session_id:
            record["hermesSessionId"] = session_id
        return chats.merge(db_path(self.home), {"c1": {"at": 5, "value": record}})

    def archived(self, match: Optional[Dict[str, str]] = None, **body: Any) -> Dict[str, Any]:
        return ask(
            self, ARCHIVE_PATH, method="POST", match=match or {"chat_id": "c1"}, body=body
        )

    def test_the_route_writes_the_flag_and_the_chats_own_record(self) -> None:
        path = store(self.home, chain("gots-1"))
        self.seed()
        answer = self.archived(archived=True)
        self.assertEqual(answer["status"], 200)
        self.assertEqual(
            answer["payload"],
            {"object": "gots.chat.archived", "archived": True, "host": True},
        )
        self.assertEqual(held(path, "gots-1"), 1, "Hermes's own flag, which every surface reads")
        record = chats.one(db_path(self.home), "c1")
        self.assertEqual(record["value"]["archived"], True, "and the row every device merges")
        self.assertEqual(record["value"]["title"], "A chat", "the rest of the chat is kept")

    def test_unarchiving_writes_both_back(self) -> None:
        path = store(self.home, chain("gots-1"))
        self.seed(archived=True)
        answer = self.archived(archived=False)
        self.assertEqual(answer["payload"]["archived"], False)
        self.assertEqual(held(path, "gots-1"), 0)
        self.assertNotIn(
            "archived",
            chats.one(db_path(self.home), "c1")["value"],
            "an unset flag is the key dropped, as the app spells it",
        )

    def test_a_store_without_the_column_answers_that_the_host_took_no_flag(self) -> None:
        store(self.home, chain("gots-1"), archived=False)
        self.seed()
        answer = self.archived(archived=True)
        self.assertEqual(answer["status"], 200)
        self.assertEqual(answer["payload"]["host"], False, "the app keeps its own mark")
        self.assertEqual(
            chats.one(db_path(self.home), "c1")["value"]["archived"],
            True,
            "and the chat is still archived on every device",
        )

    def test_a_home_with_no_store_answers_the_same_way(self) -> None:
        self.seed()
        self.assertEqual(self.archived(archived=True)["payload"]["host"], False)

    def test_a_chat_with_no_session_is_a_404(self) -> None:
        self.seed(session_id=None)
        answer = self.archived(archived=True)
        self.assertEqual(answer["status"], 404)
        self.assertNotIn("archived", chats.one(db_path(self.home), "c1")["value"])

    def test_a_chat_that_is_not_there_is_a_404(self) -> None:
        self.assertEqual(self.archived(match={"chat_id": "gone"}, archived=True)["status"], 404)

    def test_a_body_that_is_not_a_bool_is_a_400(self) -> None:
        self.seed()
        for body in ({"archived": "yes"}, {"archived": 1}, {}, {"archived": None}):
            with self.subTest(body=body):
                self.assertEqual(self.archived(**body)["status"], 400, f"{body} is no flag")
        self.assertEqual(ask(self, ARCHIVE_PATH, method="POST",
                             match={"chat_id": "c1"}, unreadable=True)["status"], 400)

    def test_an_archive_made_through_the_tip_reaches_the_rows_own_session(self) -> None:
        # What Hermes itself does when a session is archived from the Dashboard: the lineage flips
        # from the tip, and the chat's own (first) session takes the flag with it — which is the id
        # the chat record names.
        store(self.home, chain("gots-1", "gots-tip"))
        self.seed()
        sessions.set_archived(self.home, "gots-tip", True)
        with mock.patch.object(rooms, "chat_records", return_value={}):
            listed = ask(self, plugin.PREFIX + "/chats")["payload"]["chats"]
        self.assertEqual(listed["c1"]["value"]["archived"], True)

    def test_a_list_answer_reflects_a_session_archived_in_the_store(self) -> None:
        path = store(self.home, chain("gots-1", "gots-tip"))
        self.seed()
        # A Host with no rooms: what this case reads is the chats beside its projection (ADR 0116).
        with mock.patch.object(rooms, "chat_records", return_value={}):
            self.assertEqual(
                ask(self, plugin.PREFIX + "/chats")["payload"]["chats"]["c1"]["value"].get("archived"),
                None,
                "a row nothing archived is not archived",
            )
            sessions.set_archived(self.home, "gots-1", True)
            self.assertEqual(held(path, "gots-tip"), 1)
            self.assertEqual(
                ask(self, plugin.PREFIX + "/chats")["payload"]["chats"]["c1"]["value"]["archived"],
                True,
                "an archive made on the Dashboard hides the row here (ADR 0159)",
            )
            sessions.set_archived(self.home, "gots-1", False)
            self.assertNotIn(
                "archived",
                ask(self, plugin.PREFIX + "/chats")["payload"]["chats"]["c1"]["value"],
                "and unarchiving there brings it back",
            )


if __name__ == "__main__":
    unittest.main()
