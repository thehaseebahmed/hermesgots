"""The plugin's one way onto the Host's rooms, and the `rooms` row it earns (ADR 0117).

Rooms are the Host's own hosted rooms, behind its gateway's JSON-RPC surface — `groups.*` — which the
API server the app talks to doesn't serve at all. The seam asks the Host's own dispatcher in process
first, because this plugin runs in the same process as the gateway; when that import or call doesn't
answer, it falls back to the Host's gateway client over its loopback control socket. A Host that
answers neither, or whose room driver isn't running, is not advertised at all: a room accepted there
would be accepted and never answered, which reads to the user as a bot that ignored them.

The live half — a real gateway listing `rooms`, and a room made in the desktop appearing in the
plugin's room list — is a checklist item on the pull request, because a fake here can only prove the
seam.

Run: python3 -m unittest plugin.tests.test_rooms -v
"""

from __future__ import annotations

import asyncio
import contextlib
import sys
import time
import unittest
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest import mock

import plugin
from plugin import chats, rooms, store
from plugin.tests._helpers import (
    FakeWeb,
    RouteAdapter,
    js_constant,
    route,
    temp_hermes_home,
    wire,
)


class LoopbackRefusal(ValueError):
    """The Host's `GatewayRPCError`: a received refusal, carrying its bounded reason and code."""

    def __init__(self, message, code=None, data=None):
        super().__init__(message)
        self.code = code
        self.data = data or {}


class Refused(LoopbackRefusal):
    """A refusal the fake Host sends as an error frame."""

    def __init__(self, message, code, reason=None):
        super().__init__(message, code, {"reason": reason} if reason else {})


class Host:
    def __init__(
        self,
        listed=(),
        driver=True,
        methods=None,
        refuse=None,
        inline=False,
        page_size=None,
        code=4123,
        reason=None,
        stuck=False,
        delay=0.0,
    ):
        self.listed = [dict(room) for room in listed]
        self.driver = driver
        self.methods = list(rooms.NEEDED if methods is None else methods)
        self.refuse = refuse
        self.inline = inline
        self.page_size = page_size
        self.code = code
        self.reason = reason
        self.stuck = stuck
        self.delay = delay
        self.requests = []

    def answer(self, method, params=None):
        if method == "groups.capabilities":
            return {"protocol_version": 1, "driver": self.driver, "methods": self.methods}
        if method == "groups.list":
            return self.page(params)
        if method == "groups.create":
            return self.create(params)
        if method == "groups.rename":
            return self.rename(params)
        if method == "groups.disband":
            return self.disband(params)
        raise AssertionError(f"the seam asked for {method}")

    def room(self, room_id):
        return next((room for room in self.listed if room["room_id"] == room_id), None)

    def page(self, params):
        params = params or {}
        if not self.page_size:
            return {"rooms": self.listed, "next_offset": None}
        offset = int(params.get("offset") or 0)
        page = self.listed[offset : offset + self.page_size]
        if self.stuck:
            return {"rooms": page, "next_offset": 1}
        next_offset = offset + self.page_size if len(page) == self.page_size else None
        return {"rooms": page, "next_offset": next_offset}

    def create(self, params):
        """Create one room, validating the roster the way the Host's own discussion rules do."""
        members = params.get("members")
        if not isinstance(members, list) or not 2 <= len(members) <= 6:
            raise Refused("members must contain between 2 and 6 entries", 4110)
        handles = {"all", "everyone"}
        for member in members:
            handle = str(member.get("handle") or "").casefold()
            if handle in handles:
                raise Refused(
                    "member handles must be unique and cannot reserve @all or @everyone", 4110
                )
            handles.add(handle)
        existing = self.room(params.get("room_id"))
        if existing is not None:
            if existing["name"] != params.get("name") or existing["members"] != members:
                raise Refused("room_id already holds a room with other content", 4110)
            return {"room": dict(existing, idempotent=True)}
        room = {
            "room_id": params.get("room_id"),
            "name": params.get("name"),
            "members": members,
            "created_at": 1000.0,
            "updated_at": 1000.0,
        }
        self.listed.append(room)
        return {"room": dict(room)}

    def rename(self, params):
        room = self.room(params.get("room_id"))
        if room is None or room.get("disbanded_at") is not None:
            raise Refused("hosted room not found", 4117)
        room["name"] = params.get("name")
        room["updated_at"] = 2000.0
        return {"room": dict(room)}

    def disband(self, params):
        room = self.room(params.get("room_id"))
        if room is None:
            raise Refused("hosted room not found", 4113)
        room["disbanded_at"] = 3000.0
        room["updated_at"] = 3000.0
        return {"tombstone": {"room_id": params.get("room_id"), "disbanded_at": 3000.0}}

    def dispatch(self, request, transport=None):
        """Answer one request the way the Host does: straight back, or from its pool through the
        transport the request was bound to (every `groups.*` method is a long handler)."""
        self.requests.append(request)
        if self.delay:
            time.sleep(self.delay)
        try:
            if self.refuse == request["method"]:
                raise Refused("Group Chat worker is unavailable.", self.code, self.reason)
            result = self.answer(request["method"], request.get("params"))
        except Refused as refusal:
            frame = {
                "jsonrpc": "2.0",
                "id": request["id"],
                "error": {"code": refusal.code, "message": str(refusal), "data": refusal.data},
            }
        else:
            frame = {"jsonrpc": "2.0", "id": request["id"], "result": result}
        if self.inline:
            return frame
        # The Host's own events ride the same transport while a handler runs.
        transport.write({"jsonrpc": "2.0", "method": "event", "params": {}})
        transport.write(frame)
        return None


