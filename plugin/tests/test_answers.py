"""An approval answered from the tray's own buttons: once, and only for what its row names.

A button is a bearer credential in a URL — whoever holds it allows one command — so the token names
nothing at all: the row it redeems says which run or which room member, and which choice. Two tokens
are minted for one approval, Allow once and Deny, kept hashed and expiring with the push that carries
them, and a press past either is a press that answers nothing.

Run: python3 -m unittest plugin.tests.test_answers -v
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
import sys
import tempfile
import time
import types
import unittest
from pathlib import Path
from typing import Any, Dict, List, Optional
from unittest import mock

import plugin
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

from plugin import answers, approvals, device_keys, link, ntfy, push, rooms, store
from plugin.store import connect, db_path
from plugin.tests._helpers import FakeWeb, RouteAdapter, route, temp_hermes_home, wire

# The address the app dialled this bot at, as `POST push` keeps it: the host, the profile a bot at
# /p/<profile> is, and the plugin's own prefix. A button posts back to the same one.
BASE = "https://bot.example/p/penny/api/plugins/gots"
# A phone's public key, as one hands it over (`POST push/key`).
PHONE_KEY = push._b64(
    ec.generate_private_key(ec.SECP256R1())
    .public_key()
    .public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
)
ANSWER = plugin.PREFIX + "/push/answer/{token}"

# A room member's approval, as `rooms.waiting` draws it: the Host's own request and the generation
# its turn is in, which is what the Host resolves the answer against.
ROOM_WAIT = {
    "kind": "approval",
    "id": "approval:req-9",
    "memberId": "m2",
    "taskId": "t1",
    "generation": 3,
    "requestId": "req-9",
    "command": "rm -rf ./build",
    "description": "Clear the build",
}


def tokens(path: Path) -> List[tuple]:
    """Every row the buttons were minted under: the hash, the choice and the instant it is spent."""
    conn = connect(path)
    try:
        return conn.execute(
            "SELECT token, choice, used_at FROM answer_tokens ORDER BY choice"
        ).fetchall()
    finally:
        conn.close()


class RunBook:
    """The API server's own run book, as `approvals.announce` reads and writes it."""

    def __init__(self) -> None:
        self._run_statuses: Dict[str, Dict[str, Any]] = {
            "run_1": {
                "status": approvals.WAITING,
                "session_id": "gots-1",
                "approval": {"request_id": "r1"},
            }
        }
        self._run_streams: Dict[str, Any] = {}
        self.settled: List[tuple] = []

    def _set_run_status(self, run_id: str, status: str, **fields: Any) -> None:
        self.settled.append((run_id, status))
        current = self._run_statuses.setdefault(run_id, {})
        current.update({"status": status, **fields})
        if status != approvals.WAITING:
            current.pop("approval", None)


