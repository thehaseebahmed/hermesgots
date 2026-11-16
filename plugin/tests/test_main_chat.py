"""A bot's Main is the profile's own Bot Chat, published as one record of its chat list.

Main is the conversation Hermes Bot Mode keeps for a profile and the Hermes Desktop shows as the
bot's own chat, so it is Hermes's — the plugin resolves it out of the profile's ``state.db``
(``sessions.bot_chat``), never retitles or invents one, and lays exactly one record flagged ``main``
over the list answer both doors pass (``chats.carrying_main``). Where a host has no such chat the
gateway is asked to mint one, the way the Desktop's own roster does; where it cannot be asked, Main
is a Gots chat of the bot's own, minted once into this store and derived from the bot so a wiped
store mints the same one again. A host that names one later takes the flag with it, leaving the old
record as a side chat with everything it had.

A Bot Chat archived on the Dashboard is a retired Main, never an archived one: the projection strips
the archive from the record it flags, and the archive route refuses a record carrying ``main``.

Run: python3 -m unittest plugin.tests.test_main_chat -v
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from types import ModuleType, SimpleNamespace
from typing import Any, Dict, Iterable, List, Optional
from unittest import mock

import plugin
from plugin import chats, rooms, sessions
from plugin.store import db_path
from plugin.tests._helpers import FakeWeb, RouteAdapter, route, temp_hermes_home, wire

BOT_CHAT = "Bot Chat"
MAIN = "main"
LIST = plugin.PREFIX + "/chats"
ARCHIVE_PATH = plugin.PREFIX + "/chats/{chat_id}/archived"


def store(
    home: Path, rows: Iterable[Dict[str, Any]], *, archived: bool = True, hidden: bool = True
) -> Path:
    """A Hermes ``state.db`` holding these sessions.

    ``archived`` and ``hidden`` off build a schema from before those columns, which the read of the
    canonical chat has to answer through rather than fail on.
    """
    home.mkdir(parents=True, exist_ok=True)
    path = home / "state.db"
    columns = (
        "id TEXT PRIMARY KEY, title TEXT, started_at REAL NOT NULL DEFAULT 0,"
        " parent_session_id TEXT, end_reason TEXT, model_config TEXT, source TEXT"
    )
    if archived:
        columns += ", archived INTEGER NOT NULL DEFAULT 0"
    if hidden:
        columns += ", hidden INTEGER NOT NULL DEFAULT 0"
    with closing(sqlite3.connect(path)) as conn:
        conn.execute(f"CREATE TABLE sessions ({columns})")
        for row in rows:
            conn.execute(
                f"INSERT INTO sessions ({', '.join(row)}) VALUES ({', '.join('?' for _ in row)})",
                tuple(row.values()),
            )
        conn.commit()
    return path


def bot_chat_row(session_id: str = "bot-1", **fields: Any) -> Dict[str, Any]:
    """The row Hermes keeps for a profile's canonical Bot Chat: titled so, hidden, unarchived."""
    return {
        "id": session_id,
        "title": BOT_CHAT,
        "started_at": 1_700_000_000.0,
        "hidden": 1,
        "archived": 0,
        **fields,
    }


def rows(path: Path) -> List[Dict[str, Any]]:
    """Every row of a ``state.db`` as it stands now, so a case can prove what a read left alone."""
    with closing(sqlite3.connect(path)) as conn:
        conn.row_factory = sqlite3.Row
        return [dict(row) for row in conn.execute("SELECT * FROM sessions ORDER BY id")]


def record(**value: Any) -> Dict[str, Any]:
    """One chat-list record, clock and value."""
    return {"at": 5, "value": value}


class Principal:
    """Hermes's own ``gateway.session_contract.Principal``, as the mint is handed one."""

    def __init__(self, subject: str, profile_id: str, capabilities: Any, transport_id: str) -> None:
        self.subject = subject
        self.profile_id = profile_id
        self.capabilities = capabilities
        self.transport_id = transport_id


