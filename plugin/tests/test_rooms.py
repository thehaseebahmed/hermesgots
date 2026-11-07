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
        methods=("groups.capabilities", "groups.list"),
        refuse=None,
        inline=False,
    ):
        self.listed = list(listed)
        self.driver = driver
        self.methods = list(methods)
        self.refuse = refuse
        self.inline = inline
        self.requests = []

    def answer(self, method):
        if method == "groups.capabilities":
            return {"protocol_version": 1, "driver": self.driver, "methods": self.methods}
        if method == "groups.list":
            return {"rooms": self.listed, "next_offset": None}
        raise AssertionError(f"the seam asked for {method}")

    def dispatch(self, request, transport=None):
        """Answer one request the way the Host does: straight back, or from its pool through the
        transport the request was bound to (every `groups.*` method is a long handler)."""
        self.requests.append(request)
        if self.refuse == request["method"]:
            frame = {
                "jsonrpc": "2.0",
                "id": request["id"],
                "error": {"code": 4123, "message": "Group Chat worker is unavailable."},
            }
        else:
            frame = {"jsonrpc": "2.0", "id": request["id"], "result": self.answer(request["method"])}
        if self.inline:
            return frame
        # The Host's own events ride the same transport while a handler runs.
        transport.write({"jsonrpc": "2.0", "method": "event", "params": {}})
        transport.write(frame)
        return None


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
        return self.host.answer(method)


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


if __name__ == "__main__":
    unittest.main()
