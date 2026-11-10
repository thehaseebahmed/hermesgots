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
import base64
import contextlib
import hashlib
import json
import sys
import threading
import unittest
from types import ModuleType, SimpleNamespace
from unittest import mock
from urllib.parse import parse_qs, urlencode, urlsplit

import plugin
from plugin import events, media, push, rooms, store
from plugin.tests._helpers import FakeWeb, RouteAdapter, route, temp_hermes_home, wire


class Host:
    """The Host's own RPC dispatch, and the answers it gives the seam for each `groups.*` request."""

    def __init__(
        self,
        listed=(),
        driver=True,
        methods=("groups.capabilities", "groups.list", "groups.create", "groups.rename",
                 "groups.disband", "groups.state", "groups.log", "groups.send",
                 "groups.approve", "groups.stop",
                 "groups.attachment.upload", "groups.attachment.download"),
        refuse=None,
        refusal=None,
        inline=False,
        page=None,
        events=(),
        driver_status=None,
        states=None,
        features=None,
        seatable_profiles=("default", "coder"),
    ):
        self.listed = list(listed)
        self.driver = driver
        self.methods = list(methods)
        # What the Host declares it can do beyond the methods: today a Host that projects a room
        # member's questions names it here, which is what earns `rooms_questions` (rooms.py).
        self.features = list(features or [])
        # The profiles this caller's connection may seat in a new group, named beside its methods
        # (#141178). None is a Host older than the field, which answers without it at all. A
        # callable is a roster that moves with the profile's own `config.yaml`, which is how the
        # create's repair is answered: the Host re-reads it on the next ask (ADR 0129).
        self.seatable_profiles = seatable_profiles
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
        # The Host's own attachment store (gateway/hosted_room_attachments.py): the uploads it was
        # asked for, the downloads of them, and the bytes it kept under an id it minted itself.
        self.uploads = []
        self.downloads = []
        self.blobs = {}
        self.by_upload = {}

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
        carried = params["payload"].get("attachments")
        event = {
            "room_id": params["room_id"], "seq": (int(self.events[-1]["seq"]) if self.events else 0) + 1,
            "event_id": params["event_id"], "kind": "message.user",
            "actor": {"kind": "user", "id": "user"},
            "payload": {
                "text": params["payload"]["text"],
                "thread_id": params["payload"]["thread_id"],
                **({"attachments": carried} if carried else {}),
            },
            "created_at": 1_760_002_000.0, "idempotent": False,
        }
        self.events.append(event)
        return {"event": event, "client_event_id": params["event_id"], "accepted": True,
                "driver_started": True}

    def stored(self, params):
        """One `groups.attachment.upload`: the Host keeps the bytes under an id of its own minting.

        The upload id is what makes a retry the same file, so a second upload of one id answers the
        row the first one stored rather than a second copy — as the Host's own store does.
        """
        self.uploads.append(params)
        data = base64.b64decode(params.get("data_base64") or "")
        known = self.by_upload.get(params.get("upload_id"))
        if known is not None:
            return dict(self.blobs[known]["attachment"])
        attachment = {
            "attachment_id": f"att_{len(self.blobs) + 1:032x}",
            "kind": params.get("kind"), "name": params.get("name"), "mime": params.get("mime"),
            "size": len(data), "sha256": hashlib.sha256(data).hexdigest(),
            "state": "staged", "created_at": 1_760_003_000.0, "idempotent": False,
        }
        self.blobs[attachment["attachment_id"]] = {"attachment": attachment, "data": data}
        self.by_upload[params.get("upload_id")] = attachment["attachment_id"]
        return dict(attachment)

    def downloaded(self, params):
        """One `groups.attachment.download`: the bytes the event's own attachment was committed under."""
        self.downloads.append(params)
        held = self.blobs.get(params.get("attachment_id"))
        if held is None:
            raise AssertionError(f"the Host was asked for an attachment it never stored: {params}")
        return {**held["attachment"], "data_base64": base64.b64encode(held["data"]).decode("ascii")}

    def answer(self, method, params=None):
        params = params or {}
        if method == "groups.capabilities":
            # A Host that predates the roster answers every other field and no `seatable_profiles`
            # at all, which is what an older gateway does — never an empty list.
            seated = self.seatable_profiles() if callable(self.seatable_profiles) else self.seatable_profiles
            named = {"seatable_profiles": list(seated)} if seated is not None else {}
            return {"protocol_version": 1, "driver": self.driver, "methods": self.methods,
                    "features": self.features, **named}
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
        if method == "groups.attachment.upload":
            return self.stored(params)
        if method == "groups.attachment.download":
            return self.downloaded(params)
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
def config_store(path):
    """This Hermes's own config read and round-trip writer, kept over one file (ADR 0129).

    The writer is Hermes's; this is its stand-in, with the same key-path semantics and one mapping
    behind it, so a write the seam makes is what the Host answers its roster from on the next ask.
    """

    def read_user_config_raw(config_path=None):
        try:
            return json.loads(path.read_text())
        except FileNotFoundError:
            return {}

    def atomic_roundtrip_yaml_update(config_path, key_path, value):
        held = read_user_config_raw(config_path)
        node = held
        keys = key_path.split(".")
        for key in keys[:-1]:
            node = node.setdefault(key, {})
        node[keys[-1]] = value
        path.write_text(json.dumps(held))

    config = ModuleType("hermes_cli.config")
    config.read_user_config_raw = read_user_config_raw  # type: ignore[attr-defined]
    utils = ModuleType("utils")
    utils.atomic_roundtrip_yaml_update = atomic_roundtrip_yaml_update  # type: ignore[attr-defined]
    with planted(
        {"hermes_cli": package("hermes_cli"), "hermes_cli.config": config, "utils": utils},
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

    def info(self):
        """`info`'s whole answer, read through the route a device reads it through."""
        app = wire(self, RouteAdapter())
        request = FakeWeb.Request()
        request.match_info, request.headers = {}, {}
        answer = asyncio.run(route(app, plugin.PREFIX + "/info")(request))
        self.assertEqual(answer["status"], 200)
        return answer

    def features(self):
        """`info`'s feature names, read through the route a device reads them through."""
        return self.info()["payload"]["features"]

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

    def test_the_profiles_this_connection_seats_answer_through_info(self):
        # The Host seats per connection, so its own roster is what a New room picker can hold a bot
        # to: a profile named here can be made a room with, and one it omits can only be refused.
        host = Host(seatable_profiles=("gotsfather", "ops"))
        with dispatcher(host), no_loopback():
            answer = self.info()
        self.assertIn("rooms", answer["payload"]["features"])
        self.assertEqual(answer["payload"]["rooms"], {"seatable": ["gotsfather", "ops"]})

    def test_a_host_that_names_no_seats_answers_none_so_the_app_filters_nothing(self):
        # `seatable_profiles` is a newer field: a Host from before it keeps the picker it had, and
        # its own refusal at create is still what a room its connection can't seat comes back as.
        host = Host(seatable_profiles=None)
        with dispatcher(host), no_loopback():
            answer = self.info()
        self.assertIn("rooms", answer["payload"]["features"])
        self.assertEqual(answer["payload"]["rooms"], {"seatable": None})

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
# The same two seats as the app spells them: a write's roster arrives in the app's words and leaves
# in the Host's, and the record it answers comes back in the app's (rooms.py's `_host_members`).
APP_ROSTER = [
    {"memberId": "m1", "profile": "default", "handle": "hermes"},
    {"memberId": "m2", "profile": "coder", "handle": "coder"},
]


class AskedUrl:
    """A request's URL, as the routes that mint an address read it: a path to rewrite, a query to set."""

    def __init__(self, path: str) -> None:
        self.path = path
        self.query = {}

    def with_path(self, path: str) -> "AskedUrl":
        rewritten = AskedUrl(path)
        rewritten.query = dict(self.query)
        return rewritten

    def with_query(self, query: dict) -> "AskedUrl":
        replaced = AskedUrl(self.path)
        replaced.query = dict(query)
        return replaced

    def __str__(self) -> str:
        said = urlencode(self.query)
        return f"http://host{self.path}" + (f"?{said}" if said else "")


def asked_route(
    case, path, *, method=None, room_id=None, body=None, unreadable=False, query=None, raw=None,
    headers=None, match=None, too_large=False, at=None, content_length=None, reads=None,
):
    request = FakeWeb.Request()
    request.headers = dict(headers or {})
    request.match_info = {"room_id": room_id} if room_id is not None else {}
    request.match_info.update(match or {})
    request.query = query or {}
    # What the request says its body weighs, as aiohttp's own read of the header does: a route can
    # refuse on it before any bytes are read.
    request.content_length = content_length
    sent = "{not json" if unreadable else ("" if body is None else json.dumps(body))
    # The path the request really arrived at: the route's own template with the match_info filled
    # in, or the mirrored address a /p/<profile> bot is served under. A route that signs an address
    # for a sibling rewrites it the way aiohttp would have handed it over.
    arrived = at or path
    if at is None:
        for key, value in request.match_info.items():
            arrived = arrived.replace("{" + key + "}", str(value))
    request.path = arrived
    request.url = AskedUrl(arrived)

    async def read():
        if unreadable:
            raise ValueError("Expecting value: line 1 column 1 (char 0)")
        return body

    async def text():
        return sent

    async def read_bytes():
        # A route that refuses a body on its declared length never asks for the bytes; ``reads`` is
        # how a test tells that apart from one that read them and refused them afterwards.
        if reads is not None:
            reads.append(path)
        if too_large:
            raise FakeWeb.HTTPRequestEntityTooLarge()
        return raw or b""

    request.json = read
    request.text = text
    request.read = read_bytes
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

    def created(self, members=APP_ROSTER, **extra):
        return self.asked(plugin.PREFIX + "/rooms", body={"room_id": "room-1", "name": "Planning", "members": members, **extra})

    def test_a_create_with_no_name_is_a_400_and_the_host_is_not_asked(self):
        host = Host()
        with dispatcher(host), no_loopback():
            answer = self.asked(
                plugin.PREFIX + "/rooms", body={"room_id": "room-1", "members": APP_ROSTER}
            )
        self.assertEqual(answer["status"], 400)
        self.assertEqual(answer["payload"], {"error": {"message": "A room needs a name."}})
        self.assertEqual(host.requests, [], "a room nothing can be titled by is not asked for")

    def test_a_room_is_created_with_the_id_the_app_minted(self):
        host = Host()
        with dispatcher(host), no_loopback():
            answer = self.created()
        self.assertEqual(answer["status"], 200)
        self.assertEqual(answer["payload"]["object"], "gots.room.record")
        # The answer is the chat list's entry, not the Host's room: one shape, and the app writes it.
        self.assertNotIn("room", answer["payload"])
        self.assertIsInstance(answer["payload"]["at"], int)
        self.assertEqual(answer["payload"]["value"]["title"], "Planning")
        self.assertEqual(answer["payload"]["value"]["room"]["id"], "room-1")
        self.assertEqual(answer["payload"]["value"]["room"]["members"], APP_ROSTER)
        self.assertEqual(
            host.requests[-1]["params"],
            {"room_id": "room-1", "name": "Planning", "members": ROSTER},
            "the room's id is the app's, and the roster reaches the Host in its own spelling",
        )

    def test_a_create_reads_the_roster_in_the_apps_words(self):
        """The wire speaks camelCase at both ends, and the Host hears its own spelling (ADR 0124)."""
        host = Host()
        with dispatcher(host), no_loopback():
            answer = self.created()
        self.assertEqual(host.requests[-1]["params"]["members"], ROSTER, "the Host hears its own spelling")
        self.assertEqual(
            answer["payload"]["value"]["room"]["members"],
            APP_ROSTER,
            "and the answer comes back in the app's",
        )

    def test_every_write_answers_the_rooms_record_not_the_hosts_room(self):
        """One vocabulary: the entry the chat list projects, whatever the write was (ADR 0123)."""
        writes = (
            ("create", lambda: self.asked(plugin.PREFIX + "/rooms", body={"room_id": "room-1", "name": "Planning", "members": APP_ROSTER})),
            ("rename", lambda: self.asked(plugin.PREFIX + "/rooms/{room_id}", room_id="room-1", method="POST", body={"event_id": "e1", "name": "Planning 2"})),
            ("disband", lambda: self.asked(plugin.PREFIX + "/rooms/{room_id}/disband", room_id="room-1", body={})),
        )
        for name, ask in writes:
            with self.subTest(name), dispatcher(Host()), no_loopback():
                answer = ask()
                payload = answer["payload"]
                self.assertEqual(payload["object"], "gots.room.record")
                self.assertIsInstance(payload["at"], int, "a record has a clock")
                self.assertNotIn("room", payload, "the Host's room object is not the answer")
                self.assertNotIn("tombstone", payload)

    def test_every_write_forgets_this_hosts_projection(self):
        """A Host's rooms are held for a breath, so a write leaves no answer saying what the room was.

        Without it a rename's or a disband's merge would land the older record over the newer one —
        the old name back, or the retired row back — until the entry expired (ADR 0123).
        """
        key = str(self.home)
        writes = (
            ("groups.create", lambda: rooms.create_room("room-1", "Planning", APP_ROSTER, home=self.home)),
            ("groups.rename", lambda: rooms.rename_room("room-1", "e1", "Planning 2", home=self.home)),
            ("groups.disband", lambda: rooms.disband_room("room-1", home=self.home)),
        )
        for method, invoke in writes:
            with self.subTest(method):
                rooms._projections[key] = rooms.Projection(rooms.time.monotonic(), {}, 60.0)
                with dispatcher(Host()), no_loopback():
                    invoke()
                self.assertNotIn(key, rooms._projections, "a write leaves this Host's projection to be read again")

    def test_a_rename_names_no_roster_where_the_host_names_none(self):
        """The record keeps this device's roster: an answer that seats nobody is not an empty room."""
        host = Host()
        with dispatcher(host), no_loopback():
            answer = self.asked(
                plugin.PREFIX + "/rooms/{room_id}", room_id="room-1", method="POST",
                body={"event_id": "e1", "name": "Planning 2"},
            )
        self.assertEqual(answer["status"], 200)
        self.assertNotIn("room", answer["payload"]["value"])

    def test_a_roster_under_two_is_the_hosts_refusal(self):
        self.assert_refused(ROSTER[:1], "members must contain between 2 and 6 entries")

    def test_a_roster_over_six_is_the_hosts_refusal(self):
        many = [
            {"memberId": f"m{n}", "profile": f"bot{n}", "handle": f"bot{n}"} for n in range(7)
        ]
        self.assert_refused(
            many,
            "members must contain between 2 and 6 entries",
            seatable=tuple(one["profile"] for one in many),
        )

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

    def assert_refused(self, members, message, *, seatable=None):
        """The roster reaches the Host as the app built it, and its refusal comes back as it said it."""
        host = Host(
            refuse="groups.create",
            refusal=(4110, message),
            **({} if seatable is None else {"seatable_profiles": seatable}),
        )
        with dispatcher(host), loopback(Loopback(host)) as client:
            answer = self.created(members)
        translated = [
            {"member_id": one["memberId"], **{key: value for key, value in one.items() if key != "memberId"}}
            if "memberId" in one
            else one
            for one in members
        ]
        self.assertEqual(
            host.requests[-1]["params"]["members"],
            translated,
            "the roster reaches the Host in its own spelling, and its refusal is its own words",
        )
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
        self.assertEqual(answer["payload"]["object"], "gots.room.record")
        self.assertEqual(answer["payload"]["value"]["title"], "Planning 2")
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
        self.assertEqual(answer["payload"]["object"], "gots.room.record")
        self.assertNotIn("tombstone", answer["payload"])
        self.assertTrue(answer["payload"]["deleted"], "a disband is the row going")
        self.assertEqual(answer["payload"]["at"], 1_760_000_000_000)
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
            set(client.homes),
            {self.home},
            "every ask a create makes is the request's profile's gateway",
        )