class Tray(unittest.TestCase):
    """A profile that knows its own address, and one run waiting on an approval.

    Hermes's own modules are planted the way `test_token_scope` plants them: ``tools.approval`` stands
    in for its queue, so a press is checked by what it asked the queue and the run book rather than by
    a run that would have to be really waiting, and ``approvals.adapter`` by the run book a press
    leaves settled.
    """

    def setUp(self) -> None:
        self.home = temp_hermes_home(self)
        self.path = db_path(self.home)
        self.book = RunBook()
        self.resolved: List[tuple] = []
        approval = types.ModuleType("tools.approval")
        approval.list_gateway_approvals = lambda run_id: []  # type: ignore[attr-defined]
        approval.resolve_gateway_approval = self._resolve  # type: ignore[attr-defined]
        tools = types.ModuleType("tools")
        tools.approval = approval  # type: ignore[attr-defined]
        for patcher in (
            mock.patch.dict(sys.modules, {"tools": tools, "tools.approval": approval}),
            mock.patch.object(approvals.events, "note"),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.app = wire(self, RouteAdapter())
        # After the wiring, since registering the routes points `approvals.adapter` at the server's
        # own adapter: the run book is what a press is read back from.
        held = mock.patch.object(approvals, "adapter", self.book)
        held.start()
        self.addCleanup(held.stop)
        # The address the app subscribed with, as `POST push` keeps it.
        push.set_base(self.path, BASE)

    def _resolve(self, run_id: str, choice: str, resolve_all: bool = False) -> int:
        """Hermes's queue, answering how many requests it resolved: only a waiting run's."""
        self.resolved.append((run_id, choice, resolve_all))
        waiting = (self.book._run_statuses.get(run_id) or {}).get("status") == approvals.WAITING
        return 1 if waiting else 0

    def press(self, token: str) -> Dict[str, Any]:
        """A press, as the tray makes it: a POST to the button's own link, and nothing else."""
        request = FakeWeb.Request()
        request.headers = {}
        request.match_info = {"token": token}
        request.query = {}
        request.path = ANSWER.replace("{token}", token)
        return asyncio.run(route(self.app, ANSWER, "POST")(request))

    def buttons(self, target: Optional[Dict[str, Any]] = None) -> tuple:
        """The two buttons one approval's notice would carry."""
        return answers.mint(
            self.path,
            target or answers.run_target("run_1", "gots-1"),
            BASE,
            push.TTL_SECONDS,
        )

    def token_of(self, action: answers.Action) -> str:
        """The token a button's link carries, held to the address the app dialled."""
        self.assertTrue(
            action.url.startswith(BASE + answers.PATH),
            f"a button posts back to this bot: {action.url}",
        )
        return action.url.rsplit("/", 1)[-1]


class AnsweredOnce(Tray):
    def test_a_press_answers_the_run_its_row_names(self) -> None:
        once, _ = self.buttons()
        answer = self.press(self.token_of(once))
        self.assertEqual(
            answer,
            {
                "status": 200,
                "payload": {"object": "gots.push.answer", "answered": True, "choice": "once"},
            },
        )
        self.assertEqual(
            self.resolved,
            [("run_1", "once", True)],
            "the run's queue, resolved once and for all of its requests",
        )
        self.assertEqual(
            self.book.settled,
            [("run_1", "running")],
            "and its clients told, as an answer through the app's own route tells them",
        )

    def test_the_second_press_is_refused(self) -> None:
        once, _ = self.buttons()
        token = self.token_of(once)
        self.assertEqual(self.press(token)["status"], 200)
        self.assertEqual(self.press(token)["status"], 410, "a button answers once")
        self.assertEqual(len(self.resolved), 1, "and the run is answered once")

    def test_the_two_buttons_are_allow_once_and_deny(self) -> None:
        once, deny = self.buttons()
        self.assertEqual((once.label, deny.label), ("Allow once", "Deny"))
        self.assertNotEqual(
            self.token_of(once), self.token_of(deny), "one token cannot mean two choices"
        )
        self.assertEqual([row[1] for row in tokens(self.path)], ["deny", "once"], "the rows' choices")
        self.assertEqual(self.press(self.token_of(deny))["payload"]["choice"], "deny")
        self.assertEqual(self.resolved, [("run_1", "deny", True)])

    def test_session_and_always_cannot_be_minted(self) -> None:
        self.assertEqual(answers.CHOICES, ("once", "deny"), "the tray offers two ways to answer")
        # A row this build never minted, as a store written by something else could hold: the press
        # presents it, and it answers nothing — there is no third choice to ask for.
        token = "a-token-nobody-minted"
        conn = connect(self.path)
        conn.execute(
            "INSERT INTO answer_tokens (token, choice, target, expires_at) VALUES (?, ?, ?, ?)",
            (
                answers.digest(token),
                "always",
                json.dumps(answers.run_target("run_1", "gots-1")),
                int(time.time() * 1000) + push.TTL_SECONDS * 1000,
            ),
        )
        conn.close()
        self.assertEqual(self.press(token)["status"], 404, "no button carries a third choice")
        self.assertEqual(self.resolved, [])

    def test_an_unknown_token_answers_nothing(self) -> None:
        self.buttons()
        self.assertEqual(
            self.press("a-token-no-run-was-ever-told-about")["status"],
            404,
            "a token this bot never minted is no answer",
        )
        self.assertEqual(self.resolved, [])
        self.assertEqual(self.book.settled, [])

    def test_an_expired_token_answers_nothing(self) -> None:
        once, _ = self.buttons()
        # A tray entry that has gone: the token lived as long as the push that carried it.
        later = int(time.time() * 1000) + (push.TTL_SECONDS + 1) * 1000
        with mock.patch.object(answers, "now_ms", lambda: later):
            answer = self.press(self.token_of(once))
        self.assertEqual(answer["status"], 410)
        self.assertEqual(self.resolved, [])
        self.assertEqual(self.book.settled, [])

    def test_a_button_answers_no_run_but_its_own(self) -> None:
        self.book._run_statuses["run_2"] = {
            "status": approvals.WAITING,
            "session_id": "gots-2",
            "approval": {"request_id": "r2"},
        }
        once, _ = self.buttons(answers.run_target("run_1", "gots-1"))
        # run_1 was answered in the app while the tray's button sat there; run_2 still waits.
        self.book._run_statuses["run_1"] = {"status": "completed", "session_id": "gots-1"}
        answer = self.press(self.token_of(once))
        self.assertEqual(answer["status"], 409, "the wait it was minted for is over")
        self.assertEqual(
            self.resolved,
            [("run_1", "once", True)],
            "the row names run_1, so a run that is still waiting is never asked instead",
        )
        self.assertEqual(self.book._run_statuses["run_2"]["status"], approvals.WAITING)

    def test_a_get_is_never_an_answer(self) -> None:
        # Registered as a POST and nothing else, so aiohttp answers 405 to a read of the link: a
        # preview that fetches the URL spends no button.
        with self.assertRaises(AssertionError):
            route(self.app, ANSWER, "GET")


class APressThatSettlesNothing(Tray):
    """A press whose answer never lands answered nothing: the button is pressable again (G5).

    The row is claimed before anything settles, so two presses cannot both answer. A dispatch that
    then fails — a Host that timed out, a 5xx — must give the claim back, or the reader is told
    "already answered" about a wait that is still waiting.
    """

    def test_a_press_that_settles_nothing_is_not_spent(self) -> None:
        _, deny = self.buttons(answers.room_target("room-1", ROOM_WAIT))
        token = self.token_of(deny)

        def refused(name: str, params: Dict[str, Any], **kwargs: Any) -> Dict[str, Any]:
            raise rooms.RoomError("The host didn't answer in time.", 502)

        with mock.patch.object(rooms, "call", refused), mock.patch.object(rooms, "_answered"):
            self.assertEqual(
                self.press(token)["status"], 502, "the Host's own refusal, in its own words"
            )
        settled: List[Dict[str, Any]] = []
        with mock.patch.object(
            rooms, "call", lambda name, params, **kw: settled.append(params) or {"approved": True}
        ), mock.patch.object(rooms, "_answered"):
            self.assertEqual(
                self.press(token)["status"], 200, "nothing was answered, so the same button answers"
            )
        self.assertEqual([one["choice"] for one in settled], ["deny"], "and it still means Deny")

    def test_an_answer_that_finds_nothing_waiting_is_still_spent(self) -> None:
        # Not a failure: the wait the button was minted for is over, which is what a spent token
        # means. Only a settling that raised gives its claim back.
        once, _ = self.buttons()
        self.book._run_statuses["run_1"] = {"status": "completed", "session_id": "gots-1"}
        token = self.token_of(once)
        self.assertEqual(self.press(token)["status"], 409, "nothing is waiting on that run")
        self.assertEqual(self.press(token)["status"], 410, "and the token is spent all the same")


class ARoomsApproval(Tray):
    """G7: a room member's approval is answered from the tray, the same way."""

    def test_a_rooms_approval_is_answered_through_the_host(self) -> None:
        calls: List[tuple] = []
        answered: List[str] = []

        def call(name: str, params: Dict[str, Any], **kwargs: Any) -> Dict[str, Any]:
            calls.append((name, params, kwargs.get("home")))
            return {"approved": True}

        _, deny = self.buttons(answers.room_target("room-1", ROOM_WAIT))
        with mock.patch.object(rooms, "call", call), mock.patch.object(
            rooms, "_answered", lambda room_id, home: answered.append(room_id)
        ):
            answer = self.press(self.token_of(deny))
        self.assertEqual(
            answer,
            {
                "status": 200,
                "payload": {"object": "gots.push.answer", "answered": True, "choice": "deny"},
            },
        )
        self.assertEqual(
            calls,
            [
                (
                    "groups.approve",
                    {
                        "room_id": "room-1",
                        "member_id": "m2",
                        "task_id": "t1",
                        "execution_generation": 3,
                        "request_id": "req-9",
                        "choice": "deny",
                    },
                    self.home,
                )
            ],
            "the Host resolves the exact request the tray's row named",
        )
        self.assertEqual(answered, ["room-1"], "and the room's devices re-read it at once")
        self.assertEqual(self.resolved, [], "a room's approval is no run of this host's")

    def test_a_room_that_refuses_answers_in_its_own_words(self) -> None:
        def call(name: str, params: Dict[str, Any], **kwargs: Any) -> Dict[str, Any]:
            raise rooms.RoomError("That request isn't waiting for an answer any more.", 409)

        once, _ = self.buttons(answers.room_target("room-1", ROOM_WAIT))
        with mock.patch.object(rooms, "call", call), mock.patch.object(rooms, "_answered"):
            answer = self.press(self.token_of(once))
        self.assertEqual(answer["status"], 409)
        self.assertIn("isn't waiting", answer["payload"]["error"]["message"])

    def test_a_question_offers_no_button(self) -> None:
        # Only an approval is answered from the tray; a question is answered by opening the app.
        self.assertIsNone(
            answers.room_target("room-1", {"kind": "question", "questionId": "q1"}),
            "a room's question is nobody's button",
        )


def subscribed(path: Path) -> None:
    """One device on the profile, asked for the category an approval lands in."""
    conn = connect(path)
    conn.execute(
        "INSERT INTO push_subscriptions (endpoint, device, p256dh, auth, vapid_key, subject,"
        " created_at, categories) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (
            "https://push.example/1",
            "phone-1",
            "key",
            "auth",
            "vapid",
            "mailto:a@b.c",
            1,
            json.dumps(["chat_input"]),
        ),
    )
    conn.close()


