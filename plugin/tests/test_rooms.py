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
import json
import sys
import threading
import unittest
from types import ModuleType, SimpleNamespace
from unittest import mock

import plugin
from plugin import events, rooms, store
from plugin.tests._helpers import FakeWeb, RouteAdapter, route, temp_hermes_home, wire


class Host:
    """The Host's own RPC dispatch, and the answers it gives the seam for each `groups.*` request."""

    def __init__(
        self,
        listed=(),
        driver=True,
        methods=("groups.capabilities", "groups.list", "groups.create", "groups.rename",
                 "groups.disband", "groups.state", "groups.log", "groups.send",
                 "groups.approve", "groups.stop"),
        refuse=None,
        refusal=None,
        inline=False,
        page=None,
        events=(),
        driver_status=None,
        states=None,
        features=None,
    ):
        self.listed = list(listed)
        self.driver = driver
        self.methods = list(methods)
        # What the Host declares it can do beyond the methods: today a Host that projects a room
        # member's questions names it here, which is what earns `rooms_questions` (rooms.py).
        self.features = list(features or [])
        self.approvals = []
        self.stops = []
        self.refuse = refuse
        # The Host's answer for the method it won't serve, in its own words and with its own code.
        self.refusal = refusal or (4123, "Group Chat worker is unavailable.")
        self.inline = inline
        # The most rooms one `groups.list` answer carries, where the Host pages its list.
        self.page = page
        self.requests = []
        # The room's own conversation: its log, the driver's live status, and the rooms `groups.state`
        # answers for. A send appends to the log, as the Host's does.
        self.events = list(events)
        self.driver_status = driver_status or {
            "running": True, "working": False, "blocked": False, "counts": {},
            "pending_actions": [], "member_activity": [], "peer_routes": [],
        }
        self.states = dict(states or {})
        self.sends = []

    def log_page(self, params):
        """One `groups.log` page: what the device hasn't got, bounded by the limit it asked for."""
        since = int(params.get("since_seq") or 0)
        limit = params.get("limit")
        held = [one for one in self.events if int(one["seq"]) > since]
        page = held[:limit] if isinstance(limit, int) else held
        cursor = int(page[-1]["seq"]) if page else since
        return {
            "events": page,
            "cursor": cursor,
            "latest_seq": int(self.events[-1]["seq"]) if self.events else 0,
            "has_more": len(held) > len(page),
            "authority": {"gateway_id": "gw-1", "epoch": 1},
        }

    def sent(self, params):
        """One `groups.send`: the Host appends the message its client named and wakes the driver."""
        self.sends.append(params)
        event = {
            "room_id": params["room_id"], "seq": (int(self.events[-1]["seq"]) if self.events else 0) + 1,
            "event_id": params["event_id"], "kind": "message.user",
            "actor": {"kind": "user", "id": "user"},
            "payload": {"text": params["payload"]["text"], "thread_id": params["payload"]["thread_id"]},
            "created_at": 1_760_002_000.0, "idempotent": False,
        }
        self.events.append(event)
        return {"event": event, "client_event_id": params["event_id"], "accepted": True,
                "driver_started": True}

    def answer(self, method, params=None):
        params = params or {}
        if method == "groups.capabilities":
            return {"protocol_version": 1, "driver": self.driver, "methods": self.methods,
                    "features": self.features}
        if method == "groups.list":
            # The Host's own reader: a room that has been disbanded answers only when it is asked
            # for, which is what makes a tombstone reachable at all.
            rooms = (
                self.listed
                if params.get("include_disbanded")
                else [one for one in self.listed if one.get("disbanded_at") is None]
            )
            limit = self.page or params.get("limit")
            offset = int(params.get("offset") or 0)
            if not isinstance(limit, int) or limit <= 0:
                return {"rooms": rooms, "next_offset": None}
            page = rooms[offset:offset + limit]
            nxt = offset + limit if offset + limit < len(rooms) else None
            return {"rooms": page, "next_offset": nxt}
        if method == "groups.create":
            return {"room": {"room_id": params.get("room_id"), "name": params.get("name"),
                             "members": params.get("members"), "idempotent": False}}
        if method == "groups.rename":
            return {"room": {"room_id": params.get("room_id"), "name": params.get("name"),
                             "revision": 2, "event": {"event_id": params.get("event_id")}}}
        if method == "groups.disband":
            return {"tombstone": {"room_id": params.get("room_id"), "disbanded_at": 1_760_000_000.0,
                                  "idempotent": False}}
        if method == "groups.state":
            return {"room": self.states.get(params.get("room_id")) or ROOM,
                    "driver_status": self.driver_status}
        if method == "groups.log":
            return self.log_page(params)
        if method == "groups.send":
            return self.sent(params)
        if method == "groups.approve":
            # The Host's own approve: it resolves only the exact request the app named.
            self.approvals.append(params)
            return {"approved": True, "result": {"choice": params.get("choice"), "request_id":
                                                 params.get("request_id")}}
        if method == "groups.stop":
            self.stops.append(params)
            return {"cancelled": 1}
        raise AssertionError(f"the seam asked for {method}")

    def dispatch(self, request, transport=None):
        """Answer one request the way the Host does: straight back, or from its pool through the
        transport the request was bound to (every `groups.*` method is a long handler)."""
        self.requests.append(request)
        refused = self.refusal if request["method"] == self.refuse else None
        if refused is not None:
            code, message = refused
            frame = {
                "jsonrpc": "2.0",
                "id": request["id"],
                "error": {"code": code, "message": message},
            }
        else:
            frame = {
                "jsonrpc": "2.0",
                "id": request["id"],
                "result": self.answer(request["method"], request.get("params")),
            }
        if self.inline:
            return frame
        # The Host's own events ride the same transport while a handler runs.
        transport.write({"jsonrpc": "2.0", "method": "event", "params": {}})
        transport.write(frame)
        return None


class Mute(Host):
    """A Host that answers every write with an empty result: a success that carries nothing."""

    def answer(self, method, params=None):
        return {}


class LoopbackRefusal(ValueError):
    """The Host's `GatewayRPCError`: a received refusal, carrying its bounded reason and code."""

    def __init__(self, message, code=None, data=None):
        super().__init__(message)
        self.code = code
        self.data = data or {}


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


UNSET = object()