class Unfindable:
    """A Host whose owner can't be discovered at all: the runtime's own lookup raises."""

    def discover(self, home, timeout=None):
        raise RuntimeError("the control socket is not a socket")

    def attachable(self, found):
        raise AssertionError("a home that couldn't be found was called attachable")

    @contextlib.asynccontextmanager
    async def connect(self, endpoint):
        raise AssertionError("the seam dialled a home it couldn't find")
        yield  # pragma: no cover - an async context manager, unreachable


class Loopback:
    """The Host's gateway client, dialled over its loopback control socket."""

    def __init__(self, host):
        self.host = host
        self.homes = []
        self.methods = []
        self.endpoints = []

    def discover(self, home, timeout=None):
        self.homes.append(home)
        return SimpleNamespace(state="ready", endpoint="endpoint", reason_code=None, detail=None)

    def attachable(self, found):
        return found.endpoint is not None

    @contextlib.asynccontextmanager
    async def connect(self, endpoint):
        self.endpoints.append(endpoint)
        yield SimpleNamespace(rpc=self.rpc)

    async def rpc(self, method, _timeout=None, **params):
        self.methods.append(method)
        try:
            return self.host.answer(method, params)
        except Refused as refusal:
            raise LoopbackRefusal(str(refusal), refusal.code, refusal.data) from refusal


def package(name):
    """A planted package: only what the test puts inside it is importable."""
    module = ModuleType(name)
    module.__path__ = []
    return module


@contextlib.contextmanager
def planted(modules, absent=()):
    """Put these modules in place for one test, with `absent` names taken out for its length."""
    with mock.patch.dict(sys.modules, modules):
        for name in absent:
            sys.modules.pop(name, None)
        yield


@contextlib.contextmanager
def dispatcher(host):
    """A Host whose `tui_gateway.rpc_dispatch` is there to be imported and answers this host."""
    rpc = ModuleType("tui_gateway.rpc_dispatch")
    rpc.dispatch = host.dispatch
    with planted({"tui_gateway": package("tui_gateway"), "tui_gateway.rpc_dispatch": rpc}):
        yield host