class OnTheWire(unittest.TestCase):
    """What an approval's notice carries, and so what the wire carries: the two buttons."""

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.home = Path(tmp.name)
        self.path = db_path(self.home)
        subscribed(self.path)
        self.sent: List[Dict[str, Any]] = []
        self.relayed: List[Any] = []

    def run_approval(self, body: Optional[str] = None) -> None:
        with mock.patch.object(
            push, "send", lambda row, payload, topic: self.sent.append(payload) or 201
        ), mock.patch.object(
            push, "_relay", lambda path, kind, category, session_id, notice: self.relayed.append(notice)
        ):
            push._run(
                self.path,
                "approval",
                "gots-1",
                body=body,
                answer=answers.run_target("run_1", "gots-1"),
            )

    def test_a_notice_carries_allow_once_and_deny(self) -> None:
        push.set_base(self.path, BASE)
        self.run_approval("Clear the build\n\nrm -rf ./build")
        self.assertEqual(len(self.sent), 1)
        actions = self.sent[0]["actions"]
        self.assertEqual([one["label"] for one in actions], ["Allow once", "Deny"])
        self.assertEqual(
            sorted(answers.digest(one["url"].rsplit("/", 1)[-1]) for one in actions),
            sorted(row[0] for row in tokens(self.path)),
            "each button's link carries a token the store holds only the hash of",
        )
        self.assertEqual(self.sent[0]["body"], "Clear the build\n\nrm -rf ./build")
        self.assertEqual(
            [one.label for one in self.relayed[0].actions],
            ["Allow once", "Deny"],
            "the notice's own buttons, which ntfy carries too",
        )
        self.assertEqual(
            self.relayed[0].conversation["actions"],
            [],
            "the relay is given none of them: no phone has handed this profile a key to sign with",
        )
        held = {"topic": "gots-Zk3", "server": "https://ntfy.example", "token": "tk_abc"}
        message = ntfy.message(held, "approval", "chat_input", "gots-1", self.relayed[0])
        self.assertNotIn("actions", message, "a button is a header, not a word of ntfy's JSON")
        header = ntfy.headers("https://gots.example", "nova", self.relayed[0])["X-Actions"]
        self.assertEqual(
            [one["label"] for one in json.loads(header)],
            ["Allow once", "Deny"],
            "and ntfy's own header carries them to the phone",
        )

    def test_a_token_is_never_written_as_it_is_carried(self) -> None:
        push.set_base(self.path, BASE)
        self.run_approval()
        carried = {
            one["url"].rsplit("/", 1)[-1] for one in self.sent[0]["actions"]
        }
        self.assertFalse(
            carried & {row[0] for row in tokens(self.path)},
            "the store holds the hashes, never the tokens a notification carries",
        )

    def test_with_no_address_known_no_button_is_minted(self) -> None:
        # A profile whose app has never subscribed from anywhere: nothing knows where a press would
        # be posted, and a button that can't be pressed is worse than no button.
        self.run_approval("Clear the build")
        self.assertNotIn("actions", self.sent[0])
        self.assertEqual(tokens(self.path), [], "and no token is minted to go nowhere")

    def test_spent_and_expired_rows_are_pruned_as_each_approval_mints(self) -> None:
        push.set_base(self.path, BASE)
        once, _ = answers.mint(self.path, answers.run_target("run_1", "gots-1"), BASE, push.TTL_SECONDS)
        answers.redeem(self.path, once.url.rsplit("/", 1)[-1])
        self.assertEqual(len(tokens(self.path)), 2, "one spent, one still pressable")
        later = (int(time.time()) + push.TTL_SECONDS + 1) * 1000
        with mock.patch.object(answers, "now_ms", lambda: later):
            answers.mint(self.path, answers.run_target("run_2", "gots-2"), BASE, push.TTL_SECONDS)
        kept = tokens(self.path)
        self.assertEqual(len(kept), 2, "a press cannot grow the table: each mint prunes the last")
        self.assertEqual([row[2] for row in kept], [None, None], "and neither is spent")