class Loopback:
    """The Host's gateway client, dialled over its loopback control socket.

    ``refuse`` is what this client raises instead of an answer — the client keeps only the Host's
    bounded reason code and its scalar data, never its prose — and ``answer`` what it hands back raw
    where the frame carried no result at all.
    """

    def __init__(self, host, *, refuse=None, answer=UNSET):
        self.host = host
        self.refuse = refuse
        self.answer_value = answer
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
        if self.refuse is not None:
            reason, code, data = self.refuse
            raise LoopbackRefusal(reason, code, data)
        if self.answer_value is not UNSET:
            return self.answer_value
        return self.host.answer(method, params)


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

    def test_no_room_writes_where_the_host_declares_only_the_read(self):
        host = Host(methods=["groups.capabilities", "groups.list", "groups.state", "groups.log"])
        with dispatcher(host), no_loopback():
            features = self.features()
        self.assertIn("rooms", features)
        self.assertNotIn("rooms_write", features, "a New room there could only come back refused")

    def test_the_writes_are_advertised_with_the_read_where_the_host_declares_them(self):
        with dispatcher(Host()), no_loopback():
            features = self.features()
        self.assertEqual([one for one in features if one.startswith("rooms")], ["rooms", "rooms_write"])

    def test_no_rooms_where_the_driver_is_not_running(self):
        host = Host(driver=False)
        with dispatcher(host), no_loopback():
            self.assertNotIn("rooms", self.features())
            self.assertIn("driver", rooms.available())

    def test_a_host_that_cannot_show_a_room_advertises_none(self):
        # The read asks `groups.state` and `groups.log`, so a Host that lists rooms and can't show
        # one would put a row on every device and an error banner behind every tap.
        host = Host(methods=["groups.capabilities", "groups.list"])
        with dispatcher(host), no_loopback():
            self.assertNotIn("rooms", self.features())
            self.assertIn("groups.state", rooms.available())

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


ROSTER = [
    {"member_id": "m1", "profile": "default", "handle": "hermes"},
    {"member_id": "m2", "profile": "coder", "handle": "coder"},
]


def asked_route(case, path, *, method=None, room_id=None, body=None, unreadable=False, query=None):
    request = FakeWeb.Request()
    request.headers = {}
    request.match_info = {"room_id": room_id} if room_id is not None else {}
    request.query = query or {}
    sent = "{not json" if unreadable else ("" if body is None else json.dumps(body))

    async def read():
        if unreadable:
            raise ValueError("Expecting value: line 1 column 1 (char 0)")
        return body

    async def text():
        return sent

    request.json = read
    request.text = text
    app = wire(case, RouteAdapter())
    return asyncio.run(route(app, path, method)(request))