@contextlib.contextmanager
def published(host):
    """A Host that publishes dispatch onto its server module, as the gateway does.

    The split module the plugin first reaches keeps its own copy, which the Host's rebound one
    replaces — a copy that can't run, because the names its body needs live on the server.
    """
    server = ModuleType("tui_gateway.server")
    server.dispatch = host.dispatch
    split = ModuleType("tui_gateway.rpc_dispatch")

    def dispatch(request, transport=None):
        raise AssertionError("the split module's own copy was called")

    split.dispatch = dispatch
    with planted({
        "tui_gateway": package("tui_gateway"),
        "tui_gateway.server": server,
        "tui_gateway.rpc_dispatch": split,
    }):
        yield host


@contextlib.contextmanager
def no_dispatcher():
    """A Host whose `tui_gateway` holds no `rpc_dispatch`: the import the seam tries first fails."""
    with planted({"tui_gateway": package("tui_gateway")}, absent=["tui_gateway.rpc_dispatch"]):
        yield


@contextlib.contextmanager
def no_loopback():
    """A Host with no gateway client at all: a test that isn't about the way out can't take it."""
    with planted(
        {"hermes_cli": package("hermes_cli")},
        absent=["hermes_cli.gateway_runtime", "hermes_cli.gateway_client"],
    ):
        yield


@contextlib.contextmanager
def loopback(client):
    """A Host with a gateway client to fall back to: the runtime that finds it, and the client."""
    runtime = ModuleType("hermes_cli.gateway_runtime")
    runtime.discover_gateway_endpoint = client.discover
    runtime.attachable = client.attachable
    gateway = ModuleType("hermes_cli.gateway_client")
    gateway.connect_gateway = client.connect
    gateway.GatewayRPCError = LoopbackRefusal
    with planted({
        "hermes_cli": package("hermes_cli"),
        "hermes_cli.gateway_runtime": runtime,
        "hermes_cli.gateway_client": gateway,
    }):
        yield client