class RoomSeating(unittest.TestCase):
    """A create seats what its connection cannot, by adding it to this profile's own roster (ADR 0129)."""

    def setUp(self):
        self.home = temp_hermes_home(self)
        self.path = self.home / "config.yaml"

    def profile_dir(self, name):
        made = self.home / "profiles" / name
        made.mkdir(parents=True)
        return made

    def roster(self, *, seated=("default",)):
        """What this Host answers for its roster: its own bot, plus the entries the file holds."""

        def answer():
            try:
                held = json.loads(self.path.read_text())
            except (FileNotFoundError, ValueError):
                return list(seated)
            profiles = (held.get("hosted_rooms") or {}).get("profiles") or {}
            return [*seated, *profiles]

        return answer

    def created(self, host, members=APP_ROSTER):
        with dispatcher(host), config_store(self.path):
            return asked_route(
                self,
                plugin.PREFIX + "/rooms",
                body={"room_id": "room-1", "name": "Planning", "members": members},
            )

    def written(self):
        """The roster this profile's own file holds, as the Host would read it."""
        if not self.path.exists():
            return None
        return json.loads(self.path.read_text())

    def test_a_member_the_roster_misses_is_entered_and_the_room_is_made(self):
        seat = self.profile_dir("coder")
        host = Host(seatable_profiles=self.roster())
        answer = self.created(host)
        self.assertEqual(answer["status"], 200)
        self.assertEqual(answer["payload"]["seated"], ["coder"], "the room says what it seated")
        self.assertEqual(
            self.written()["hosted_rooms"]["profiles"]["coder"],
            str(seat),
            "and this profile's own roster names the home beside its own",
        )
        self.assertIn("groups.create", [one["method"] for one in host.requests])

    def test_a_profile_that_is_not_a_directory_beside_this_one_is_refused(self):
        host = Host(seatable_profiles=self.roster())
        answer = self.created(host)
        self.assertEqual(answer["status"], 400)
        self.assertIn("coder", answer["payload"]["error"]["message"])
        self.assertIsNone(self.written(), "nothing is written for a home the Host would ignore")
        self.assertNotIn("groups.create", [one["method"] for one in host.requests])

    def test_a_symlinked_profile_is_refused(self):
        real = self.home / "elsewhere"
        real.mkdir()
        (self.home / "profiles").mkdir()
        (self.home / "profiles" / "coder").symlink_to(real, target_is_directory=True)
        host = Host(seatable_profiles=self.roster())
        answer = self.created(host)
        self.assertEqual(answer["status"], 400)
        self.assertIn("coder", answer["payload"]["error"]["message"])
        self.assertIsNone(self.written(), "a linked home is one the Host cannot reach under that name")

    def test_a_name_the_host_never_seats_is_refused_before_anything_is_written(self):
        member = {**APP_ROSTER[1], "profile": "my-bot", "handle": "my-bot"}
        host = Host(seatable_profiles=self.roster())
        answer = self.created(host, members=[APP_ROSTER[0], member])
        self.assertEqual(answer["status"], 400)
        self.assertIn("my-bot", answer["payload"]["error"]["message"])
        self.assertIsNone(self.written())

    def test_a_home_already_seated_under_another_name_is_refused(self):
        seat = self.profile_dir("coder")
        self.path.write_text(json.dumps({"hosted_rooms": {"profiles": {"other": str(seat)}}}))
        host = Host(seatable_profiles=self.roster())
        answer = self.created(host)
        self.assertEqual(answer["status"], 400)
        self.assertIn("already seated here as 'other'", answer["payload"]["error"]["message"])
        self.assertEqual(
            list(self.written()["hosted_rooms"]["profiles"]), ["other"], "and the file is left alone"
        )

    def test_a_config_this_bot_cannot_read_is_a_refusal_not_an_empty_one(self):
        self.profile_dir("coder")
        self.path.write_text("{not a mapping")
        host = Host(seatable_profiles=self.roster())
        answer = self.created(host)
        self.assertEqual(answer["status"], 400)
        self.assertIn("couldn't read", answer["payload"]["error"]["message"])
        self.assertEqual(self.path.read_text(), "{not a mapping", "a file nobody read is not replaced")

    def test_a_host_that_names_no_roster_writes_nothing_and_makes_the_room(self):
        self.profile_dir("coder")
        host = Host(seatable_profiles=None)
        answer = self.created(host)
        self.assertEqual(answer["status"], 200)
        self.assertNotIn("seated", answer["payload"], "nothing was added, so nothing is said")
        self.assertIsNone(self.written(), "no roster is no rule, not an empty one")

    def test_a_second_create_writes_nothing_new(self):
        self.profile_dir("coder")
        host = Host(seatable_profiles=self.roster())
        self.created(host)
        before = self.path.read_bytes()
        again = self.created(host)
        self.assertEqual(again["status"], 200)
        self.assertNotIn("seated", again["payload"])
        self.assertEqual(self.path.read_bytes(), before, "a roster already seating them is left alone")


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

    def test_a_send_with_neither_words_nor_files_is_the_seams_400_and_the_host_is_not_asked(self):
        # "Words or files" is one rule about one value, so it lives where the manifest is typed
        # rather than in the route, which can only see that the value is truthy.
        host = Host(events=CONVERSATION)
        with dispatcher(host), no_loopback():
            answer = self.send({"event_id": "e9", "text": "   "})
        self.assertEqual(answer["status"], 400)
        self.assertEqual(
            answer["payload"], {"error": {"message": "A message needs words or files to send."}}
        )
        self.assertEqual(host.sends, [], "nothing to send is refused before the Host is asked")

    def test_a_send_whose_attachments_are_not_a_list_is_the_manifests_400(self):
        # A string is truthy, so only the manifest can say that it names no files at all.
        host = Host(events=CONVERSATION)
        with dispatcher(host), no_loopback():
            answer = self.send({"event_id": "e9", "text": "", "attachments": "pixel.png"})
        self.assertEqual(answer["status"], 400)
        self.assertEqual(
            answer["payload"]["error"]["message"], "A message's attachments are the files it carries."
        )
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