class RoomRoutes(unittest.TestCase):
    """A room created, renamed and disbanded through the plugin's own routes."""

    def setUp(self):
        self.home = temp_hermes_home(self)

    def asked(self, path, *, room_id=None, body=None, unreadable=False, method=None):
        return asked_route(
            self, path, method=method, room_id=room_id, body=body, unreadable=unreadable
        )

    def created(self, members=ROSTER, **extra):
        return self.asked(plugin.PREFIX + "/rooms", body={"room_id": "room-1", "name": "Planning", "members": members, **extra})

    def test_a_room_is_created_with_the_id_the_app_minted(self):
        host = Host()
        with dispatcher(host), no_loopback():
            answer = self.created()
        self.assertEqual(answer["status"], 200)
        self.assertEqual(answer["payload"]["object"], "gots.room")
        self.assertEqual(answer["payload"]["room"]["room_id"], "room-1")
        self.assertEqual(answer["payload"]["room"]["members"], ROSTER)
        self.assertEqual(
            host.requests[-1]["params"],
            {"room_id": "room-1", "name": "Planning", "members": ROSTER},
            "the room's id is the app's, and the roster is the Host's to read",
        )

    def test_a_roster_under_two_is_the_hosts_refusal(self):
        self.assert_refused(ROSTER[:1], "members must contain between 2 and 6 entries")

    def test_a_roster_over_six_is_the_hosts_refusal(self):
        many = [
            {"member_id": f"m{n}", "profile": f"bot{n}", "handle": f"bot{n}"} for n in range(7)
        ]
        self.assert_refused(many, "members must contain between 2 and 6 entries")

    def test_a_duplicate_handle_is_the_hosts_refusal(self):
        twice = [ROSTER[0], {**ROSTER[1], "handle": ROSTER[0]["handle"]}]
        self.assert_refused(
            twice, "member handles must be unique and cannot reserve @all or @everyone"
        )

    def test_a_reserved_handle_is_the_hosts_refusal(self):
        taken = [ROSTER[0], {**ROSTER[1], "handle": "all"}]
        self.assert_refused(
            taken, "member handles must be unique and cannot reserve @all or @everyone"
        )

    def assert_refused(self, members, message):
        """The roster reaches the Host as the app built it, and its refusal comes back as it said it."""
        host = Host(refuse="groups.create", refusal=(4110, message))
        with dispatcher(host), loopback(Loopback(host)) as client:
            answer = self.created(members)
        self.assertEqual(host.requests[-1]["params"]["members"], members)
        self.assertEqual(answer["status"], 400)
        self.assertEqual(answer["payload"], {"error": {"message": message}})
        self.assertEqual(client.methods, [], "a refusal is the Host's answer, so it is never repeated")

    def test_a_create_without_the_id_the_app_minted_is_a_400_and_the_host_is_not_asked(self):
        host = Host()
        with dispatcher(host), no_loopback():
            answer = self.asked(
                plugin.PREFIX + "/rooms", body={"name": "Planning", "members": ROSTER}
            )
        self.assertEqual(answer["status"], 400)
        self.assertIn("room_id", answer["payload"]["error"]["message"])
        self.assertEqual(host.requests, [], "the plugin never invents a room's id")

    def test_a_room_id_that_is_not_a_string_is_a_400_and_the_host_is_not_asked(self):
        host = Host()
        with dispatcher(host), no_loopback():
            answer = self.asked(
                plugin.PREFIX + "/rooms",
                body={"room_id": {"wrong": "shape"}, "name": "Planning", "members": ROSTER},
            )
        self.assertEqual(answer["status"], 400)
        self.assertEqual(host.requests, [], "an id the app can't address is never sent as one")

    def test_a_body_that_is_not_json_is_a_400(self):
        host = Host()
        with dispatcher(host), no_loopback():
            answer = self.asked(plugin.PREFIX + "/rooms", unreadable=True)
        self.assertEqual(answer["status"], 400)
        self.assertEqual(answer["payload"], {"error": {"message": "Body must be JSON"}})
        self.assertEqual(host.requests, [])

    def test_a_rename_carries_the_event_id_the_app_minted(self):
        host = Host()
        with dispatcher(host), no_loopback():
            answer = self.asked(
                plugin.PREFIX + "/rooms/{room_id}", room_id="room-1", method="POST",
                body={"event_id": "e1", "name": "Planning 2"},
            )
        self.assertEqual(answer["status"], 200)
        self.assertEqual(answer["payload"]["room"]["name"], "Planning 2")
        self.assertEqual(
            host.requests[-1]["params"], {"room_id": "room-1", "event_id": "e1", "name": "Planning 2"}
        )

    def test_a_rename_without_the_event_id_the_app_minted_is_a_400(self):
        host = Host()
        with dispatcher(host), no_loopback():
            answer = self.asked(
                plugin.PREFIX + "/rooms/{room_id}", room_id="room-1", method="POST",
                body={"name": "Planning 2"},
            )
        self.assertEqual(answer["status"], 400)
        self.assertIn("event_id", answer["payload"]["error"]["message"])
        self.assertEqual(host.requests, [], "a rename the Host can't tell from another is not asked")

    def test_a_disband_answers_the_hosts_tombstone(self):
        host = Host()
        with dispatcher(host), no_loopback():
            answer = self.asked(plugin.PREFIX + "/rooms/{room_id}/disband", room_id="room-1", body={})
        self.assertEqual(answer["status"], 200)
        self.assertEqual(answer["payload"]["object"], "gots.room.tombstone")
        self.assertEqual(answer["payload"]["tombstone"]["room_id"], "room-1")
        self.assertIsNotNone(answer["payload"]["tombstone"]["disbanded_at"])
        self.assertEqual(host.requests[-1]["params"], {"room_id": "room-1"})

    def test_a_disband_with_no_body_asks_the_host_without_a_cancel_id(self):
        host = Host()
        with dispatcher(host), no_loopback():
            answer = self.asked(plugin.PREFIX + "/rooms/{room_id}/disband", room_id="room-1")
        self.assertEqual(answer["status"], 200)
        self.assertEqual(host.requests[-1]["params"], {"room_id": "room-1"})

    def test_a_disband_whose_body_cannot_be_read_is_a_400_and_the_host_is_not_asked(self):
        host = Host()
        with dispatcher(host), no_loopback():
            answer = self.asked(
                plugin.PREFIX + "/rooms/{room_id}/disband", room_id="room-1", unreadable=True
            )
        self.assertEqual(answer["status"], 400)
        self.assertEqual(answer["payload"], {"error": {"message": "Body must be JSON"}})
        self.assertEqual(host.requests, [], "a body it couldn't read is refused, not thrown away")

    def test_a_loopback_refusal_carries_the_words_the_host_gave_it(self):
        # The client forwards no free text (hermes_cli/gateway_client.py's `rpc_error`), so the
        # detail the Host put beside its code is the words this way can show the app.
        refusal = ("request_failed", 4110, {"detail": "members must contain between 2 and 6 entries"})
        with no_dispatcher(), loopback(Loopback(Host(), refuse=refusal)):
            answer = self.created()
        self.assertEqual(answer["status"], 400)
        self.assertEqual(
            answer["payload"], {"error": {"message": "members must contain between 2 and 6 entries"}}
        )

    def test_a_loopback_answer_with_no_result_is_a_502_not_a_crash(self):
        with no_dispatcher(), loopback(Loopback(Host(), answer=None)):
            answer = self.created()
        self.assertEqual(answer["status"], 502)
        self.assertIn("no room", answer["payload"]["error"]["message"])

    def test_a_host_that_answers_a_create_without_a_room_is_a_502(self):
        with dispatcher(Mute()), no_loopback():
            answer = self.created()
        self.assertEqual(answer["status"], 502)
        self.assertIn("no room", answer["payload"]["error"]["message"])

    def test_a_host_this_bot_cannot_reach_is_a_502_in_its_own_words(self):
        with no_dispatcher(), no_loopback():
            answer = self.created()
        self.assertEqual(answer["status"], 502)
        self.assertEqual(answer["payload"], {"error": {"message": "This host can't reach its rooms."}})

    def test_a_create_asks_the_gateway_of_the_profile_it_was_asked_for(self):
        host = Host()
        with no_dispatcher(), loopback(Loopback(host)) as client:
            self.created()
        self.assertEqual(
            client.homes, [self.home], "the request's profile's gateway is the one asked"
        )


ROOM = {
    "room_id": "room-1",
    "name": "Planning",
    "members": [
        {**ROSTER[0], "display_name": "Hermes", "target": {"url": "http://127.0.0.1:9/target"}},
        ROSTER[1],
    ],
    "authority_gateway_id": "gw-1",
    "authority_epoch": 1,
    "revision": 1,
    "created_at": 1_760_000_000.0,
    "updated_at": 1_760_000_600.5,
}