class RoomsSeam(unittest.TestCase):
    def setUp(self):
        temp_hermes_home(self)

    def features(self):
        """`info`'s feature names, read through the route a device reads them through."""
        app = wire(self, RouteAdapter())
        request = FakeWeb.Request()
        request.match_info, request.headers = {}, {}
        answer = asyncio.run(route(app, plugin.PREFIX + "/info")(request))
        self.assertEqual(answer["status"], 200)
        return answer["payload"]["features"]

    def test_no_rooms_where_the_host_has_no_dispatcher_to_ask(self):
        with no_dispatcher(), no_loopback():
            self.assertNotIn("rooms", self.features())
            self.assertIsNotNone(rooms.available())

    def test_the_dispatcher_the_host_publishes_is_the_one_asked(self):
        host = Host(listed=[{"room_id": "r1", "name": "Planning"}])
        with published(host), no_loopback():
            self.assertIsNone(rooms.available())
            self.assertEqual(rooms.list_rooms()["rooms"], host.listed)
        self.assertTrue(host.requests, "the server's rebound dispatch answered, not the split module's")

    def test_capabilities_and_the_list_answer_through_the_hosts_dispatcher(self):
        host = Host(listed=[{"room_id": "r1", "name": "Planning"}])
        with dispatcher(host), loopback(Loopback(host)) as client:
            self.assertIsNone(rooms.available())
            self.assertIn("rooms", self.features())
            self.assertTrue(rooms.capabilities()["driver"])
            self.assertEqual(rooms.list_rooms()["rooms"], host.listed)
        self.assertEqual([one["method"] for one in host.requests], [
            "groups.capabilities",
            "groups.capabilities",
            "groups.capabilities",
            "groups.list",
        ])
        self.assertEqual(client.methods, [], "a dispatcher that answers needs no loopback client")

    def test_an_inline_answer_is_read_as_it_is(self):
        host = Host(listed=[{"room_id": "r1", "name": "Planning"}], inline=True)
        with dispatcher(host), no_loopback():
            self.assertEqual(rooms.list_rooms()["rooms"], host.listed)

    def test_an_inline_refusal_is_the_hosts_answer_too(self):
        host = Host(refuse="groups.list", inline=True)
        with dispatcher(host), loopback(Loopback(host)) as client:
            with self.assertRaises(rooms.HostRefusal) as caught:
                rooms.list_rooms()
        self.assertEqual(caught.exception.code, 4123)
        self.assertEqual(client.methods, [], "an inline refusal is an answer, so nothing is retried")

    def test_no_rooms_where_the_driver_is_not_running(self):
        host = Host(driver=False)
        with dispatcher(host), no_loopback():
            self.assertNotIn("rooms", self.features())
            self.assertIn("driver", rooms.available())

    def test_no_rooms_where_the_host_declares_no_room_list(self):
        host = Host(methods=["groups.capabilities"])
        with dispatcher(host), no_loopback():
            self.assertNotIn("rooms", self.features())
            self.assertIn("groups.list", rooms.available())

    def test_the_loopback_client_answers_where_the_dispatcher_cannot_be_imported(self):
        host = Host(listed=[{"room_id": "r1", "name": "Planning"}])
        with no_dispatcher(), loopback(Loopback(host)) as client:
            self.assertIsNone(rooms.available())
            self.assertIn("rooms", self.features())
            self.assertEqual(rooms.list_rooms()["rooms"], host.listed)
        self.assertEqual(client.methods, ["groups.capabilities", "groups.capabilities", "groups.list"])

    def test_the_home_the_caller_gives_is_the_one_discovered(self):
        host = Host()
        with no_dispatcher(), loopback(Loopback(host)) as client:
            rooms.capabilities(home="/profiles/other")
        self.assertEqual(client.homes, ["/profiles/other"], "a profile's own gateway is the one asked")

    def test_a_host_whose_gateway_cannot_be_found_leaves_no_rooms(self):
        with no_dispatcher(), loopback(Unfindable()):
            self.assertNotIn("rooms", self.features())
            with self.assertRaises(rooms.RoomError):
                rooms.capabilities()

    def test_a_call_from_inside_a_running_loop_is_refused_rather_than_deadlocked(self):
        host = Host()

        async def ask():
            return rooms.capabilities()

        with no_dispatcher(), loopback(Loopback(host)) as client:
            with self.assertRaises(rooms.RoomError):
                asyncio.run(ask())
        self.assertEqual(client.methods, [], "a loop in the caller's thread is refused, never dialled")

    def test_a_refusal_is_the_hosts_answer_not_a_broken_seam(self):
        host = Host(refuse="groups.list")
        with dispatcher(host), loopback(Loopback(host)) as client:
            with self.assertRaises(rooms.HostRefusal) as caught:
                rooms.list_rooms()
        self.assertEqual(caught.exception.code, 4123)
        self.assertIn("worker is unavailable", str(caught.exception))
        self.assertEqual(client.methods, [], "the Host read the request, so the loopback isn't tried")


def member(profile, handle=None, name=None):
    handle = handle or profile
    entry = {"member_id": f"m-{handle}", "profile": profile, "handle": handle}
    if name is not None:
        entry["display_name"] = name
    return entry


def post(body, **match_info):
    request = FakeWeb.Request()
    request.match_info = dict(match_info)
    request.headers = {}

    async def json():
        return body

    request.json = json
    return request


def get(**match_info):
    request = FakeWeb.Request()
    request.match_info = dict(match_info)
    request.headers = {}
    return request