class Authority:
    """The session authority a mint reaches: the profile it serves, and what its mint does.

    ``refused`` is a host that will not mint (an owner draining, a session writer holding the chat),
    which is a capability answer and never an exception across the route.
    """

    def __init__(self, home: Path, *, refused: bool = False) -> None:
        self.profile_id = str(home)
        self.home = home
        self.refused = refused
        self.actors: List[Principal] = []

    def _require_admission_open(self) -> None:
        pass

    async def create(self, actor: Principal, *, displace: Any = None) -> Any:
        """Hermes's mint, which makes the chat its own title lookup found no row for."""
        self.actors.append(actor)
        if self.refused:
            raise RuntimeError("runtime_draining")
        return SimpleNamespace(session_id=inserted(self.home))


def inserted(home: Path) -> str:
    """Puts a canonical Bot Chat row in the store the way Hermes's own creation does."""
    path = home / "state.db"
    if not path.exists():
        store(home, [])
    with closing(sqlite3.connect(path)) as conn:
        count = conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
        session_id = f"bot-{count + 1}"
        conn.execute(
            "INSERT INTO sessions (id, title, started_at, hidden, archived) VALUES (?, ?, ?, 1, 0)",
            (session_id, BOT_CHAT, 1_700_000_100.0),
        )
        conn.commit()
    return session_id


def host(case: unittest.TestCase, authority: Optional[Authority], *, older: bool = False) -> None:
    """The gateway modules a mint imports, planted for the case.

    ``authority`` None is a home this process serves no authority for; ``older`` is a Hermes from
    before the call this plugin makes existed at all.
    """
    gateways = ModuleType("gateway")
    authorities = ModuleType("gateway.session_authorities")
    authorities.authority_for_home = lambda runner, home: authority
    contract = ModuleType("gateway.session_contract")
    contract.Principal = Principal
    workers = ModuleType("gateway.session_runtime_workers")
    # The owner runs the write; a stub returns it to be awaited as it stands.
    workers.track_mutation = lambda given, operation: operation
    gateways.session_authorities = authorities
    gateways.session_contract = contract
    gateways.session_runtime_workers = workers
    planted = {
        "gateway": gateways,
        "gateway.session_authorities": authorities,
        "gateway.session_contract": contract,
        "gateway.session_runtime_workers": workers,
    }
    if not older:
        bot = ModuleType("gateway.session_bot")

        async def _create_bot_chat(given: Any, actor: Any, *, displace: Any = None) -> Any:
            return await given.create(actor, displace=displace)

        bot._create_bot_chat = _create_bot_chat
        gateways.session_bot = bot
        planted["gateway.session_bot"] = bot
    patcher = mock.patch.dict(sys.modules, planted)
    patcher.start()
    case.addCleanup(patcher.stop)


class HostAdapter(RouteAdapter):
    """The API server as far as a mint reaches it: the gateway runner it was wired to."""

    def __init__(self, runner: Any = None) -> None:
        super().__init__()
        if runner is not None:
            self.gateway_runner = runner


class _Url:
    """A request's URL, as far as a chat route reads one."""

    def __init__(self, path: str) -> None:
        self.path = path
        self.query: Dict[str, Any] = {}

    def __str__(self) -> str:
        return f"http://host{self.path}"


def ask(
    case: unittest.TestCase,
    path: str,
    *,
    method: Optional[str] = None,
    match: Optional[Dict[str, str]] = None,
    body: Any = None,
    adapter: Any = None,
) -> Dict[str, Any]:
    """One request through the plugin's own wiring, answered as the route answers it."""
    request = FakeWeb.Request()
    request.headers = {}
    request.match_info = dict(match or {})
    request.query = {}
    request.content_length = None
    request.path = path
    request.url = _Url(path)

    async def read() -> Any:
        return body

    async def text() -> str:
        return "" if body is None else json.dumps(body)

    request.json = read
    request.text = text
    app = wire(case, adapter if adapter is not None else HostAdapter(object()))
    with mock.patch.object(rooms, "chat_records", return_value={}):
        return asyncio.run(route(app, path, method)(request))


class TempHome(unittest.TestCase):
    def setUp(self) -> None:
        self.home = temp_hermes_home(self)

    def listed(self, adapter: Any = None) -> Dict[str, Dict[str, Any]]:
        answer = ask(self, LIST, adapter=adapter)
        self.assertEqual(answer["status"], 200)
        return answer["payload"]["chats"]

    def seed(self, **value: Any) -> Dict[str, Dict[str, Any]]:
        return chats.merge(db_path(self.home), value)