PIXEL = b"\x89PNG\r\n\x1a\n" + b"one pixel"
NOTES = b"the minutes\n"


class RoomMedia(unittest.TestCase):
    """A room's file: the Host's own attachment store, the manifest a message names, and the signed
    address the app draws it through (F5).

    The bytes live in one place — the Host's room attachment store — so the plugin's part is to hand
    them over on upload, to put the manifest a message carries in the Host's own field names, and to
    answer the bytes back through an address it signed without asking the Host to mint one.
    """

    def setUp(self):
        self.home = temp_hermes_home(self)

    def asked(self, path, *, room_id=None, method=None, body=None, query=None, raw=None,
              headers=None, match=None, too_large=False, at=None, content_length=None, reads=None):
        return asked_route(
            self, path, method=method, room_id=room_id, body=body, query=query, raw=raw,
            headers=headers, match=match, too_large=too_large, at=at,
            content_length=content_length, reads=reads,
        )

    def upload(self, data=PIXEL, *, name="pixel.png", mime="image/png", upload_id="up-1",
               room_id="room-1", too_large=False, content_length=None, reads=None):
        return self.asked(
            plugin.PREFIX + "/rooms/{room_id}/attachment", room_id=room_id,
            query={"upload_id": upload_id, "name": name}, headers={"content-type": mime},
            raw=data, too_large=too_large, content_length=content_length, reads=reads,
        )

    def send(self, body):
        return self.asked(plugin.PREFIX + "/rooms/{room_id}/send", room_id="room-1", body=body)

    def mint(self, attachment_id, *, event_id="e1"):
        return self.asked(
            plugin.PREFIX + "/rooms/{room_id}/attachment/url", room_id="room-1",
            body={"event_id": event_id, "attachment_id": attachment_id},
        )

    def served(self, attachment_id, token, *, event_id="e1"):
        return self.asked(
            plugin.PREFIX + "/rooms/{room_id}/attachment/{attachment_id}", room_id="room-1",
            match={"attachment_id": attachment_id}, method="GET",
            query={"event": event_id, media.URL_PARAM: token},
        )

    def features(self):
        app = wire(self, RouteAdapter())
        request = FakeWeb.Request()
        request.match_info, request.headers = {}, {}
        answer = asyncio.run(route(app, plugin.PREFIX + "/info")(request))
        return answer["payload"]["features"]

    def test_a_file_is_uploaded_against_the_apps_upload_id_and_answered_as_the_manifest_a_message_names(self):
        host = Host()
        with dispatcher(host), no_loopback():
            answer = self.upload()
        self.assertEqual(answer["status"], 200)
        self.assertEqual(answer["payload"]["object"], "gots.room.attachment")
        (attachment_id,) = host.blobs
        self.assertEqual(
            answer["payload"]["attachment"],
            {"attachmentId": attachment_id, "kind": "image", "name": "pixel.png",
             "size": len(PIXEL), "mime": "image/png"},
            "the manifest in the app's own words, since that is what the message sends back",
        )
        self.assertEqual(
            host.uploads,
            [{"room_id": "room-1", "upload_id": "up-1", "kind": "image", "name": "pixel.png",
              "mime": "image/png", "data_base64": base64.b64encode(PIXEL).decode("ascii")}],
            "the bytes go to the Host's own store, under the upload id the app minted for them",
        )

    def test_the_kind_is_read_from_the_mime_the_file_arrived_with(self):
        host = Host()
        asked = [
            (PIXEL, "pixel.png", "image/png"),
            (b"%PDF-1.7 the minutes", "minutes.pdf", "application/pdf"),
            (NOTES, "notes.txt", "text/plain"),
        ]
        with dispatcher(host), no_loopback():
            kinds = [
                self.upload(data, name=name, mime=mime, upload_id=f"up-{n}")["payload"]["attachment"]["kind"]
                for n, (data, name, mime) in enumerate(asked)
            ]
        self.assertEqual(kinds, ["image", "pdf", "file"])
        self.assertEqual([one["kind"] for one in host.uploads], ["image", "pdf", "file"],
                         "the Host's three kinds, since it stores one and reads it back")

    def test_a_file_over_a_rooms_limit_is_a_413_that_names_it_and_the_host_is_not_asked(self):
        host = Host()
        with dispatcher(host), no_loopback():
            answer = self.upload(
                b"x" * (rooms.ROOM_FILE_BYTES + 1), name="huge.bin", mime="application/octet-stream"
            )
            refused = self.upload(name="huge.bin", too_large=True)
        named = rooms.ROOM_FILE_BYTES // (1024 * 1024)
        for one in (answer, refused):
            self.assertEqual(one["status"], 413)
            self.assertIn("huge.bin", one["payload"]["error"]["message"])
            self.assertIn(f"{named} MB", one["payload"]["error"]["message"],
                          "a refusal that names the limit, never \"too large\" on its own")
        self.assertEqual(host.uploads, [], "a file the room can't hold never reaches its store")

    def test_a_body_that_declares_itself_over_the_limit_is_a_413_before_a_byte_is_read(self):
        # The request says how much it carries, so a file the room can't hold is refused on that
        # number: the bytes never enter this process to be measured and then dropped.
        host = Host()
        reads = []
        with dispatcher(host), no_loopback():
            answer = self.upload(
                b"", name="huge.bin", mime="application/octet-stream",
                content_length=rooms.ROOM_FILE_BYTES + 1, reads=reads,
            )
        self.assertEqual(answer["status"], 413)
        self.assertIn("huge.bin", answer["payload"]["error"]["message"])
        self.assertIn(
            f"{rooms.ROOM_FILE_BYTES // (1024 * 1024)} MB", answer["payload"]["error"]["message"],
            "the refusal names the room's own limit, not the server's",
        )
        self.assertEqual(reads, [], "a declared body past the limit is refused unread")
        self.assertEqual(host.uploads, [])

    def test_a_body_the_server_refuses_is_still_the_rooms_limit_said_in_its_words(self):
        # The second line of defence: a body whose length arrived in pieces is refused by the
        # server's own cap, and the sentence is still the one the user can act on.
        host = Host()
        with dispatcher(host), no_loopback():
            answer = self.upload(name="huge.bin", mime="application/octet-stream", too_large=True)
        self.assertEqual(answer["status"], 413)
        self.assertEqual(answer["payload"]["error"]["message"], rooms.too_large("huge.bin"))
        self.assertEqual(host.uploads, [])

    def test_a_rooms_refusal_is_the_media_sentence_said_about_a_room_attachment(self):
        # One sentence, one owner: the room names the noun and its own cap, and ``media`` writes it.
        self.assertEqual(
            rooms.too_large("huge.bin"),
            "huge.bin is larger than the 9 MB limit for a room attachment.",
        )
        self.assertEqual(
            rooms.too_large("huge.bin"),
            media.too_large_for("huge.bin", "a room attachment", rooms.ROOM_FILE_BYTES),
        )

    def test_an_empty_file_is_a_400(self):
        host = Host()
        with dispatcher(host), no_loopback():
            answer = self.upload(b"")
        self.assertEqual(answer["status"], 400)
        self.assertEqual(answer["payload"], {"error": {"message": "The file is empty."}})
        self.assertEqual(host.uploads, [])

    def test_a_send_carries_the_manifest_in_the_hosts_own_field_names_and_empty_words_are_allowed_with_one(self):
        host = Host(events=CONVERSATION)
        with dispatcher(host), no_loopback():
            manifest = self.upload()["payload"]["attachment"]
            answer = self.send({"event_id": "e9", "text": "", "attachments": [manifest]})
        self.assertEqual(answer["status"], 200)
        self.assertEqual(
            host.sends,
            [{"room_id": "room-1", "event_id": "e9",
              "payload": {"text": "", "thread_id": "e9", "attachments": [
                  {"attachment_id": manifest["attachmentId"], "kind": "image",
                   "name": "pixel.png", "size": len(PIXEL), "mime": "image/png"}]}}],
            "the Host's own manifest names on the thread the message opens, and words may be empty",
        )
        self.assertEqual(answer["payload"]["event"]["attachments"], [manifest],
                         "and the row it comes back as draws the file the app uploaded")

    def test_a_manifest_a_room_could_not_take_is_a_400_and_the_host_is_not_asked(self):
        one = {"attachmentId": "att_00000000000000000000000000000001", "kind": "image",
               "name": "pixel.png", "size": 4, "mime": "image/png"}
        host = Host(events=CONVERSATION)
        with dispatcher(host), no_loopback():
            answers = [
                self.send({"event_id": "e9", "text": "", "attachments": [one, one]}),
                self.send({"event_id": "e9", "text": "", "attachments": [{**one, "kind": "clip"}]}),
                self.send({"event_id": "e9", "text": "", "attachments": [one] * 9}),
                self.send({"event_id": "e9", "text": "", "attachments": [{**one, "size": 0}]}),
            ]
        self.assertEqual([one["status"] for one in answers], [400] * 4,
                         "an id twice, a kind the Host has none of, a ninth file and a file of no size")
        for answer in answers:
            self.assertIn("attachment", answer["payload"]["error"]["message"].lower(),
                          "refused for the manifest, not for having no words with it")
        self.assertEqual(host.sends, [])

    def test_a_read_draws_a_members_own_attachments_on_its_row_and_a_row_with_none_carries_no_key(self):
        theirs = {"attachment_id": "att_0000000000000000000000000000000b", "kind": "pdf",
                  "name": "minutes.pdf", "size": len(b"%PDF-1.7 the minutes"), "mime": "application/pdf"}
        rows = [
            event(1, "message.user", USER, {"text": "", "thread_id": "e1", "attachments": [
                {"attachment_id": "att_0000000000000000000000000000000a", "kind": "image",
                 "name": "pixel.png", "size": len(PIXEL), "mime": "image/png"}]}),
            event(2, "message.member", MEMBER, {"text": "here it is", "member_id": "m1",
                                                "thread_id": "e1", "attachments": [theirs]}),
            event(3, "message.user", USER, {"text": "thanks", "thread_id": "e1"}),
            event(4, "message.member", MEMBER, {"text": "any time", "member_id": "m1",
                                                "thread_id": "e1",
                                                "attachments": [{"attachment_id": "", "kind": "image"}]}),
        ]
        host = Host(events=rows)
        with dispatcher(host), no_loopback():
            drawn = self.asked(plugin.PREFIX + "/rooms/{room_id}", room_id="room-1", method="GET")
        events_drawn = drawn["payload"]["events"]
        self.assertEqual(
            events_drawn[0]["attachments"],
            [{"attachmentId": "att_0000000000000000000000000000000a", "kind": "image",
              "name": "pixel.png", "size": len(PIXEL), "mime": "image/png"}],
            "the user's own file, in the words the manifest is drawn in",
        )
        self.assertEqual(
            events_drawn[1]["attachments"],
            [{"attachmentId": theirs["attachment_id"], "kind": "pdf", "name": "minutes.pdf",
              "size": theirs["size"], "mime": "application/pdf"}],
            "and a member's file on the member's row",
        )
        self.assertNotIn("attachments", events_drawn[2], "a row with no file carries no key to draw")
        self.assertNotIn("attachments", events_drawn[3], "and a malformed entry draws nothing either")

    def test_a_file_of_a_kind_the_host_has_no_case_for_still_draws_on_its_row(self):
        # A member's reply can carry one file and no words: a row whose only file was dropped is a
        # row with neither, which the app folds away — so an unknown kind draws as a file.
        clip = {"attachment_id": "att_0000000000000000000000000000000c", "kind": "audio",
                "name": "clip.m4a", "size": 2048, "mime": "audio/mp4"}
        host = Host(events=[event(1, "message.member", MEMBER, {
            "text": "", "member_id": "m1", "thread_id": "e1", "attachments": [clip]})])
        with dispatcher(host), no_loopback():
            drawn = self.asked(plugin.PREFIX + "/rooms/{room_id}", room_id="room-1", method="GET")
        rows = drawn["payload"]["events"]
        self.assertEqual(len(rows), 1, "the row is still drawn, with the file it carried")
        self.assertEqual(
            rows[0]["attachments"],
            [{"attachmentId": clip["attachment_id"], "kind": "file", "name": "clip.m4a",
              "size": 2048, "mime": "audio/mp4"}],
            "a kind the Host has no case for is drawn as the file it is",
        )

    def test_a_signed_address_is_minted_for_one_attachment_and_its_own_route_answers_the_bytes(self):
        host = Host()
        with dispatcher(host), no_loopback():
            manifest = self.upload()["payload"]["attachment"]
            minted = self.mint(manifest["attachmentId"])
            self.assertEqual(minted["status"], 200)
            self.assertEqual(minted["payload"]["object"], "gots.room.attachment_url")
            path = rooms.attachment_path("room-1", "e1", manifest["attachmentId"])
            self.assertEqual(minted["payload"]["path"], path)
            self.assertIsInstance(minted["payload"]["expires"], int)
            # The URL the app is handed is the route beside the mint, without the `/url`.
            url = urlsplit(minted["payload"]["url"])
            self.assertEqual(
                url.path, plugin.PREFIX + f"/rooms/room-1/attachment/{manifest['attachmentId']}"
            )
            signed = parse_qs(url.query)
            self.assertEqual(signed["event"], ["e1"])
            served = self.served(manifest["attachmentId"], signed[media.URL_PARAM][0])
        self.assertEqual(served.status, 200)
        self.assertEqual(served.body, PIXEL, "the bytes the Host stored, served as they are")
        self.assertEqual(served.headers["content-type"], "image/png")
        self.assertEqual(served.headers["accept-ranges"], "none")
        self.assertNotIn("content-disposition", served.headers, "a picture is shown rather than saved")
        self.assertEqual(
            host.downloads,
            [{"room_id": "room-1", "event_id": "e1", "attachment_id": manifest["attachmentId"]}],
            "the read behind the address is the Host's own, for the event the file was committed under",
        )

    def test_a_minted_address_keeps_the_profile_a_bot_is_served_under(self):
        # A multiplexed bot's routes are mirrored at /p/<profile>: a mint rewritten from the plugin's
        # own prefix would hand the app an address its own gateway doesn't serve.
        host = Host()
        with dispatcher(host), no_loopback():
            manifest = self.upload()["payload"]["attachment"]
            minted = self.asked(
                plugin.PREFIX + "/rooms/{room_id}/attachment/url", room_id="room-1",
                body={"event_id": "e1", "attachment_id": manifest["attachmentId"]},
                at=f"/p/coder{plugin.PREFIX}/rooms/room-1/attachment/url",
            )
        url = urlsplit(minted["payload"]["url"])
        self.assertEqual(
            url.path, f"/p/coder{plugin.PREFIX}/rooms/room-1/attachment/{manifest['attachmentId']}"
        )

    def test_a_room_file_the_platform_cannot_show_is_served_as_a_download_named_as_it_is(self):
        host = Host()
        with dispatcher(host), no_loopback():
            manifest = self.upload(
                b"\x00\x01", name="room.bin", mime="application/octet-stream", upload_id="up-2"
            )["payload"]["attachment"]
            token, _ = media.mint(
                media.signing_key(store.current_path()),
                rooms.attachment_path("room-1", "e1", manifest["attachmentId"]), "",
            )
            served = self.served(manifest["attachmentId"], token)
        self.assertEqual(served.status, 200)
        self.assertEqual(
            served.headers["content-disposition"],
            "attachment; filename=\"room.bin\"; filename*=UTF-8''room.bin",
            "a file nothing here paints is handed over under the name the Host stored",
        )

    def test_a_rooms_file_is_served_under_its_own_names_type_a_private_cache_and_the_hosts_digest(self):
        # A browser that already drew this picture keeps it for the address's own minutes, and the
        # Host's digest is what says its copy is still these bytes — so a gallery cell redrawn costs
        # no second download. The type is read from the name, since the uploader's is only a claim.
        host = Host()
        with dispatcher(host), no_loopback():
            manifest = self.upload(mime="application/octet-stream")["payload"]["attachment"]
            token, _ = media.mint(
                media.signing_key(store.current_path()),
                rooms.attachment_path("room-1", "e1", manifest["attachmentId"]), "",
            )
            served = self.served(manifest["attachmentId"], token)
        self.assertEqual(served.status, 200)
        self.assertEqual(served.headers["content-type"], "image/png",
                         "the name says what it is, whatever type it was uploaded as")
        self.assertEqual(served.headers["cache-control"], f"private, max-age={media.URL_LIFETIME_S}")
        self.assertEqual(served.headers["etag"], f'"{hashlib.sha256(PIXEL).hexdigest()}"')
        self.assertEqual(served.headers["x-content-type-options"], "nosniff")

    def test_a_host_that_refuses_an_upload_answers_in_its_own_words_and_is_not_asked_again(self):
        host = Host(refuse="groups.attachment.upload",
                    refusal=(4210, "This room's store is full."))
        with dispatcher(host), loopback(Loopback(host)) as client:
            answer = self.upload()
        self.assertEqual(answer["status"], 400)
        self.assertEqual(
            answer["payload"], {"error": {"message": "This room's store is full."}}
        )
        self.assertEqual(client.methods, [], "a refusal is an answer, so it is never repeated")

    def test_a_forged_or_spent_address_is_a_403_and_the_host_is_not_asked(self):
        host = Host()
        with dispatcher(host), no_loopback():
            manifest = self.upload()["payload"]["attachment"]
            path = rooms.attachment_path("room-1", "e1", manifest["attachmentId"])
            spent, _ = media.mint(media.signing_key(store.current_path()), path, "", lifetime=-10)
            answers = [
                self.served(manifest["attachmentId"], "1234567890.deadbeef"),
                self.served(manifest["attachmentId"], spent),
            ]
        for answer in answers:
            self.assertEqual(answer["status"], 403)
            self.assertEqual(answer["payload"], {"error": {"message": "That address has run out."}})
        self.assertEqual(host.downloads, [], "an address that doesn't cover the file reads no bytes")

    def test_a_host_that_refuses_a_download_answers_in_its_own_words(self):
        host = Host(refuse="groups.attachment.download",
                    refusal=(4217, "This attachment is no longer in the room."))
        with dispatcher(host), no_loopback():
            manifest = self.upload()["payload"]["attachment"]
            token, _ = media.mint(
                media.signing_key(store.current_path()),
                rooms.attachment_path("room-1", "e1", manifest["attachmentId"]), "",
            )
            answer = self.served(manifest["attachmentId"], token)
        self.assertEqual(answer["status"], 400)
        self.assertEqual(
            answer["payload"], {"error": {"message": "This attachment is no longer in the room."}}
        )

    def test_room_media_is_advertised_only_where_the_host_declares_both_attachment_methods(self):
        reads = ["groups.capabilities", "groups.list", "groups.state", "groups.log"]
        with dispatcher(Host(methods=reads)), no_loopback():
            self.assertNotIn("room_media", self.features(), "a Host with no store takes no file")
        with dispatcher(Host(methods=[*reads, "groups.attachment.upload"])), no_loopback():
            self.assertNotIn("room_media", self.features(),
                             "half a store is a file uploaded and never drawn back")
        with dispatcher(Host(methods=[*reads, *rooms.ATTACHMENT_METHODS])), no_loopback():
            features = self.features()
        self.assertIn("rooms", features)
        self.assertIn("room_media", features, "a Host with both takes a file and gives it back")