class RoomInTheChatList(unittest.TestCase):
    """A room's record in the chat list a device merges (ADR 0116).

    The list is the plugin's, not a synced document, so the record is projected into every read:
    no new document, no new encryption path, and a device that has never opened the room still gets
    its row. It is projected and never stored, so nothing can edit a room through the chat list.
    """

    def setUp(self):
        self.home = temp_hermes_home(self)
        # One Host's projection serves every bot of it, so a read inside the window is the last
        # read's answer; a case that changes the Host's rooms starts from no answer at all.
        with rooms._projections_lock:
            rooms._projections.clear()

    def asked(self, path, body=None, method=None):
        return asked_route(self, path, body=body, method=method)

    def chats(self, rooms_listed=None, host=None):
        """The chat list a device reads, over a Host that hosts these rooms and no chats."""
        host = host or Host(listed=rooms_listed or [])
        with dispatcher(host), no_loopback():
            answer = self.asked(plugin.PREFIX + "/chats")
        self.assertEqual(answer["status"], 200)
        self.assertEqual(answer["payload"]["object"], "gots.chats")
        return answer["payload"]["chats"]

    def test_a_room_is_a_record_a_device_merges(self):
        record = self.chats([ROOM])["room-1"]
        self.assertEqual(record["at"], 1_760_000_600_500, "the room's own clock, in the app's millis")
        self.assertEqual(
            record["value"],
            {
                "title": "Planning",
                "createdAt": 1_760_000_000_000,
                "updatedAt": 1_760_000_600_500,
                "room": {
                    "id": "room-1",
                    "members": [
                        {
                            "memberId": "m1",
                            "profile": "default",
                            "handle": "hermes",
                            "displayName": "Hermes",
                        },
                        {"memberId": "m2", "profile": "coder", "handle": "coder"},
                    ],
                },
            },
            "a row's name, its roster in the app's words, and nothing of the Host's routing",
        )

    def test_the_records_change_time_moves_with_the_room(self):
        renamed = {**ROOM, "name": "Planning 2", "revision": 2, "updated_at": 1_760_001_200.0}
        # No window, so the second read really asks the Host: one Host's answer stands for a breath.
        with mock.patch.object(rooms, "PROJECTION_TTL", 0.0):
            self.assertEqual(self.chats([ROOM])["room-1"]["at"], 1_760_000_600_500)
            record = self.chats([renamed])["room-1"]
        self.assertEqual(record["at"], 1_760_001_200_000, "a read after the rename says the room moved")
        self.assertEqual(record["value"]["title"], "Planning 2")

    def test_the_merge_answers_the_rooms_beside_the_chats_it_kept(self):
        host = Host(listed=[ROOM])
        with dispatcher(host), no_loopback():
            answer = self.asked(
                plugin.PREFIX + "/chats",
                body={"chats": {"chat-1": {"at": 5, "value": {"title": "Mine"}}}},
                method="POST",
            )
        chats = answer["payload"]["chats"]
        self.assertEqual(answer["status"], 200)
        self.assertEqual(chats["chat-1"], {"at": 5, "value": {"title": "Mine"}})
        self.assertEqual(chats["room-1"]["value"]["title"], "Planning")
        self.assertEqual(
            [one["method"] for one in host.requests],
            ["groups.capabilities", "groups.list"],
            "the merge asked the Host for its rooms, and stored nothing of them",
        )

    def test_a_host_with_no_rooms_leaves_the_list_exactly_as_it_was(self):
        host = Host(methods=["groups.list"])
        with dispatcher(host), no_loopback():
            answer = self.asked(
                plugin.PREFIX + "/chats",
                body={"chats": {"chat-1": {"at": 5, "value": {}}}},
                method="POST",
            )
        self.assertEqual(answer["payload"]["chats"], {"chat-1": {"at": 5, "value": {}}})

    def test_a_disbanded_room_is_the_records_deletion(self):
        disbanded = {**ROOM, "disbanded_at": 1_760_001_000.0}
        record = self.chats([disbanded])["room-1"]
        self.assertEqual(
            record,
            {"at": 1_760_001_000_000, "deleted": True},
            "a device that merged the row takes it away, rather than keeping a room the Host retired",
        )

    def test_the_hosts_rooms_are_asked_for_once_a_read(self):
        host = Host(listed=[ROOM])
        first = self.chats(host=host)
        second = self.chats(host=host)
        self.assertEqual(first, second)
        self.assertEqual(
            [one["method"] for one in host.requests],
            ["groups.capabilities", "groups.list"],
            "the second read is the first's answer",
        )

    def test_two_bots_reading_at_once_still_ask_the_host_once(self):
        # The app merges a Host's bots side by side, so the second bot's read is in flight before
        # the first bot's answer lands: it waits for that answer rather than asking again.
        host = Host(listed=[ROOM])
        answers = []
        with dispatcher(host), no_loopback():
            readers = [threading.Thread(target=lambda: answers.append(self.chats(host=host))) for _ in range(2)]
            for reader in readers:
                reader.start()
            for reader in readers:
                reader.join()
        self.assertEqual(answers, [{"room-1": answers[0]["room-1"]}] * 2)
        self.assertEqual(
            [one["method"] for one in host.requests],
            ["groups.capabilities", "groups.list"],
            "one answer served both bots' reads",
        )

    def test_a_host_that_pages_its_rooms_is_read_to_the_last_page(self):
        many = [{**ROOM, "room_id": f"room-{n}", "name": f"Room {n}"} for n in range(3)]
        chats = self.chats(host=Host(listed=many, page=2))
        self.assertEqual(sorted(chats), ["room-0", "room-1", "room-2"], "every page is a row")


def event(seq, kind, actor, payload, at=1_760_000_100.0):
    """One row of the Host's room log, in the Host's own shape."""
    return {"room_id": "room-1", "seq": seq, "event_id": f"e{seq}", "kind": kind, "actor": actor,
            "payload": payload, "created_at": at, "idempotent": False}


USER = {"kind": "user", "id": "user"}
MEMBER = {"kind": "member", "id": "m1", "profile": "default", "display_name": "Hermes"}

CONVERSATION = [
    event(1, "message.user", USER, {"text": "who is free?", "thread_id": "e1"}),
    event(2, "message.member", MEMBER, {
        "text": "me", "member_id": "m1", "member_index": 0, "round_index": 0, "task_id": "t1",
        "thread_id": "e1", "turn_id": "d1.r0.p0.s1.m1", "discussion_event_id": "e1"}),
    event(3, "turn.settled", {"kind": "gateway", "id": "gw-1"}, {
        "member_id": "m2", "member_index": 1, "round_index": 0, "task_id": "t2", "thread_id": "e1",
        "turn_id": "d1.r0.p1.s1.m2", "discussion_event_id": "e1", "seen_through_seq": 2,
        "message_event_id": None, "passed": True}),
    event(4, "room.activity", {"kind": "gateway", "id": "gw-1"}, {
        "status": "bounded", "reason_code": "max_rounds", "thread_id": "e1",
        "discussion_event_id": "e1"}),
]