class TheHostsBotChat(TempHome):
    """`sessions.bot_chat`: the unarchived session titled "Bot Chat", read-only, or nothing."""

    def test_the_canonical_chat_is_the_unarchived_session_titled_so(self) -> None:
        store(self.home, [bot_chat_row()])
        found = sessions.bot_chat(self.home)
        self.assertEqual(found["id"], "bot-1")
        self.assertTrue(found["hidden"], "Hermes holds its own canonical chat hidden")
        self.assertEqual(found["at"], 1_700_000_000_000, "when the chat began, in the app's millis")

    def test_an_archived_bot_chat_is_a_retired_one_and_not_a_main(self) -> None:
        # Archived on the Dashboard: Hermes lists it nowhere, and the reader has put it away.
        store(self.home, [bot_chat_row(archived=1)])
        self.assertIsNone(sessions.bot_chat(self.home))

    def test_a_store_from_before_those_columns_still_answers(self) -> None:
        store(
            self.home,
            [{"id": "bot-1", "title": BOT_CHAT, "started_at": 1_700_000_000.0}],
            archived=False,
            hidden=False,
        )
        self.assertEqual(sessions.bot_chat(self.home), {"id": "bot-1", "hidden": False, "at": 1_700_000_000_000})

    def test_a_row_titled_anything_else_is_no_bot_chat(self) -> None:
        store(self.home, [bot_chat_row(title="A chat")])
        self.assertIsNone(sessions.bot_chat(self.home))

    def test_no_store_is_no_bot_chat_and_plants_none(self) -> None:
        self.assertIsNone(sessions.bot_chat(self.home))
        self.assertFalse((self.home / "state.db").exists(), "a read never makes a store")

    def test_a_store_with_no_sessions_table_answers_nothing(self) -> None:
        with closing(sqlite3.connect(self.home / "state.db")) as conn:
            conn.execute("CREATE TABLE something_else (id TEXT)")
            conn.commit()
        self.assertIsNone(sessions.bot_chat(self.home))


class Minting(TempHome):
    """`sessions.mint_bot_chat`: the gateway's own creation, asked and never written here."""

    def mint(self, adapter: Any) -> Optional[str]:
        with mock.patch.object(sessions, "adapter", adapter):
            return asyncio.run(sessions.mint_bot_chat(self.home))

    def test_a_host_that_can_mint_answers_its_new_sessions_id(self) -> None:
        store(self.home, [])
        authority = Authority(self.home)
        host(self, authority)
        minted = self.mint(HostAdapter(object()))
        self.assertEqual(minted, "bot-1", "the row the gateway's own creation wrote")
        self.assertEqual([row["title"] for row in rows(self.home / "state.db")], [BOT_CHAT])
        self.assertEqual(
            authority.actors[0].capabilities,
            frozenset({"session:create", "session:read", "session:submit"}),
            "creation is the actor's own capability, as the Desktop's roster is granted it",
        )

    def test_a_host_that_will_not_mint_is_a_capability_answer_and_not_an_exception(self) -> None:
        store(self.home, [])
        host(self, Authority(self.home, refused=True))
        self.assertIsNone(self.mint(HostAdapter(object())))

    def test_a_hermes_with_no_such_call_is_a_capability_answer_too(self) -> None:
        store(self.home, [])
        host(self, Authority(self.home), older=True)
        self.assertIsNone(self.mint(HostAdapter(object())))
        self.assertEqual(rows(self.home / "state.db"), [], "nothing was minted by this plugin")

    def test_a_profile_this_process_serves_no_authority_for_cannot_be_asked(self) -> None:
        store(self.home, [])
        host(self, None)
        self.assertIsNone(self.mint(HostAdapter(object())))

    def test_a_plugin_wired_nowhere_cannot_be_asked(self) -> None:
        store(self.home, [])
        self.assertIsNone(self.mint(None), "no API server, no gateway runner, no mint")
        self.assertIsNone(self.mint(RouteAdapter()), "an adapter with no gateway runner")