class RoomPushes(unittest.TestCase):
    """A room that starts needing the user is pushed once, and not again until its wait ends (F6).

    What makes a room need the user is the room's own: an approval the Host holds pending, a
    question the plugin holds for a member's turn, or a member's reply that ends addressed to
    `@user`. A member's reply alone is not news, a room that is still waiting is not news twice, and
    a room the user has answered is armed again. The watcher's tick is the backstop for a transition
    no hook fired.
    """

    def setUp(self):
        self.home = temp_hermes_home(self)
        store.connect(store.db_path(self.home)).close()
        with rooms._questions_lock:
            rooms._questions.clear()
        with rooms._waiting_lock:
            rooms._waiting_rooms.clear()
        rooms._cursors.clear()
        rooms._noted.clear()
        self.told = []
        patches = [
            mock.patch.object(push, "reachable", lambda path: True),
            mock.patch.object(
                push,
                "notify",
                lambda kind, session_id, path=None, title=None: self.told.append(
                    (kind, session_id, title)
                )
                or True,
            ),
        ]
        for one in patches:
            one.start()
            self.addCleanup(one.stop)

    def test_a_push_nothing_took_leaves_the_room_for_the_next_pass(self):
        host = self.host(waiting=True)
        with mock.patch.object(rooms.push, "notify", lambda *args, **kwargs: False):
            self.assertEqual(self.check(host), 0, "a push the throttle dropped is no push")
        self.assertEqual(self.check(host), 1, "so the wait is still a transition the next pass pushes")
        self.assertEqual(len(self.told), 1)

    def host(self, *, waiting=False, events=(), listed=(ROOM,)):
        """A Host with one room, at rest or holding the approval m1 waits on."""
        status = {
            "running": True, "working": waiting, "blocked": waiting, "counts": {},
            "pending_actions": [APPROVAL] if waiting else [], "member_activity": [],
            "peer_routes": [],
        }
        return Host(
            listed=list(listed),
            driver_status=status,
            events=list(events),
            states={"room-1": {**ROOM, "latest_seq": len(events)}},
        )

    def check(self, host):
        with dispatcher(host), no_loopback():
            return rooms.check(self.home)

    def test_a_room_that_starts_waiting_is_pushed_once(self):
        host = self.host()
        self.assertEqual(self.check(host), 0, "a room at rest is no news")
        self.assertEqual(self.told, [])
        host.driver_status["pending_actions"] = [APPROVAL]
        self.assertEqual(self.check(host), 1)
        self.assertEqual(
            self.told,
            [("room_input", "room-1", "Planning")],
            "the push names the room's own id, which is what the app matches it by",
        )
        self.assertEqual(self.check(host), 0, "the same wait is not news twice")
        self.assertEqual(len(self.told), 1)

    def test_a_members_reply_is_not_news(self):
        conversation = [
            event(1, "message.user", USER, {"text": "who is free?"}),
            event(2, "message.member", MEMBER, {"text": "me", "thread_id": "e1"}),
        ]
        host = self.host(events=conversation)
        self.assertEqual(self.check(host), 0)
        conversation.append(event(3, "message.member", MEMBER, {"text": "and the routes"}))
        self.assertEqual(self.check(host), 0, "a member answering is the room working, not asking")

    def test_a_reply_that_ends_addressed_to_the_user_is_a_wait(self):
        conversation = [
            event(1, "message.user", USER, {"text": "go"}),
            event(2, "message.member", MEMBER, {"text": "That one is yours, @user."}),
            event(3, "room.activity", {"kind": "gateway", "id": "gw-1"}, {"status": "settled"}),
        ]
        host = self.host(events=conversation)
        self.assertEqual(self.check(host), 1, "the round settled on the user, so the room waits")
        self.assertEqual(self.told, [("room_input", "room-1", "Planning")])
        self.assertEqual(self.check(host), 0)

    def test_a_users_own_words_answer_the_mention(self):
        conversation = [
            event(1, "message.member", MEMBER, {"text": "yours, @user"}),
            event(2, "message.user", USER, {"text": "so it is"}),
        ]
        host = self.host(events=conversation)
        self.assertEqual(self.check(host), 0)

    def test_a_users_words_answer_the_mention_and_a_new_one_is_news(self):
        host = self.host(events=[event(1, "message.member", MEMBER, {"text": "yours, @user"})])
        self.assertEqual(self.check(host), 1)
        host.events.append(event(2, "message.user", USER, {"text": "mine to call"}))
        host.states["room-1"]["latest_seq"] = 2
        self.assertEqual(self.check(host), 0, "the user answered it, and nothing new waits")
        host.events.append(event(3, "message.member", MEMBER, {"text": "and this one, @user"}))
        host.states["room-1"]["latest_seq"] = 3
        self.assertEqual(self.check(host), 1, "a second mention is a second wait")

    def test_answering_one_of_two_waits_does_not_push_the_other_again(self):
        host = self.host(waiting=True)
        rooms.hold_question("room-1", "m2", "srq-1", [QUESTION])
        self.assertEqual(self.check(host), 1, "one push for the room, however many waits it holds")
        with dispatcher(host), no_loopback(), answerable([]):
            answered = asked_route(
                self, plugin.PREFIX + "/rooms/{room_id}/answer", room_id="room-1",
                body={"member_id": "m2", "question_id": "srq-1", "answers": {"q0": "Postgres"}},
            )
        self.assertEqual(answered["status"], 200)
        self.assertEqual(self.check(host), 0, "the approval was announced, and is still waiting")
        host.driver_status["pending_actions"] = [{**APPROVAL, "request_id": "approval-2"}]
        self.assertEqual(self.check(host), 1, "a wait the room has never announced is news")

    def test_a_list_longer_than_one_pass_is_read_across_passes(self):
        listed = [
            {"room_id": f"room-{n}", "name": f"R{n}", "members": ROOM["members"]}
            for n in (1, 2, 3)
        ]
        host = Host(listed=listed, page=1, driver_status={
            "running": True, "working": True, "blocked": False, "counts": {},
            "pending_actions": [APPROVAL], "member_activity": [], "peer_routes": [],
        })
        with mock.patch.object(rooms, "MAX_ROOM_PAGES", 1), dispatcher(host), no_loopback():
            for _ in range(3):
                self.assertEqual(rooms.check(self.home), 1)
        self.assertEqual(
            self.told,
            [("room_input", "room-1", "R1"), ("room_input", "room-2", "R2"), ("room_input", "room-3", "R3")],
            "each pass starts where the last one stopped, rather than at the head for ever",
        )

    def test_the_watcher_passes_over_every_served_home(self):
        with dispatcher(self.host(waiting=True)), no_loopback():
            rooms._pass(SimpleNamespace())
        self.assertEqual(len(self.told), 1, "the loop the server runs is the pass itself")

    def test_a_question_the_hook_held_is_a_wait(self):
        host = self.host()
        rooms.hold_question("room-1", "m2", "srq-1", [QUESTION])
        self.assertEqual(self.check(host), 1)
        self.assertEqual(self.told, [("room_input", "room-1", "Planning")])

    def test_the_answer_arms_the_room_for_the_next_wait(self):
        host = self.host()
        rooms.hold_question("room-1", "m2", "srq-1", [QUESTION])
        self.assertEqual(self.check(host), 1)
        with dispatcher(host), no_loopback(), answerable([]):
            self.assertEqual(self.answer()["status"], 200)
        # The room asks again before the next tick: a mark left alone would swallow the second wait.
        rooms.hold_question("room-1", "m2", "srq-2", [QUESTION])
        self.assertEqual(self.check(host), 1)
        self.assertEqual(len(self.told), 2)

    def answer(self):
        return asked_route(
            self, plugin.PREFIX + "/rooms/{room_id}/answer", room_id="room-1",
            body={"member_id": "m2", "question_id": "srq-1", "answers": {"q0": "Postgres"}},
        )

    def test_a_room_that_is_gone_is_not_waited_on(self):
        host = self.host(waiting=True)
        self.assertEqual(self.check(host), 1)
        host.listed = [{**ROOM, "disbanded_at": 1_760_001_000.0}]
        self.assertEqual(self.check(host), 0)
        host.listed = [ROOM]
        self.assertEqual(self.check(host), 1, "the room the Host lists again is a wait again")

    def test_the_hosts_own_approval_wakes_the_watcher(self):
        with mock.patch.object(rooms._ticker, "wake") as wake:
            rooms.on_member_activity(room_id="room-1", kind="request.opened", member_id="m1",
                                     payload={"request_id": "approval-1", "kind": "approval"})
        wake.assert_called_once()

    def test_a_question_wakes_the_watcher(self):
        with mock.patch.object(rooms._ticker, "wake") as wake:
            rooms.on_member_activity(
                room_id="room-1", kind="request.opened", member_id="m1",
                payload={"request_id": "srq-1", "questions": [QUESTION]},
            )
        wake.assert_called_once()

    def test_a_members_delta_does_not_wake_the_watcher(self):
        with mock.patch.object(rooms._ticker, "wake") as wake:
            rooms.on_member_activity(room_id="room-1", kind="message.delta", member_id="m1",
                                     payload={"delta": "working"})
        wake.assert_not_called()


if __name__ == "__main__":
    unittest.main()
