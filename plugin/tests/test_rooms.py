"""The plugin reaches the Host's rooms and advertises `rooms`.

A room is the Host's, not Gots's (ADR 0115), and the way in is the Host's own RPC dispatch
(ADR 0117). This file covers the seam alone: a capabilities and a list call answered through it, the
peer it leaves behind, the feature vanishing where nothing answers, and the driver gate that keeps a
room the Host would never answer off the app.

The suite has no Hermes installed, so the Host is stubbed at the seam (``gateway.session_controls``,
``gateway.session_authorities``) and, for the fallback, at the gateway client. What a fake cannot
prove — a real gateway answering, and a room made in the desktop appearing here — is the pull
request's checklist item.

Run: python3 -m unittest plugin.tests.test_rooms -v
"""

from __future__ import annotations

import asyncio
import os
import sys
import types
import unittest
from contextlib import asynccontextmanager
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest import mock

import plugin
from plugin import rooms
from plugin.tests._helpers import FakeWeb, route, wire

HOME = Path("/home/bot")
ROOMS = {"rooms": [{"room_id": "crew", "name": "Crew"}], "next_offset": None}


def capabilities(driver: bool = True) -> dict:
    """The Host's own answer to `groups.capabilities`, as its dispatcher composes it."""
    return {
        "protocol_version": 1,
        "driver": driver,
        "persistent_process": True,
        "authority_gateway_id": "gateway",
        "features": ["room_identity", "monotonic_log", "replayable_disband"],
        "methods": ["groups.capabilities", "groups.list"],
        "max_log_limit": 200,
        "seatable_profiles": ["default", "alpha"],
    }


class FakeAuthority:
    """The authority one call is made against: its live peers, and the profile and instance it
    speaks for (both of which the grant the Host reads its principal from names)."""

    def __init__(self) -> None:
        self.events = {}
        self.profile_id = str(HOME)
        self.instance_id = "instance-1"


class Host:
    """The Host's own dispatcher, and the authority it speaks for."""

    def __init__(
        self, *, driver: bool = True, refusal: str = "", served: bool = True,
        dispatch_raises: bool = False,
    ) -> None:
        self.driver, self.refusal, self.served = driver, refusal, served
        self.dispatch_raises = dispatch_raises
        self.authority = FakeAuthority()
        self.adapter = SimpleNamespace(gateway_runner=object(), _check_auth=lambda request: None)
        self.requests: list = []
        self.identities: list = []
        self.lookups: list = []
        self.closed: list = []

    def answer(self, request: dict) -> dict:
        if request["method"] == "groups.capabilities":
            return capabilities(self.driver)
        if request["method"] == "groups.list":
            return dict(ROOMS)
        raise AssertionError(f"the seam asked for something this test never planted: {request}")

    def modules(self) -> dict:
        host = self

        class AuthorityConnection:  # noqa: N801 - named as Hermes names it
            def __init__(self, authority, transport, identity) -> None:
                self.actor = SimpleNamespace(transport_id=f"call-{len(host.identities)}")
                self.authority = authority
                host.identities.append(identity)
                # The Host's own side effects: a peer is live on the authority while it speaks, and
                # its `close` is what takes it back out (`gateway/session_controls.py`).
                authority.events[self.actor.transport_id] = transport

            async def dispatch(self, request):
                host.requests.append(request)
                if host.dispatch_raises:
                    raise RuntimeError("the handler is broken")
                if host.refusal:
                    return {
                        "jsonrpc": "2.0",
                        "id": request["id"],
                        "error": {"code": 4001, "message": host.refusal},
                    }
                return {"jsonrpc": "2.0", "id": request["id"], "result": host.answer(request)}

            async def close(self):
                host.closed.append(self.actor.transport_id)
                self.authority.events.pop(self.actor.transport_id, None)

        controls = types.ModuleType("gateway.session_controls")
        controls.AuthorityConnection = AuthorityConnection

        def authority_for_home(runner, home):
            host.lookups.append((runner, home))
            return host.authority if host.served else None

        authorities = types.ModuleType("gateway.session_authorities")
        authorities.authority_for_home = authority_for_home
        return {
            "gateway": types.ModuleType("gateway"),
            "gateway.session_controls": controls,
            "gateway.session_authorities": authorities,
        }