class TheAddress(unittest.TestCase):
    """Where a button posts back to: the address this app dialled, kept from the request it used.

    A host behind a tunnel, a proxy or a LAN name doesn't know its own address; the phone knows the
    one it reached. So the base is read off the request the app subscribed with, and nothing is
    minted while there is none — never a guess at where a button might live.
    """

    def setUp(self) -> None:
        self.home = temp_hermes_home(self)
        self.path = db_path(self.home)
        self.app = wire(self, RouteAdapter())

    def request(self, path: str, *, scheme: str = "https", headers: Optional[Dict[str, str]] = None) -> Any:
        request = FakeWeb.Request()
        request.headers = dict(headers or {})
        request.match_info = {}
        request.query = {}
        request.path = path
        request.scheme = scheme
        return request

    def subscribe(self, path: str, **kwargs: Any) -> Dict[str, Any]:
        """The app subscribing from ``path``, with Hermes's own subscription checks stood in for."""
        body = {"subscription": {}, "device": "phone-1", "vapid_key": "k", "subject": "mailto:a@b.c"}
        with mock.patch.object(push, "subscribe", lambda store_path, sent: None):
            request = self.request(path, **kwargs)
            async def read() -> Any:
                return body

            async def text() -> str:
                return json.dumps(body)

            request.json = read
            request.text = text
            return asyncio.run(route(self.app, plugin.PREFIX + "/push", "POST")(request))

    def test_the_address_the_app_dialled_is_kept(self) -> None:
        self.subscribe("/api/plugins/gots/push", headers={"Host": "bot.example"})
        self.assertEqual(push.base(self.path), "https://bot.example/api/plugins/gots")

    def test_a_proxys_forwarded_address_wins_over_the_hosts_own(self) -> None:
        self.subscribe(
            "/api/plugins/gots/push",
            scheme="http",
            headers={
                "Host": "127.0.0.1:8642",
                "X-Forwarded-Proto": "https",
                "X-Forwarded-Host": "bot.example",
            },
        )
        self.assertEqual(
            push.base(self.path),
            "https://bot.example/api/plugins/gots",
            "the phone reached the proxy, so the button has to come back the way it went out",
        )

    def test_a_bots_own_prefix_rides_along(self) -> None:
        request = self.request(
            "/api/plugins/gots/p/penny/push", headers={"Host": "bot.example"}
        )
        self.assertEqual(
            push.base_url(request, "/push"),
            "https://bot.example/api/plugins/gots/p/penny",
            "a bot at /p/<profile> answers under its own prefix, as every route is served twice",
        )

    def test_ntfy_writes_the_same_address(self) -> None:
        with mock.patch.object(ntfy, "set_target", lambda path, body: {}):
            request = self.request("/api/plugins/gots/push/ntfy", headers={"Host": "bot.example"})
            async def read() -> Any:
                return {"topic": "gots-Zk3"}

            async def text() -> str:
                return "{}"

            request.json = read
            request.text = text
            asyncio.run(route(self.app, plugin.PREFIX + "/push/ntfy", "POST")(request))
        self.assertEqual(push.base(self.path), "https://bot.example/api/plugins/gots")

    def test_a_request_that_does_not_say_where_it_arrived_keeps_nothing(self) -> None:
        self.subscribe("/api/plugins/gots/push", scheme=None, headers={})
        self.assertIsNone(push.base(self.path), "no address is no button, rather than a guess")
        self.assertIsNone(push.base_url(self.request("/somewhere/else", headers={"Host": "h"}), "/push"))

    def test_the_address_a_phone_polls_from_is_kept_even_though_it_never_subscribes(self) -> None:
        """The Android app has no Push API, so it never posts `push`: every screen polls `runs/live`.

        `base` is what an approval's two buttons post back to, and a Firebase-only phone minted
        none at all while only `push` and `push/ntfy` wrote it. The poll every screen already makes
        writes it instead, so an approval relayed to the registry carries its links.
        """
        request = self.request("/api/plugins/gots/runs/live", headers={"Host": "bot.example"})
        answer = asyncio.run(route(self.app, plugin.PREFIX + "/runs/live", "GET")(request))
        self.assertEqual(answer["status"], 200)
        self.assertEqual(
            push.base(self.path),
            "https://bot.example/api/plugins/gots",
            "the address this phone dialled, kept from the route it really calls",
        )
        relayed: List[Any] = []
        device_keys.register(self.path, "phone-1", PHONE_KEY)
        with mock.patch.object(
            push, "_relay", lambda path, kind, category, session_id, notice: relayed.append(notice)
        ), mock.patch.object(link, "load_state", lambda home: {"token": "mh_x", "site": "https://app.example"}):
            push._run(
                self.path, "approval", "gots-1", answer=answers.run_target("run_1", "gots-1")
            )
        self.assertEqual(
            [one["label"] for one in relayed[-1].conversation["actions"]],
            ["Allow once", "Deny"],
            "so the approval it is sent carries two buttons that post to that address",
        )
        self.assertTrue(
            all(one["url"].startswith("https://bot.example/api/plugins/gots/push/answer/")
                for one in relayed[-1].conversation["actions"])
        )

    def test_a_mute_write_keeps_the_address_the_phone_reached_it_at(self) -> None:
        # `syncMutes` posts this from a phone with the app closed, so it is another route the
        # native app really calls, and it says where it reached this bot the same way.
        request = self.request("/api/plugins/gots/push/mute", headers={"Host": "bot.example"})
        body = {"muted": True, "bot": "nova"}

        async def read() -> Any:
            return body

        async def text() -> str:
            return json.dumps(body)

        request.json = read
        request.text = text
        answer = asyncio.run(route(self.app, plugin.PREFIX + "/push/mute", "POST")(request))
        self.assertEqual(answer["status"], 200)
        self.assertEqual(push.base(self.path), "https://bot.example/api/plugins/gots")

    def test_a_stored_address_that_is_not_one_is_not_used(self) -> None:
        push.set_base(self.path, "javascript:alert(1)")
        self.assertIsNone(push.base(self.path))


