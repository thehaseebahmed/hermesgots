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
import unittest
from types import ModuleType, SimpleNamespace
from unittest import mock

import plugin
from plugin import rooms
from plugin.tests._helpers import FakeWeb, RouteAdapter, route, temp_hermes_home, wire


class Host:
    """The Host's own RPC dispatch, and the answers it gives the seam for each `groups.*` request."""

    def __init__(
        self,
        listed=(),
        driver=True,
        methods=("groups.capabilities", "groups.list", "groups.create", "groups.rename",
                 "groups.disband"),
        refuse=None,
        refusal=None,
        inline=False,
    ):
        self.listed = list(listed)
        self.driver = driver
        self.methods = list(methods)
        self.refuse = refuse
        # The Host's answer for the method it won't serve, in its own words and with its own code.
        self.refusal = refusal or (4123, "Group Chat worker is unavailable.")
        self.inline = inline
        self.requests = []

    def answer(self, method, params=None):
        params = params or {}
        if method == "groups.capabilities":
            return {"protocol_version": 1, "driver": self.driver, "methods": self.methods}
        if method == "groups.list":
            return {"rooms": self.listed, "next_offset": None}
        if method == "groups.create":
            return {"room": {"room_id": params.get("room_id"), "name": params.get("name"),
                             "members": params.get("members"), "idempotent": False}}
        if method == "groups.rename":
            return {"room": {"room_id": params.get("room_id"), "name": params.get("name"),
                             "revision": 2, "event": {"event_id": params.get("event_id")}}}
        if method == "groups.disband":
            return {"tombstone": {"room_id": params.get("room_id"), "disbanded_at": 1_760_000_000.0,
                                  "idempotent": False}}
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
        host = Host(methods=["groups.capabilities", "groups.list"])
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


class RoomRoutes(unittest.TestCase):
    """A room created, renamed and disbanded through the plugin's own routes."""

    def setUp(self):
        self.home = temp_hermes_home(self)

    def asked(self, path, *, room_id=None, body=None, unreadable=False):
        """Ask one route the way the app does: a JSON body, and the room on the path where it has one."""
        request = FakeWeb.Request()
        request.headers = {}
        request.match_info = {"room_id": room_id} if room_id is not None else {}
        sent = "{not json" if unreadable else ("" if body is None else json.dumps(body))

        async def read():
            if unreadable:
                raise ValueError("Expecting value: line 1 column 1 (char 0)")
            return body

        async def text():
            return sent

        request.json = read
        request.text = text
        app = wire(self, RouteAdapter())
        return asyncio.run(route(app, path)(request))

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
                plugin.PREFIX + "/rooms/{room_id}", room_id="room-1", body={"event_id": "e1", "name": "Planning 2"}
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
                plugin.PREFIX + "/rooms/{room_id}", room_id="room-1", body={"name": "Planning 2"}
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


if __name__ == "__main__":
    unittest.main()