class GatewayClient:
    """The Host's own gateway client over loopback, and the discovery that finds its owner."""

    def __init__(self, *, state: str = "ready", refusal: str = "", no_rooms: bool = False) -> None:
        self.state, self.refusal, self.no_rooms = state, refusal, no_rooms
        self.calls: list = []
        self.dialed: list = []

    def modules(self) -> dict:
        client = self

        class GatewayClientError(ValueError):
            pass

        class GatewayRPCError(GatewayClientError):
            pass

        class Live:
            async def rpc(self, method, **params):
                client.calls.append((method, params))
                if client.no_rooms:
                    raise GatewayRPCError("unknown_method")
                if client.refusal:
                    raise GatewayRPCError(client.refusal)
                return capabilities() if method == "groups.capabilities" else dict(ROOMS)

        @asynccontextmanager
        async def connect_gateway(endpoint=None, subject=None):
            client.dialed.append(endpoint)
            yield Live()

        runtime = types.ModuleType("hermes_cli.gateway_runtime")
        runtime.discover_gateway_endpoint = lambda home, timeout=2.0: SimpleNamespace(
            state=client.state, endpoint=object() if client.state == "ready" else None
        )
        runtime.attachable = lambda found: found.endpoint is not None
        found = types.ModuleType("hermes_cli.gateway_client")
        found.connect_gateway = connect_gateway
        found.GatewayClientError = GatewayClientError
        found.GatewayRPCError = GatewayRPCError
        return {
            "hermes_cli": types.ModuleType("hermes_cli"),
            "hermes_cli.gateway_runtime": runtime,
            "hermes_cli.gateway_client": found,
        }