class RoomConversation(unittest.TestCase):
    """A message sent into the room, read back as the Host's log and live state (ADR 0115-0117).

    The app is never in the loop the Host works in: a send is one idempotent append, the members'
    rounds run on the Host with no client attached, and the app reads the log afterwards. One read
    answers the delta, the room's live state and whether it can be written to at all.
    """

    def setUp(self):
        self.home = temp_hermes_home(self)

    def asked(self, path, *, room_id=None, body=None, query=None, unreadable=False, method="POST"):
        return asked_route(
            self, path, method=method, room_id=room_id, body=body, unreadable=unreadable,
            query=query,
        )

    def read_room(self, *, room_id="room-1", query=None):
        return self.asked(plugin.PREFIX + "/rooms/{room_id}", room_id=room_id, query=query,
                          method="GET")

    def send(self, body=None, *, room_id="room-1", unreadable=False):
        return self.asked(
            plugin.PREFIX + "/rooms/{room_id}/send", room_id=room_id,
            body={"event_id": "e9", "text": "second thoughts"} if body is None else body,
            unreadable=unreadable,
        )

    def test_one_read_answers_the_log_the_live_state_and_whether_it_can_be_written_to(self):
        host = Host(events=CONVERSATION, driver_status={
            "running": True, "working": True, "blocked": False, "counts": {"queued": 0},
            "pending_actions": [],
            "member_activity": [{"member_id": "m1", "status": "running"}], "peer_routes": [],
        })
        with dispatcher(host), no_loopback():
            answer = self.read_room()
        self.assertEqual(answer["status"], 200)
        payload = answer["payload"]
        self.assertEqual(payload["object"], "gots.room")
        self.assertEqual(payload["room"]["id"], "room-1")
        self.assertEqual(payload["room"]["name"], "Planning")
        self.assertEqual([one["memberId"] for one in payload["room"]["members"]], ["m1", "m2"])
        self.assertEqual(payload["latestSeq"], 4)
        self.assertEqual(payload["cursor"], 4)
        self.assertFalse(payload["hasMore"])
        self.assertTrue(payload["working"])
        self.assertEqual(payload["activity"], [{"memberId": "m1", "status": "running"}])
        self.assertTrue(payload["canSend"])
        self.assertEqual(
            payload["events"],
            [
                {"seq": 1, "eventId": "e1", "kind": "message.user", "text": "who is free?"},
                {"seq": 2, "eventId": "e2", "kind": "message.member", "text": "me",
                 "memberId": "m1", "name": "Hermes"},
                {"seq": 3, "eventId": "e3", "kind": "turn.settled", "memberId": "m2"},
                {"seq": 4, "eventId": "e4", "kind": "room.activity", "status": "bounded",
                 "reason": "max_rounds"},
            ],
            "the log in the app's own words: no actor routing, no thread coordinates to draw, and "
            "nothing the screen does not draw",
        )

    def test_the_read_asks_the_host_only_for_what_the_device_has_not_got(self):
        host = Host(events=CONVERSATION)
        with dispatcher(host), no_loopback():
            self.read_room(query={"since": "2"})
        logs = [one for one in host.requests if one["method"] == "groups.log"]
        self.assertEqual([one["params"] for one in logs],
                         [{"room_id": "room-1", "since_seq": 2}],
                         "the log is asked for what the device has not got, and once")

    def test_a_since_that_is_not_a_sequence_is_a_400_and_the_host_is_not_asked(self):
        host = Host(events=CONVERSATION)
        with dispatcher(host), no_loopback():
            answer = self.read_room(query={"since": "yesterday"})
        self.assertEqual(answer["status"], 400)
        self.assertIn("since", answer["payload"]["error"]["message"])
        self.assertEqual(host.requests, [])

    def test_a_read_says_no_send_where_the_host_will_not_take_one(self):
        host = Host(events=CONVERSATION,
                    methods=["groups.capabilities", "groups.list", "groups.state", "groups.log"])
        with dispatcher(host), no_loopback():
            answer = self.read_room()
        self.assertFalse(answer["payload"]["canSend"], "a composer there could only come back refused")

    def test_a_host_that_is_not_working_its_rooms_takes_no_send(self):
        # Its driver can stop after `info` said it was running: a message there is accepted and
        # never answered, which reads to the user as bots ignoring them.
        host = Host(events=CONVERSATION, driver_status={
            "running": False, "working": False, "blocked": False, "counts": {},
            "pending_actions": [], "member_activity": [], "peer_routes": [],
        })
        with dispatcher(host), no_loopback():
            answer = self.read_room()
        self.assertFalse(answer["payload"]["canSend"])

    def test_a_device_with_no_page_starts_at_the_rooms_newest_window(self):
        many = [event(n, "message.member", MEMBER, {"text": f"line {n}", "member_id": "m1"})
                for n in range(1, 4)]
        room = {**ROOM, "latest_seq": 900}
        host = Host(events=many, states={"room-1": room})
        with dispatcher(host), no_loopback():
            self.read_room()
        asked = [one for one in host.requests if one["method"] == "groups.log"][0]
        self.assertEqual(asked["params"]["since_seq"], 400,
                         "500 back from the Host's newest, not the room's first words")

    def test_a_send_carries_the_event_id_the_app_minted_and_the_words(self):
        host = Host(events=CONVERSATION)
        with dispatcher(host), no_loopback():
            answer = self.send({"event_id": "e9", "text": "  second thoughts  "})
        self.assertEqual(answer["status"], 200)
        self.assertEqual(answer["payload"]["object"], "gots.room.sent")
        self.assertEqual(answer["payload"]["event"]["seq"], 5)
        self.assertEqual(answer["payload"]["event"]["text"], "second thoughts")
        self.assertEqual(
            host.sends,
            [{"room_id": "room-1", "event_id": "e9",
              "payload": {"text": "second thoughts", "thread_id": "e9"}}],
            "the message's own id is the thread the Host opens for it, as the desktop sends",
        )

    def test_a_send_with_no_words_is_a_400_and_the_host_is_not_asked(self):
        host = Host(events=CONVERSATION)
        with dispatcher(host), no_loopback():
            answer = self.send({"event_id": "e9", "text": "   "})
        self.assertEqual(answer["status"], 400)
        self.assertIn("words", answer["payload"]["error"]["message"])
        self.assertEqual(host.sends, [])

    def test_a_send_without_the_event_id_is_a_400_and_the_host_is_not_asked(self):
        host = Host(events=CONVERSATION)
        with dispatcher(host), no_loopback():
            answer = self.send({"text": "second thoughts"})
        self.assertEqual(answer["status"], 400)
        self.assertIn("event_id", answer["payload"]["error"]["message"])
        self.assertEqual(host.sends, [])

    def test_a_send_whose_body_cannot_be_read_is_a_400(self):
        host = Host(events=CONVERSATION)
        with dispatcher(host), no_loopback():
            answer = self.send(unreadable=True)
        self.assertEqual(answer["status"], 400)
        self.assertEqual(answer["payload"], {"error": {"message": "Body must be JSON"}})
        self.assertEqual(host.sends, [])

    def test_a_send_notes_a_room_change_so_every_device_hears_it(self):
        host = Host(events=CONVERSATION)
        with dispatcher(host), no_loopback():
            self.send()
        rows, _more = events.read_since(store.current_path(), 0)
        self.assertEqual([(row["kind"], row["session_id"]) for row in rows], [("room", "room-1")],
                         "the device that sent it isn't the only one watching")

    def test_a_hosts_refusal_to_send_is_the_apps_400_in_the_hosts_words(self):
        host = Host(events=CONVERSATION, refuse="groups.send",
                    refusal=(4111, "This Group Chat reached its history limit."))
        with dispatcher(host), loopback(Loopback(host)) as client:
            answer = self.send()
        self.assertEqual(answer["status"], 400)
        self.assertEqual(
            answer["payload"], {"error": {"message": "This Group Chat reached its history limit."}}
        )
        self.assertEqual(client.methods, [], "a refusal is an answer, so it is never repeated")

    def test_a_room_this_bot_cannot_reach_is_a_502_in_its_own_words(self):
        with no_dispatcher(), no_loopback():
            answer = self.read_room()
        self.assertEqual(answer["status"], 502)
        self.assertEqual(answer["payload"], {"error": {"message": "This host can't reach its rooms."}})

    def test_a_host_that_answers_a_read_without_a_room_is_a_502(self):
        class Mute(Host):
            def answer(self, method, params=None):
                return {}

        with dispatcher(Mute()), no_loopback():
            answer = self.read_room()
        self.assertEqual(answer["status"], 502)
        self.assertIn("no room", answer["payload"]["error"]["message"])

    def test_the_hosts_methods_are_asked_once_and_kept(self):
        host = Host(events=CONVERSATION)
        with dispatcher(host), no_loopback():
            self.read_room()
            self.read_room()
        asked = [one["method"] for one in host.requests].count("groups.capabilities")
        self.assertEqual(asked, 1, "a method list cannot change between two polls of one room")

    def test_a_read_follows_the_logs_own_pages_and_says_what_it_left(self):
        # The Host bounds a page by count and bytes; a read that stopped at the first would hand the
        # app half a round and make it ask again for the rest.
        many = [event(n, "message.member", MEMBER, {"text": f"line {n}", "member_id": "m1"})
                for n in range(1, 6)]
        host = Host(events=many)

        class Paged(Host):
            def log_page(self, params):
                page = super().log_page({**params, "limit": 2})
                page["has_more"] = len(self.events) > (page["cursor"] or 0)
                return page

        with dispatcher(Paged(events=many)), no_loopback():
            answer = self.read_room()
        payload = answer["payload"]
        self.assertEqual([one["seq"] for one in payload["events"]], [1, 2, 3, 4, 5],
                         "every page of the delta is one answer")
        self.assertEqual(payload["cursor"], 5)
        self.assertFalse(payload["hasMore"], "and the cap was not reached")

    def test_a_members_activity_notes_its_room_once_a_tick(self):
        # The Host's own `on_room_member_activity` hook: a member's turn running, its tools and the
        # approval it raised. A room of six members would otherwise note a change per frame.
        path = store.current_path()
        before = events.latest(path)
        rooms.on_member_activity(room_id="room-1", kind="tool.started", payload={})
        rooms.on_member_activity(room_id="room-1", kind="message.delta", payload={})
        rows, _more = events.read_since(path, before)
        self.assertEqual([(row["kind"], row["session_id"]) for row in rows], [("room", "room-1")],
                         "one change per room per tick")
        rooms.on_member_activity(kind="tool.started", payload={})
        self.assertEqual(
            [(row["kind"], row["session_id"]) for row in events.read_since(path, before)[0]],
            [("room", "room-1")],
            "an activity frame that names no room notes nothing",
        )