class Store(unittest.TestCase):
    def test_a_store_from_before_this_version_gains_the_table(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "gots.db"
            old = sqlite3.connect(path)
            old.execute("PRAGMA user_version = 73")
            old.commit()
            old.close()
            conn = connect(path)
            columns = [row[1] for row in conn.execute("PRAGMA table_info(answer_tokens)")]
            version = conn.execute("PRAGMA user_version").fetchone()[0]
            conn.close()
        self.assertEqual(columns, ["token", "choice", "target", "expires_at", "used_at", "signed"])
        self.assertEqual(version, store.SCHEMA_VERSION)

    def test_a_v74_store_gains_the_signed_mark_and_reads_its_links_as_unsigned(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "gots.db"
            old = sqlite3.connect(path)
            old.execute(
                "CREATE TABLE answer_tokens (token TEXT PRIMARY KEY, choice TEXT NOT NULL,"
                " target TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER)"
            )
            old.execute(
                "INSERT INTO answer_tokens VALUES (?, 'once', '{}', 99999999999999, NULL)",
                (answers.digest("held"),),
            )
            old.execute("PRAGMA user_version = 74")
            old.commit()
            old.close()
            self.assertFalse(answers.needs_signature(path, "held"), "a link minted before the mark")
            conn = connect(path)
            tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master")}
            conn.close()
        self.assertIn("device_keys", tables)


if __name__ == "__main__":
    unittest.main()