class CallTest(unittest.TestCase):
    def test_a_capabilities_call_is_answered_by_the_hosts_own_dispatch(self) -> None:
        host = Host()
        with mock.patch.dict(sys.modules, host.modules()):
            found = asyncio.run(rooms.call("groups.capabilities", {}, adapter=host.adapter, home=HOME))
        self.assertEqual(found, capabilities())
        self.assertEqual([request["method"] for request in host.requests], ["groups.capabilities"])
        # The call goes to the authority that serves this profile, through the plugin's one rule for
        # finding it (`pending.authority`), and acts as the user a Desktop Group Chat acts as.
        self.assertEqual(host.lookups, [(host.adapter.gateway_runner, HOME)])
        self.assertEqual([grant["user_id"] for grant in host.identities], [rooms.local_subject()])

    def test_the_grant_keeps_the_bare_subject_a_room_is_owned_by(self) -> None:
        # The Host reads a connection's principal from the grant (`authenticated_subject`): anything
        # but its own local-user shape is namespaced `auth:v1:[...]`, a different principal, and the
        # call would list none of the Desktop's rooms while `rooms` was still advertised.
        host = Host()
        with mock.patch.dict(sys.modules, host.modules()):
            asyncio.run(rooms.call("groups.list", {}, adapter=host.adapter, home=HOME))
        grant = host.identities[0]
        self.assertEqual(grant["provider"], "local")
        self.assertEqual(grant["profile_id"], host.authority.profile_id)
        self.assertEqual(grant["instance_id"], host.authority.instance_id)
        # Host-scoped like the Desktop's socket: a room seats any bot the Host serves.
        self.assertEqual(grant["profile_scope"], "host")
        # What a room call needs, and not `session:create`, which would mark it native and hand it
        # history adoption.
        self.assertEqual(set(grant["capabilities"]), set(rooms.CAPABILITIES))
        self.assertNotIn("session:create", grant["capabilities"])

    def test_a_list_call_carries_the_query_and_returns_the_rooms_the_host_holds(self) -> None:
        host = Host()
        with mock.patch.dict(sys.modules, host.modules()):
            found = asyncio.run(
                rooms.call("groups.list", {"limit": 20}, adapter=host.adapter, home=HOME)
            )
        self.assertEqual(found, ROOMS)
        self.assertEqual(host.requests[0]["params"], {"limit": 20})
        self.assertEqual(host.requests[0]["method"], "groups.list")

    def test_the_call_leaves_no_peer_registered_on_the_authority(self) -> None:
        host = Host()
        with mock.patch.dict(sys.modules, host.modules()):
            asyncio.run(rooms.call("groups.list", {}, adapter=host.adapter, home=HOME))
        self.assertEqual(host.authority.events, {})
        # Handed back through the Host's own teardown, not a private dict pop.
        self.assertEqual(host.closed, ["call-0"])

    def test_a_refusal_crosses_as_the_hosts_reason(self) -> None:
        host = Host(refusal="permission_denied")
        with mock.patch.dict(sys.modules, host.modules()):
            with self.assertRaises(rooms.RoomsError) as caught:
                asyncio.run(rooms.call("groups.list", {}, adapter=host.adapter, home=HOME))
        self.assertEqual(caught.exception.status, 403)
        self.assertIn("permission denied", str(caught.exception))

    def test_a_refusal_over_the_gateway_client_crosses_as_the_same_status(self) -> None:
        host, client = Host(served=False), GatewayClient(refusal="permission_denied")
        modules = {**host.modules(), **client.modules()}
        with mock.patch.dict(sys.modules, modules):
            with self.assertRaises(rooms.RoomsError) as caught:
                asyncio.run(rooms.call("groups.list", {}, adapter=host.adapter, home=HOME))
        self.assertEqual(caught.exception.status, 403)

    def test_a_profile_this_process_does_not_serve_falls_to_the_gateway_client(self) -> None:
        host, client = Host(served=False), GatewayClient()
        modules = {**host.modules(), **client.modules()}
        with mock.patch.dict(sys.modules, modules):
            found = asyncio.run(rooms.call("groups.list", {}, adapter=host.adapter, home=HOME))
        self.assertEqual(found, ROOMS)
        self.assertEqual(client.calls, [("groups.list", {})])
        self.assertEqual(host.requests, [])

    def test_a_dispatcher_that_raises_falls_to_the_gateway_client_and_frees_its_peer(self) -> None:
        # ADR 0117's "when that import *or call* fails": the fault is logged, the peer handed back,
        # and the other way in answers.
        host, client = Host(dispatch_raises=True), GatewayClient()
        modules = {**host.modules(), **client.modules()}
        with mock.patch.dict(sys.modules, modules):
            found = asyncio.run(rooms.call("groups.list", {}, adapter=host.adapter, home=HOME))
        self.assertEqual(found, ROOMS)
        self.assertEqual(client.calls, [("groups.list", {})])
        self.assertEqual(host.authority.events, {})