APPROVAL = {
    "kind": "approval", "task_id": "dtask:1", "execution_generation": 3,
    "run_id": "run-1", "session_id": "session-1", "request_id": "approval-1", "member_id": "m1",
    "approval": {
        "request_id": "approval-1", "command": "rm -rf build", "description": "Clear the build",
        "choices": ["once", "deny", "session", "always"],
    },
}

QUESTION = {
    "id": "q0", "question": "Which database?", "choices": ["Postgres", "SQLite"],
    "multi_select": False,
}


def waiting_host(**extra):
    """A Host whose member m1 waits on an approval, and whose driver is otherwise at rest."""
    return Host(driver_status={
        "running": True, "working": True, "blocked": True, "counts": {"running": 1},
        "pending_actions": [APPROVAL], "member_activity": [{"member_id": "m1", "status": "running"}],
        "peer_routes": [],
    }, **extra)


@contextlib.contextmanager
def answerable(resolved):
    """The Host's own server-request seam, as the plugin reaches it in process: `resolved` collects
    every response frame written for a waiting request and says whether one is still open."""
    module = ModuleType("tui_gateway.server_requests")
    held = SimpleNamespace(frames=resolved, open={"srq-1"})

    def resolve_response(frame, transport=None):
        held.frames.append(dict(frame))
        return frame.get("id") in held.open

    module.resolve_response = resolve_response
    with planted({"tui_gateway": package("tui_gateway"), "tui_gateway.server_requests": module}):
        yield held