class RoomsRoutes(unittest.TestCase):
    def setUp(self):
        self.home = temp_hermes_home(self)
        self.host = Host()
        self.adapter = RouteAdapter()
        self.app = wire(self, self.adapter)

    def create(self, body):
        handler = route(self.app, plugin.PREFIX + "/rooms", "POST")
        return asyncio.run(handler(post(body)))

    def rename(self, room_id, body):
        handler = route(self.app, plugin.PREFIX + "/rooms/{room_id}", "POST")
        return asyncio.run(handler(post(body, room_id=room_id)))

    def disband(self, room_id):
        handler = route(self.app, plugin.PREFIX + "/rooms/{room_id}/disband", "POST")
        return asyncio.run(handler(post({}, room_id=room_id)))

    def chats(self):
        handler = route(self.app, plugin.PREFIX + "/chats", "GET")
        answer = asyncio.run(handler(get()))
        self.assertEqual(answer["status"], 200)
        return answer["payload"]["chats"]

    def merge(self, asked):
        handler = route(self.app, plugin.PREFIX + "/chats", "POST")
        answer = asyncio.run(handler(post({"chats": asked})))
        self.assertEqual(answer["status"], 200)
        return answer["payload"]["chats"]

    def asked(self, method):
        return [one.get("params") for one in self.host.requests if one["method"] == method]

    def test_a_room_is_created_with_the_id_the_client_minted(self):
        members = [member("default"), member("gots", name="Gots")]
        with dispatcher(self.host), no_loopback():
            answer = self.create({"room_id": "r-new", "name": "Planning", "members": members})
        self.assertEqual(answer["status"], 200)
        self.assertEqual(answer["payload"]["object"], "gots.room")
        self.assertEqual(answer["payload"]["room"]["room_id"], "r-new")
        self.assertEqual(
            self.asked("groups.create"),
            [{"room_id": "r-new", "name": "Planning", "members": members}],
        )

    def test_a_retry_on_the_same_id_is_the_same_room(self):
        members = [member("default"), member("gots")]
        with dispatcher(self.host), no_loopback():
            self.create({"room_id": "r-new", "name": "Planning", "members": members})
            again = self.create({"room_id": "r-new", "name": "Planning", "members": members})
        self.assertEqual(again["status"], 200)
        self.assertEqual(len(self.host.listed), 1, "the id the app minted makes the retry idempotent")

    def test_a_room_without_the_id_its_app_minted_is_refused_here(self):
        with dispatcher(self.host), no_loopback():
            answer = self.create({"name": "Planning", "members": [member("default"), member("gots")]})
        self.assertEqual(answer["status"], 400)
        self.assertEqual(answer["payload"]["error"]["message"], "A room needs the id its app minted.")
        self.assertEqual(self.asked("groups.create"), [], "the Host is not asked without an id")

    def test_a_roster_under_two_is_refused_in_the_hosts_words(self):
        with dispatcher(self.host), no_loopback():
            answer = self.create({"room_id": "r-1", "name": "Planning", "members": [member("default")]})
        self.assertEqual(answer["status"], 400)
        self.assertEqual(
            answer["payload"]["error"]["message"], "members must contain between 2 and 6 entries"
        )
        self.assertEqual(answer["payload"]["error"]["code"], 4110)

    def test_a_roster_over_six_is_refused_in_the_hosts_words(self):
        members = [member(f"bot-{index}") for index in range(7)]
        with dispatcher(self.host), no_loopback():
            answer = self.create({"room_id": "r-1", "name": "Planning", "members": members})
        self.assertEqual(answer["status"], 400)
        self.assertEqual(
            answer["payload"]["error"]["message"], "members must contain between 2 and 6 entries"
        )

    def test_a_duplicate_handle_is_refused_in_the_hosts_words(self):
        members = [
            {"member_id": "m-1", "profile": "default", "handle": "gots"},
            {"member_id": "m-2", "profile": "gots", "handle": "gots"},
        ]
        with dispatcher(self.host), no_loopback():
            answer = self.create({"room_id": "r-1", "name": "Planning", "members": members})
        self.assertEqual(answer["status"], 400)
        self.assertEqual(
            answer["payload"]["error"]["message"],
            "member handles must be unique and cannot reserve @all or @everyone",
        )

    def test_a_handle_that_reserves_at_all_is_refused_in_the_hosts_words(self):
        members = [
            {"member_id": "m-1", "profile": "default", "handle": "all"},
            {"member_id": "m-2", "profile": "gots", "handle": "gots"},
        ]
        with dispatcher(self.host), no_loopback():
            answer = self.create({"room_id": "r-1", "name": "Planning", "members": members})
        self.assertEqual(answer["status"], 400)
        self.assertEqual(
            answer["payload"]["error"]["message"],
            "member handles must be unique and cannot reserve @all or @everyone",
        )

    def test_a_host_that_cannot_reach_its_rooms_says_so_instead_of_refusing(self):
        with no_dispatcher(), no_loopback():
            answer = self.create({"room_id": "r-1", "name": "Planning", "members": [member("default"), member("gots")]})
        self.assertEqual(answer["status"], 502)
        self.assertEqual(answer["payload"]["error"]["message"], "This host can't reach its rooms.")

    def test_a_rename_is_the_hosts_call_carrying_the_event_id(self):
        self.host = Host(listed=[self.room()])
        with dispatcher(self.host), no_loopback():
            answer = self.rename("r-1", {"name": "Roadmap", "event_id": "e-1"})
        self.assertEqual(answer["status"], 200)
        self.assertEqual(answer["payload"]["room"]["name"], "Roadmap")
        self.assertEqual(self.asked("groups.rename"), [{"room_id": "r-1", "event_id": "e-1", "name": "Roadmap"}])

    def test_a_rename_the_app_did_not_name_an_event_for_still_carries_one(self):
        self.host = Host(listed=[self.room()])
        with dispatcher(self.host), no_loopback():
            answer = self.rename("r-1", {"name": "Roadmap"})
        self.assertEqual(answer["status"], 200)
        self.assertTrue(self.asked("groups.rename")[0]["event_id"])

    def test_renaming_a_room_the_host_does_not_hold_is_refused_in_its_words(self):
        with dispatcher(self.host), no_loopback():
            answer = self.rename("r-gone", {"name": "Roadmap", "event_id": "e-1"})
        self.assertEqual(answer["status"], 400)
        self.assertEqual(answer["payload"]["error"]["message"], "hosted room not found")
        self.assertEqual(answer["payload"]["error"]["code"], 4117)

    def test_a_disband_leaves_a_deletion_in_the_chat_list(self):
        self.host = Host(listed=[self.room()])
        with dispatcher(self.host), no_loopback():
            self.assertIn("room:r-1", self.chats())
            answer = self.disband("r-1")
            self.assertEqual(answer["status"], 200)
            self.assertEqual(self.chats()["room:r-1"], {"at": 3000000, "deleted": True})
        self.assertEqual(self.asked("groups.disband"), [{"room_id": "r-1"}])

    def test_a_room_the_hosts_worker_cannot_work_is_answered_as_unavailable(self):
        self.host = Host(refuse="groups.create")
        with dispatcher(self.host), no_loopback():
            answer = self.create(
                {"room_id": "r-1", "name": "Planning", "members": [member("default"), member("gots")]}
            )
        self.assertEqual(answer["status"], 503)
        self.assertEqual(answer["payload"]["error"]["message"], "Group Chat worker is unavailable.")

    def test_a_refusal_the_host_marks_keeps_its_reason_and_status(self):
        for reason, status in (("authority_conflict", 409), ("room_history_expired", 410)):
            with self.subTest(reason=reason):
                self.host = Host(refuse="groups.create", code=4110, reason=reason)
                with dispatcher(self.host), no_loopback():
                    answer = self.create({
                        "room_id": "r-1",
                        "name": "Planning",
                        "members": [member("default"), member("gots")],
                    })
                self.assertEqual(answer["status"], status)
                self.assertEqual(answer["payload"]["error"]["reason"], reason)

    def test_the_room_routes_answer_a_refused_key_before_the_host_is_asked(self):
        self.adapter.denied = {"status": 401, "payload": {"error": {"message": "No key."}}}
        with dispatcher(self.host), no_loopback():
            answers = [
                self.create({
                    "room_id": "r-1",
                    "name": "Planning",
                    "members": [member("default"), member("gots")],
                }),
                self.rename("r-1", {"name": "Roadmap"}),
                self.disband("r-1"),
            ]
        self.assertEqual([answer["status"] for answer in answers], [401, 401, 401])
        self.assertEqual(self.host.requests, [], "a refused key never reaches the Host")

    def test_a_room_change_is_noted_on_the_chat_list(self):
        members = [member("default"), member("gots")]
        with dispatcher(self.host), no_loopback(), mock.patch.object(plugin.events, "note") as note:
            self.create({"room_id": "r-1", "name": "Planning", "members": members})
        self.assertEqual(note.call_args.args[:2], ("chats", None), "a device merges rooms as chats")
        self.assertEqual(note.call_args.args[3], True)

    def test_a_host_that_pages_the_same_offset_for_ever_is_read_once(self):
        self.host = Host(listed=[self.room()], page_size=1, stuck=True)
        with dispatcher(self.host), no_loopback():
            records = self.chats()
        self.assertIn("room:r-1", records)
        self.assertLessEqual(
            len(self.asked("groups.list")), rooms.MAX_PAGES + 2, "a wrong offset is not a flood"
        )

    def test_a_host_that_holds_the_chat_list_is_answered_without_its_rooms(self):
        self.host = Host(listed=[self.room()], delay=1.5)
        chats.merge(store.db_path(self.home), {"c": {"at": 5, "value": {"title": "Mine"}}})
        with mock.patch.object(rooms, "CHAT_LIST_TIMEOUT", 0.0):
            with dispatcher(self.host), no_loopback():
                records = self.chats()
        self.assertEqual(sorted(records), ["c"], "the chats answer even when the Host hangs")

    def test_an_overlong_room_id_does_not_refuse_the_rest_of_the_list(self):
        overlong = "room:" + "r" * 300
        with no_dispatcher(), no_loopback():
            handler = route(self.app, plugin.PREFIX + "/chats", "POST")
            answer = asyncio.run(handler(post({"chats": {
                overlong: {"at": 5, "value": {"kind": "room", "name": "Mine"}},
                "c": {"at": 5, "value": {"title": "Mine"}},
            }})))
        self.assertEqual(answer["status"], 200)
        self.assertIn("c", answer["payload"]["chats"])

    def test_a_disband_the_host_names_no_time_for_still_takes_the_row_away(self):
        for stamp in ("tombstoned", True):
            with self.subTest(stamp=stamp):
                room = self.room()
                room["disbanded_at"] = stamp
                self.host = Host(listed=[room])
                with dispatcher(self.host), no_loopback():
                    record = self.chats()["room:r-1"]
                self.assertTrue(record["deleted"])
                self.assertEqual(record["at"], 1500000, "the Host's own last change, not the epoch")

    def test_a_refusal_whose_data_is_not_an_object_is_still_quoted(self):
        frame = {
            "jsonrpc": "2.0",
            "id": 1,
            "error": {"code": 4110, "message": "members must contain between 2 and 6 entries", "data": "roster"},
        }
        with self.assertRaises(rooms.HostRefusal) as caught:
            rooms._result(frame, "groups.create")
        self.assertEqual(str(caught.exception), "members must contain between 2 and 6 entries")
        self.assertEqual(caught.exception.status, 400)
        self.assertEqual(caught.exception.data, {})

    def test_the_merged_chat_list_carries_the_rooms_too(self):
        self.host = Host(listed=[self.room()])
        with dispatcher(self.host), no_loopback():
            records = self.merge({"c": {"at": 5, "value": {"title": "Mine"}}})
        self.assertEqual(sorted(records), ["c", "room:r-1"], "a device reads its list by merging it")

    def test_the_merge_answer_takes_a_disbanded_room_away(self):
        self.host = Host(listed=[self.room()])
        with dispatcher(self.host), no_loopback():
            self.disband("r-1")
            records = self.merge({})
        self.assertEqual(records["room:r-1"], {"at": 3000000, "deleted": True})

    def test_a_host_that_can_only_read_its_rooms_still_lists_them(self):
        self.host = Host(listed=[self.room()], methods=list(rooms.READ))
        with dispatcher(self.host), no_loopback():
            records = self.chats()
        self.assertIn("room:r-1", records, "a room the Host can read is a room a device shows")

    def test_a_room_the_host_names_no_time_for_is_not_shown(self):
        room = self.room()
        del room["updated_at"], room["created_at"]
        self.host = Host(listed=[room])
        with dispatcher(self.host), no_loopback():
            self.assertNotIn("room:r-1", self.chats(), "the epoch is not a time to put a row at")

    def test_every_page_of_a_hosts_rooms_reaches_the_chat_list(self):
        self.host = Host(listed=[self.room(f"r-{index}") for index in range(3)], page_size=1)
        with dispatcher(self.host), no_loopback():
            records = self.chats()
        self.assertEqual(sorted(records), ["room:r-0", "room:r-1", "room:r-2"])

    def test_a_refusing_room_list_still_answers_the_chats(self):
        self.host = Host(listed=[self.room()], refuse="groups.list")
        chats.merge(store.db_path(self.home), {"c": {"at": 5, "value": {"title": "Mine"}}})
        with dispatcher(self.host), no_loopback():
            records = self.chats()
        self.assertEqual(sorted(records), ["c"], "the chats are the answer; the rooms are the extra")

    def test_the_device_holds_the_same_room_prefix_this_module_writes(self):
        source = Path(__file__).resolve().parents[2] / "app" / "src" / "lib" / "sync.ts"
        self.assertEqual(
            js_constant(source.read_text(encoding="utf-8"), "ROOM_ID_PREFIX"),
            rooms.ROOM_PREFIX,
            "the sync drops these ids, so the two spellings must not drift",
        )

    def test_the_chat_list_carries_a_room_the_bot_sits_in(self):
        self.host = Host(listed=[self.room(), self.room("r-2", [member("gots"), member("docs")])])
        with dispatcher(self.host), no_loopback():
            records = self.chats()
        self.assertEqual(list(records), ["room:r-1"], "a room the bot is not seated in has no row here")
        self.assertEqual(records["room:r-1"], {
            "at": 1500000,
            "value": {
                "kind": "room",
                "roomId": "r-1",
                "name": "Planning",
                "members": [
                    {"profile": "default", "handle": "default", "name": "default"},
                    {"profile": "gots", "handle": "gots", "name": "Gots"},
                ],
            },
        })

    def test_the_chat_list_keeps_its_own_records_where_the_host_has_no_rooms(self):
        chats.merge(store.db_path(self.home), {"c": {"at": 5, "value": {"title": "Mine"}}})
        with no_dispatcher(), no_loopback():
            records = self.chats()
        self.assertEqual(records, {"c": {"at": 5, "value": {"title": "Mine"}}})

    def test_a_device_cannot_store_a_room_as_a_chat(self):
        with no_dispatcher(), no_loopback():
            handler = route(self.app, plugin.PREFIX + "/chats", "POST")
            answer = asyncio.run(handler(post({"chats": {
                "room:r-1": {"at": 5, "value": {"kind": "room", "name": "Mine"}},
                "c": {"at": 5, "value": {"title": "Mine"}},
            }})))
        self.assertEqual(answer["status"], 200)
        self.assertNotIn("room:r-1", answer["payload"]["chats"], "a room is projected, never stored")
        self.assertIn("c", answer["payload"]["chats"])

    def room(self, room_id="r-1", members=None):
        return {
            "room_id": room_id,
            "name": "Planning",
            "members": members or [member("default"), member("gots", name="Gots")],
            "created_at": 1000.0,
            "updated_at": 1500.0,
        }


if __name__ == "__main__":
    unittest.main()