class CarryingMain(unittest.TestCase):
    """`chats.carrying_main`: exactly one Main laid over a list answer, shaped like the archive's."""

    def session(self, session_id: str = "bot-1", at: int = 1_700_000_000_000) -> Dict[str, Any]:
        return {"id": session_id, "hidden": True, "at": at}

    def test_a_record_already_bound_to_the_session_is_the_one_flagged(self) -> None:
        records = {"device-chat": record(hermesSessionId="bot-1", title="My chat", createdAt=1)}
        laid = chats.carrying_main(records, self.session())
        self.assertEqual(
            laid["device-chat"]["value"],
            {"hermesSessionId": "bot-1", "title": "My chat", "createdAt": 1, MAIN: True},
            "the record a device made keeps its id and everything it carries",
        )
        self.assertNotIn("bot-1", laid, "and no second record is minted for the same session")

    def test_a_session_with_no_record_is_minted_under_its_own_id(self) -> None:
        laid = chats.carrying_main({"a": record(title="A")}, self.session())
        self.assertEqual(
            laid["bot-1"],
            {
                "at": 1_700_000_000_000,
                "value": {
                    "title": BOT_CHAT,
                    "hermesSessionId": "bot-1",
                    "createdAt": 1_700_000_000_000,
                    "updatedAt": 1_700_000_000_000,
                    MAIN: True,
                },
            },
        )
        self.assertEqual(laid["a"], record(title="A"), "every other record stands as it was")

    def test_a_second_answer_mints_the_very_same_record(self) -> None:
        once = chats.carrying_main({"a": record(title="A")}, self.session())
        twice = chats.carrying_main({"a": record(title="A")}, self.session())
        self.assertEqual(once, twice, "a projection, so asking again mints the same one")

    def test_every_other_record_carrying_the_flag_loses_it_and_keeps_the_rest(self) -> None:
        records = {
            "bot-1": record(hermesSessionId="bot-1", title="Bot Chat"),
            "main-old": record(hermesSessionId="memento-main-x", title="Main", pinned=True, createdAt=9),
        }
        laid = chats.carrying_main(records, self.session())
        self.assertNotIn(MAIN, laid["main-old"]["value"])
        self.assertEqual(
            laid["main-old"]["value"],
            {"hermesSessionId": "memento-main-x", "title": "Main", "pinned": True, "createdAt": 9},
            "an older Main stays a chat of the reader's, with everything it had",
        )
        self.assertEqual(
            [chat_id for chat_id, held in laid.items() if held["value"].get(MAIN)], ["bot-1"]
        )

    def test_the_record_it_flags_carries_no_archive(self) -> None:
        # A Bot Chat archived on the Dashboard is a retired Main: G2 forbids an archived Main, and
        # the app reads one flag, so the archive is dropped from the record Main is.
        records = {"bot-1": record(hermesSessionId="bot-1", title=BOT_CHAT, archived=True, pinnedAt=2)}
        laid = chats.carrying_main(records, self.session())
        self.assertEqual(laid["bot-1"]["value"], {"hermesSessionId": "bot-1", "title": BOT_CHAT, "pinnedAt": 2, MAIN: True})

    def test_a_room_and_a_tombstone_are_left_alone(self) -> None:
        records = {
            "room-1": record(**{chats.ROOM_MARKS: {"pinned": False}}),
            "gone": {"at": 5, "deleted": True},
        }
        self.assertEqual(chats.carrying_main(records, self.session())["room-1"], records["room-1"])
        self.assertEqual(chats.carrying_main(records, self.session())["gone"], records["gone"])

    def test_no_session_lays_nothing(self) -> None:
        records = {"main-old": record(title="Main", **{MAIN: True})}
        self.assertEqual(
            chats.carrying_main(records, None),
            records,
            "with no session to bind there is no Main to publish, and no flag is taken away",
        )