class RoomWaiting(unittest.TestCase):
    """The room needs the user, and the user answers there (F4).

    An approval is the Host's own pending action, answered through its own `groups.approve`, which
    takes Once or Deny and nothing else. A question is held by the plugin for the member's turn — a
    Host that never projects one holds nothing, and a room there draws no card it can't answer.
    """

    def setUp(self):
        self.home = temp_hermes_home(self)
        with rooms._questions_lock:
            rooms._questions.clear()

    def asked(self, path, *, room_id=None, body=None, method="POST", unreadable=False):
        return asked_route(self, path, method=method, room_id=room_id, body=body,
                           unreadable=unreadable)

    def read_room(self):
        return self.asked(plugin.PREFIX + "/rooms/{room_id}", room_id="room-1", method="GET")

    def approve(self, body=None):
        return self.asked(
            plugin.PREFIX + "/rooms/{room_id}/approve", room_id="room-1",
            body={"member_id": "m1", "task_id": "dtask:1", "execution_generation": 3,
                  "request_id": "approval-1", "choice": "once"} if body is None else body,
        )

    def answer(self, body=None):
        return self.asked(
            plugin.PREFIX + "/rooms/{room_id}/answer", room_id="room-1",
            body={"member_id": "m1", "question_id": "srq-1",
                  "answers": {"q0": "Postgres"}} if body is None else body,
        )

    def stop(self, body=None):
        return self.asked(plugin.PREFIX + "/rooms/{room_id}/stop", room_id="room-1", body=body)

    def test_the_read_says_which_approval_the_room_waits_on(self):
        host = waiting_host(events=CONVERSATION)
        with dispatcher(host), no_loopback():
            payload = self.read_room()["payload"]
        self.assertEqual(
            payload["waiting"],
            [{"kind": "approval", "memberId": "m1", "taskId": "dtask:1", "generation": 3,
              "requestId": "approval-1", "command": "rm -rf build", "description": "Clear the build"}],
            "the pending action's exact coordinates, and only Once or Deny to answer it with",
        )

    def test_a_room_at_rest_waits_on_nothing(self):
        with dispatcher(Host(events=CONVERSATION)), no_loopback():
            self.assertEqual(self.read_room()["payload"]["waiting"], [])

    def test_an_approval_is_not_drawn_where_the_host_cannot_take_an_answer(self):
        # A Host that lists rooms and declares no approve: the card would be a tap that can only
        # come back refused, so the room draws none and the Host's own timeout answers it.
        host = waiting_host(
            events=CONVERSATION,
            methods=["groups.capabilities", "groups.list", "groups.state", "groups.log"],
        )
        with dispatcher(host), no_loopback():
            payload = self.read_room()["payload"]
        self.assertEqual(payload["waiting"], [])
        self.assertFalse(payload["canStop"], "and a Stop it never declared is not offered either")

    def test_an_approval_is_answered_once_through_the_hosts_own_approve(self):
        host = waiting_host(events=CONVERSATION)
        with dispatcher(host), no_loopback():
            answer = self.approve()
        self.assertEqual(answer["status"], 200)
        self.assertEqual(answer["payload"]["object"], "gots.room.approved")
        self.assertEqual(
            host.approvals,
            [{"room_id": "room-1", "member_id": "m1", "task_id": "dtask:1",
              "execution_generation": 3, "request_id": "approval-1", "choice": "once"}],
            "the Host resolves the one request the app named, and nothing beside it",
        )

    def test_deny_is_the_other_answer(self):
        host = waiting_host(events=CONVERSATION)
        with dispatcher(host), no_loopback():
            answer = self.approve({"member_id": "m1", "task_id": "dtask:1",
                                   "execution_generation": 3, "request_id": "approval-1",
                                   "choice": "deny"})
        self.assertEqual(answer["status"], 200)
        self.assertEqual(host.approvals[-1]["choice"], "deny")

    def test_a_third_choice_is_a_400_and_the_host_is_not_asked(self):
        # The Host's own approve takes Once or Deny only; a Session or Always tap would be a card
        # that can only come back refused.
        host = waiting_host(events=CONVERSATION)
        with dispatcher(host), no_loopback():
            answer = self.approve({"member_id": "m1", "task_id": "dtask:1",
                                   "execution_generation": 3, "request_id": "approval-1",
                                   "choice": "always"})
        self.assertEqual(answer["status"], 400)
        self.assertIn("Once", answer["payload"]["error"]["message"])
        self.assertEqual(host.approvals, [])

    def test_an_approval_with_no_member_is_a_400(self):
        host = waiting_host(events=CONVERSATION)
        with dispatcher(host), no_loopback():
            answer = self.approve({"task_id": "dtask:1", "execution_generation": 3,
                                   "request_id": "approval-1", "choice": "once"})
        self.assertEqual(answer["status"], 400)
        self.assertIn("member_id", answer["payload"]["error"]["message"])
        self.assertEqual(host.approvals, [])

    def test_an_approval_the_host_no_longer_waits_on_is_its_own_refusal(self):
        host = waiting_host(events=CONVERSATION, refuse="groups.approve",
                            refusal=(4127, "room approval is no longer pending"))
        with dispatcher(host), loopback(Loopback(host)) as client:
            answer = self.approve()
        self.assertEqual(answer["status"], 400)
        self.assertEqual(answer["payload"]["error"]["message"],
                         "room approval is no longer pending")
        self.assertEqual(client.methods, [], "a refusal is an answer, so it is never repeated")

    def test_an_answered_approval_notes_the_room_so_every_device_hears_it(self):
        host = waiting_host(events=CONVERSATION)
        path = store.current_path()
        before = events.latest(path)
        with dispatcher(host), no_loopback():
            self.approve()
        self.assertEqual(
            [(row["kind"], row["session_id"]) for row in events.read_since(path, before)[0]],
            [("room", "room-1")],
        )

    def test_a_question_a_member_asks_is_held_and_read_back_with_its_choices(self):
        host = Host(events=CONVERSATION, features=[rooms.QUESTION_FEATURE])
        with dispatcher(host), no_loopback():
            rooms.on_member_activity(
                room_id="room-1", member_id="m1", task_id="dtask:1", kind="request.opened",
                payload={"kind": "clarify", "request_id": "srq-1", "questions": [QUESTION]},
            )
            payload = self.read_room()["payload"]
        self.assertEqual(
            payload["waiting"],
            [{"kind": "question", "memberId": "m1", "questionId": "srq-1",
              "questions": [{"id": "q0", "question": "Which database?",
                             "choices": ["Postgres", "SQLite"], "multiSelect": False}]}],
            "the question, the choices it offers, and the request the Host waits on",
        )

    def test_the_hosts_own_frame_is_read_where_it_forwards_the_request_id(self):
        # The Host's clarify request carries `questions` keyed `qid` and no `kind` of its own; the
        # request it waits with is its envelope id, so a frame that forwards it is what is held.
        host = Host(events=CONVERSATION, features=[rooms.QUESTION_FEATURE])
        with dispatcher(host), no_loopback():
            rooms.on_member_activity(
                room_id="room-1", member_id="m1", request_id="srq-9", kind="request.opened",
                payload={"questions": [{"qid": "q0", "question": "Which database?",
                                        "choices": ["Postgres", "SQLite"]}], "answers": {}},
            )
            waiting = self.read_room()["payload"]["waiting"]
        self.assertEqual([one["questionId"] for one in waiting], ["srq-9"])
        self.assertEqual(waiting[0]["questions"][0]["id"], "q0", "a qid is a question's id")

    def test_a_frame_that_forwards_no_request_id_holds_nothing(self):
        # Today's Host projects approvals only, and forwards neither a kind nor the request id: the
        # plugin must not invent a card whose tap would find no waiter.
        with dispatcher(Host(events=CONVERSATION)), no_loopback():
            rooms.on_member_activity(
                room_id="room-1", member_id="m1", kind="request.opened",
                payload={"questions": [{"qid": "q0", "question": "Which database?"}]},
            )
            self.assertEqual(self.read_room()["payload"]["waiting"], [])

    def test_a_question_the_hosts_wait_outlived_is_not_drawn(self):
        host = Host(events=CONVERSATION, features=[rooms.QUESTION_FEATURE])
        with dispatcher(host), no_loopback():
            rooms.on_member_activity(
                room_id="room-1", member_id="m1", kind="request.opened", request_id="srq-1",
                payload={"questions": [QUESTION]},
            )
            with mock.patch.object(rooms, "QUESTION_TTL", 0.0):
                self.assertEqual(self.read_room()["payload"]["waiting"], [])
            with rooms._questions_lock:
                rooms._questions.clear()

    def test_the_question_bound_is_one_rooms_and_never_anothers(self):
        with rooms._questions_lock:
            rooms._questions.clear()
        for n in range(rooms.MAX_QUESTIONS + 1):
            rooms.hold_question("room-1", "m1", f"srq-{n}", [QUESTION])
        rooms.hold_question("room-2", "m2", "srq-other", [QUESTION])
        with rooms._questions_lock:
            held = [one for one in rooms._questions.values() if one["roomId"] == "room-1"]
            other = [one for one in rooms._questions.values() if one["roomId"] == "room-2"]
        self.assertEqual(len(held), rooms.MAX_QUESTIONS, "a room keeps its own bound")
        self.assertEqual(len(other), 1, "and asks nothing of another room's")

    def test_a_question_is_answered_with_its_choice(self):
        host = Host(events=CONVERSATION, features=[rooms.QUESTION_FEATURE])
        with dispatcher(host), no_loopback():
            rooms.on_member_activity(
                room_id="room-1", member_id="m1", task_id="dtask:1", kind="request.opened",
                payload={"kind": "clarify", "request_id": "srq-1", "questions": [QUESTION]},
            )
            with answerable([]) as resolved:
                answer = self.answer()
            waiting = self.read_room()["payload"]["waiting"]
        self.assertEqual(answer["status"], 200)
        self.assertEqual(answer["payload"]["object"], "gots.room.answered")
        self.assertEqual(
            resolved.frames,
            [{"id": "srq-1", "result": {"answers": {"q0": "Postgres"}, "outcome": "submitted"}}],
            "the answer reaches the request the Host's own turn waits on",
        )
        self.assertEqual(waiting, [], "and the card goes")

    def test_an_answer_to_a_question_nothing_waits_on_is_a_409(self):
        host = Host(events=CONVERSATION, features=[rooms.QUESTION_FEATURE])
        with dispatcher(host), no_loopback(), answerable([]):
            answer = self.answer()
        self.assertEqual(answer["status"], 409)
        self.assertIn("waiting", answer["payload"]["error"]["message"])

    def test_a_question_the_host_could_not_take_stays_up_for_another_tap(self):
        # A write that failed is not an answer: the card stays, so the user's tap isn't lost with it.
        host = Host(events=CONVERSATION, features=[rooms.QUESTION_FEATURE])
        with dispatcher(host), no_loopback():
            rooms.on_member_activity(
                room_id="room-1", member_id="m1", task_id="dtask:1", kind="request.opened",
                payload={"kind": "clarify", "request_id": "srq-1", "questions": [QUESTION]},
            )
            with answerable([]) as resolved:
                resolved.open = set()
                resolved.frames.clear()
                module = sys.modules["tui_gateway.server_requests"]

                def broken(frame, transport=None):
                    raise RuntimeError("the request is gone")

                module.resolve_response = broken
                answer = self.answer()
            waiting = self.read_room()["payload"]["waiting"]
        self.assertEqual(answer["status"], 502)
        self.assertEqual(len(waiting), 1, "the card is still there to answer again")

    def test_stop_cancels_the_rooms_work_and_notes_it(self):
        host = Host(events=CONVERSATION)
        path = store.current_path()
        before = events.latest(path)
        with dispatcher(host), no_loopback():
            answer = self.stop({"cancel_id": "c1"})
        self.assertEqual(answer["status"], 200)
        self.assertEqual(answer["payload"]["object"], "gots.room.stopped")
        self.assertEqual(answer["payload"]["cancelled"], 1)
        self.assertEqual(host.stops, [{"room_id": "room-1", "cancel_id": "c1"}])
        self.assertEqual(
            [(row["kind"], row["session_id"]) for row in events.read_since(path, before)[0]],
            [("room", "room-1")],
        )

    def test_stop_with_no_body_asks_the_host_without_a_cancel_id(self):
        host = Host(events=CONVERSATION)
        with dispatcher(host), no_loopback():
            self.stop()
        self.assertEqual(host.stops, [{"room_id": "room-1"}])

    def test_stop_on_a_host_that_cannot_stop_a_room_is_a_400_in_its_words(self):
        host = Host(events=CONVERSATION, refuse="groups.stop",
                    refusal=(4130, "This room's work can't be stopped."))
        with dispatcher(host), loopback(Loopback(host)):
            answer = self.stop()
        self.assertEqual(answer["status"], 400)
        self.assertEqual(answer["payload"]["error"]["message"], "This room's work can't be stopped.")

    def test_rooms_questions_is_advertised_only_where_the_host_names_its_questions(self):
        # A Host that never projects a member's question can't be answered in the room, so the
        # card is not offered there: `rooms` alone, as before.
        reads = ["groups.capabilities", "groups.list", "groups.state", "groups.log"]
        with dispatcher(waiting_host(events=CONVERSATION, methods=reads)), no_loopback():
            self.assertEqual([one for one in self.features() if one.startswith("rooms")], ["rooms"])
        with dispatcher(waiting_host(events=CONVERSATION, methods=reads,
                                     features=[rooms.QUESTION_FEATURE])), no_loopback():
            self.assertEqual(
                [one for one in self.features() if one.startswith("rooms")],
                ["rooms", "rooms_questions"],
            )

    def features(self):
        app = wire(self, RouteAdapter())
        request = FakeWeb.Request()
        request.match_info, request.headers = {}, {}
        answer = asyncio.run(route(app, plugin.PREFIX + "/info")(request))
        return answer["payload"]["features"]


if __name__ == "__main__":
    unittest.main()