class AvailableTest(unittest.TestCase):
    def test_a_host_with_a_running_driver_advertises_rooms(self) -> None:
        host = Host()
        with mock.patch.dict(sys.modules, host.modules()):
            self.assertIsNone(rooms.available(host.adapter, HOME))

    def test_a_host_without_the_dispatcher_advertises_nothing(self) -> None:
        # The ticket's red case: this Hermes has no `groups.*` dispatcher to hand a request to, and
        # no gateway client either, so the app draws no room and no New room rather than an error.
        host = Host()
        modules = host.modules()
        del modules["gateway.session_controls"]
        with mock.patch.dict(sys.modules, modules):
            reason = rooms.available(host.adapter, HOME)
        self.assertIn("can't reach its rooms", reason or "")

    def test_a_host_with_no_running_driver_advertises_nothing(self) -> None:
        host = Host(driver=False)
        with mock.patch.dict(sys.modules, host.modules()):
            reason = rooms.available(host.adapter, HOME)
        self.assertEqual(reason, "This Hermes has no room driver running.")

    def test_an_owner_that_is_not_running_is_never_started_for_a_gate(self) -> None:
        host, client = Host(served=False), GatewayClient(state="starting")
        modules = {**host.modules(), **client.modules()}
        with mock.patch.dict(sys.modules, modules):
            reason = rooms.available(host.adapter, HOME)
        self.assertIn("no gateway owner to dial", reason or "")
        self.assertEqual(client.dialed, [])

    def test_a_gateway_client_answer_is_enough_for_the_row(self) -> None:
        host, client = Host(served=False), GatewayClient()
        modules = {**host.modules(), **client.modules()}
        with mock.patch.dict(sys.modules, modules):
            self.assertIsNone(rooms.available(host.adapter, HOME))
        self.assertEqual(client.calls, [("groups.capabilities", {})])

    def test_a_host_with_no_room_methods_reads_as_no_rooms_not_as_a_fault(self) -> None:
        # ADR 0117: a Host without the methods "has no rooms in Gots, and no error either". A
        # warning with a traceback here would fire on every poll of a perfectly healthy Host.
        host, client = Host(served=False), GatewayClient(no_rooms=True)
        modules = {**host.modules(), **client.modules()}
        with mock.patch.dict(sys.modules, modules), self.assertLogs(level="DEBUG") as logged:
            reason = rooms.available(host.adapter, HOME)
        self.assertEqual(reason, "This Hermes has no rooms.")
        self.assertFalse([line for line in logged.output if "WARNING" in line])


class SubjectTest(unittest.TestCase):
    def test_the_local_user_is_the_one_its_control_socket_names(self) -> None:
        # `gateway/control_socket.py` names a same-user peer `uid:<uid>`, and that is the subject a
        # Desktop ticket carries: a room call has to act as the same one to see the Desktop's rooms.
        self.assertEqual(rooms.local_subject(), f"uid:{os.getuid()}")


class InfoTest(unittest.TestCase):
    """What the app reads: `info.features` lists `rooms` exactly where the Host answers for one."""

    def features(self, *, dispatcher: bool = True) -> list:
        def delegate_task(**kwargs):
            return {"handle": "subagent-1"}

        delegate_tool = ModuleType("tools.delegate_tool")
        delegate_tool.delegate_task = delegate_task
        delegate_tool._strip_model_hidden_task_fields = lambda tasks: tasks
        tools = ModuleType("tools")
        tools.delegate_tool = delegate_tool
        constants = ModuleType("hermes_constants")
        constants.get_hermes_home = lambda: HOME
        modules = {
            **Host().modules(),
            "hermes_constants": constants,
            "tools": tools,
            "tools.delegate_tool": delegate_tool,
        }
        if not dispatcher:
            del modules["gateway.session_controls"]
        # `wire` starts a patch of its own and stops it with this case's cleanups, so its snapshot
        # would include the modules planted here and put them back after the test. Cleanups run
        # last-in-first-out, so one registered first restores the real tree last.
        real = dict(sys.modules)
        self.addCleanup(lambda: (sys.modules.clear(), sys.modules.update(real)))
        with mock.patch.dict(sys.modules, modules):
            # `wire` supplies aiohttp and hands back the app the plugin's routes were added to.
            handler = route(wire(self, SimpleNamespace(
                gateway_runner=object(), _check_auth=lambda request: None
            )), plugin.PREFIX + "/info")
            request = FakeWeb.Request()
            request.match_info, request.headers = {}, {}
            return asyncio.run(handler(request))["payload"]["features"]

    def test_rooms_is_listed_where_the_host_has_a_driver(self) -> None:
        self.assertIn(rooms.FEATURE, self.features())

    def test_rooms_is_not_listed_where_the_dispatcher_cannot_be_imported(self) -> None:
        # The ticket's red case: the app draws no room and no New Room rather than an error.
        self.assertNotIn(rooms.FEATURE, self.features(dispatcher=False))


if __name__ == "__main__":
    unittest.main()