class TheBotsOwnMain(unittest.TestCase):
    """`chats.own_main`: a Gots chat of the bot's own, for a host that cannot be asked."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = db_path(Path(self.tmp.name))

    def test_it_mints_a_record_the_store_keeps(self) -> None:
        made = chats.own_main({}, self.path, 1_700_000_000_000)
        self.assertTrue(made["id"].startswith("gots-"), "a Gots session, which every reader knows")
        self.assertEqual(made["at"], 1_700_000_000_000, "minted at the clock it was asked for")
        held = chats.read(self.path)
        self.assertEqual(list(held), [made["id"]], "and it is this store's record")
        self.assertEqual(held[made["id"]]["value"][MAIN], True)
        self.assertEqual(held[made["id"]]["value"]["hermesSessionId"], made["id"])
        self.assertEqual(held[made["id"]]["at"], made["at"])

    def test_a_second_answer_finds_it_and_writes_nothing(self) -> None:
        made = chats.own_main({}, self.path, 1_700_000_000_000)
        before = chats.read(self.path)
        again = chats.own_main(before, self.path, 1_800_000_000_000)
        self.assertEqual(again, made, "the clock it was minted at, not the one it is asked at")
        self.assertEqual(chats.read(self.path), before)

    def test_two_bots_never_share_the_record(self) -> None:
        one = chats.own_main({}, db_path(Path(self.tmp.name) / "one"), 7)
        two = chats.own_main({}, db_path(Path(self.tmp.name) / "two"), 7)
        self.assertNotEqual(one["id"], two["id"], "the id is derived from the bot, not from the clock")


class TheListAnswer(TempHome):
    """The one door both list answers pass: exactly one Main per bot, whatever the host says."""

    def flagged(self, listed: Dict[str, Dict[str, Any]]) -> List[str]:
        return [chat_id for chat_id, held in listed.items() if (held.get("value") or {}).get(MAIN)]

    def test_the_bots_main_is_the_hosts_bot_chat_and_it_is_the_only_record_flagged(self) -> None:
        store(self.home, [bot_chat_row()])
        self.seed(
            **{
                "a-chat": {"at": 4, "value": {"title": "A chat", "hermesSessionId": "gots-a"}},
                "main-old": {
                    "at": 3,
                    "value": {"title": "Main", "hermesSessionId": "memento-main-x", MAIN: True},
                },
            }
        )
        listed = self.listed()
        self.assertEqual(self.flagged(listed), ["bot-1"])
        self.assertEqual(
            listed["bot-1"]["value"],
            {
                "title": BOT_CHAT,
                "hermesSessionId": "bot-1",
                "createdAt": 1_700_000_000_000,
                "updatedAt": 1_700_000_000_000,
                MAIN: True,
            },
        )
        self.assertEqual(
            listed["main-old"]["value"],
            {"title": "Main", "hermesSessionId": "memento-main-x"},
            "an older Main keeps its history as an ordinary side chat",
        )
        self.assertEqual(listed["a-chat"]["value"]["title"], "A chat")

    def test_a_host_with_no_bot_chat_is_asked_once_and_the_mint_bound(self) -> None:
        store(self.home, [])
        authority = Authority(self.home)
        host(self, authority)
        listed = self.listed(HostAdapter(object()))
        self.assertEqual(self.flagged(listed), ["bot-1"], "the chat the gateway minted is Main")
        self.assertEqual(len(authority.actors), 1, "the mint is the gateway's own creation")
        self.listed(HostAdapter(object()))
        self.assertEqual(len(authority.actors), 1, "and a host that has one now is never asked again")

    def test_a_title_another_surface_holds_is_deferred_to_and_never_overwritten(self) -> None:
        # A conversation the gateway can never own holding the canonical title: Hermes's own mint
        # answers nothing rather than displacing it, so the chat it named is Main and nothing moved.
        store(self.home, [{"id": "api-1", "title": BOT_CHAT, "started_at": 1_700_000_500.0, "hidden": 0, "archived": 0}])
        authority = Authority(self.home)
        host(self, authority)
        listed = self.listed(HostAdapter(object()))
        self.assertEqual(self.flagged(listed), ["api-1"])
        self.assertEqual(authority.actors, [], "nothing is minted over a title another surface holds")
        self.assertEqual(
            [(row["id"], row["title"], row["hidden"], row["archived"]) for row in rows(self.home / "state.db")],
            [("api-1", BOT_CHAT, 0, 0)],
            "and its own row is exactly as it was: not retitled, not displaced, nothing added",
        )

    def test_a_host_that_cannot_mint_is_answered_with_a_gots_chat_of_its_own(self) -> None:
        self.seed(**{"a-chat": {"at": 4, "value": {"title": "A chat", "hermesSessionId": "gots-a"}}})
        listed = self.listed(HostAdapter())
        main = self.flagged(listed)[0]
        self.assertEqual(main, listed[main]["value"]["hermesSessionId"], "keyed by the session Main is")
        self.assertTrue(main.startswith("gots-"), "a Gots chat, so every reader already knows it for one")
        self.assertEqual(listed[main]["value"]["title"], BOT_CHAT)
        self.assertGreater(listed[main]["at"], 0, "a real clock, so the row is dated by when it began")
        again = self.listed(HostAdapter())
        self.assertEqual(self.flagged(again), [main], "and the bot is not given a second Main")
        self.assertEqual(again, listed, "a second answer says the same thing")

    def test_a_host_that_later_names_a_bot_chat_rebinds_and_the_old_record_stays(self) -> None:
        self.seed(**{"a-chat": {"at": 4, "value": {"title": "A chat", "hermesSessionId": "gots-a"}}})
        first = self.flagged(self.listed(HostAdapter()))[0]
        self.assertTrue(first.startswith("gots-"))
        store(self.home, [bot_chat_row()])
        host(self, Authority(self.home))
        listed = self.listed(HostAdapter(object()))
        self.assertEqual(self.flagged(listed), ["bot-1"], "Main is the host's chat now")
        self.assertIn(first, listed, "the conversation it was is still a chat of this bot's")
        self.assertNotIn(MAIN, listed[first]["value"])
        self.assertEqual(
            listed[first]["value"]["hermesSessionId"],
            first,
            "and keeps the session its history is in",
        )
        self.assertEqual(listed[first]["value"]["title"], BOT_CHAT)

    def test_a_bot_chat_archived_on_the_dashboard_retires_main_rather_than_archiving_it(self) -> None:
        store(self.home, [bot_chat_row(archived=1)])
        self.seed(
            **{"archived-one": {"at": 3, "value": {"title": BOT_CHAT, "hermesSessionId": "bot-1", MAIN: True}}}
        )
        authority = Authority(self.home, refused=True)
        host(self, authority)
        listed = self.listed(HostAdapter(object()))
        main = self.flagged(listed)[0]
        self.assertNotEqual(main, "archived-one", "a retired Bot Chat is nobody's Main")
        self.assertNotIn("archived", listed[main]["value"], "and Main is never an archived chat")
        self.assertEqual(listed["archived-one"]["value"]["archived"], True, "the reader put it away")
        self.assertNotIn(MAIN, listed["archived-one"]["value"])

    def test_a_second_answer_writes_nothing_new(self) -> None:
        store(self.home, [bot_chat_row()])
        self.seed(**{"a-chat": {"at": 4, "value": {"title": "A chat", "hermesSessionId": "gots-a"}}})
        before = chats.read(db_path(self.home))
        first = self.listed(HostAdapter(object()))
        self.assertEqual(chats.read(db_path(self.home)), before, "a read of the list stores nothing")
        self.assertEqual(self.listed(HostAdapter(object())), first)


class TheArchiveRoute(TempHome):
    """Main is never offered an archive, and a device that asks anyway is refused."""

    def test_the_route_refuses_a_record_carrying_main(self) -> None:
        store(self.home, [bot_chat_row()])
        self.seed(**{"bot-1": {"at": 5, "value": {"title": BOT_CHAT, "hermesSessionId": "bot-1", MAIN: True}}})
        answer = ask(
            self, ARCHIVE_PATH, method="POST", match={"chat_id": "bot-1"}, body={"archived": True}
        )
        self.assertEqual(answer["status"], 409)
        self.assertEqual(
            chats.one(db_path(self.home), "bot-1")["value"],
            {"title": BOT_CHAT, "hermesSessionId": "bot-1", MAIN: True},
            "and its own record is untouched",
        )
        self.assertEqual(rows(self.home / "state.db")[0]["archived"], 0, "and so is the host's row")

    def test_a_chat_that_is_not_main_archives_as_it_did(self) -> None:
        store(self.home, [bot_chat_row(), {"id": "gots-a", "title": "A chat", "started_at": 1_700_000_400.0, "hidden": 0, "archived": 0}])
        self.seed(**{"a-chat": {"at": 5, "value": {"title": "A chat", "hermesSessionId": "gots-a"}}})
        answer = ask(
            self, ARCHIVE_PATH, method="POST", match={"chat_id": "a-chat"}, body={"archived": True}
        )
        self.assertEqual(answer["status"], 200)
        self.assertEqual(answer["payload"]["host"], True)


if __name__ == "__main__":
    unittest.main()
