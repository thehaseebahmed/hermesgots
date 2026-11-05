"""The queue Hermes keeps for a session, and the lost turn that holds it still.

The rows are the ledger's own (``session_admissions``): what is still in line, and a turn fenced
``unknown`` because its owner restarted mid-execution. The app reads them through this module and
acknowledges the lost one, which is the TUI's ``/discard``.

Run: python3 -m unittest plugin.tests.test_pending -v
"""

from __future__ import annotations

import asyncio
import sys
import types
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from plugin import pending


def admission(admission_id: str, status: str, text: str = "", payload=None, **extra):
    """One ledger row as Hermes's own reader hands it back (its payload already parsed)."""
    row = {
        "admission_id": admission_id,
        "target_session_id": "s1",
        "status": status,
        "payload": {"text": text} if payload is None else payload,
        "generation": extra.pop("generation", 3),
    }
    row.update(extra)
    return row


class Host:
    """The Hermes modules ``pending`` reaches, and the authority it acts through."""

    def __init__(self, rows=(), restore=None):
        self.rows = list(rows)
        self.reads = []
        self.resolved = []
        self.live = set()
        self.restored = []
        self.restore_error = restore
        self.refs = []
        self.authority = FakeAuthority(self)

    def modules(self):
        runtime = types.ModuleType("hermes_state_runtime")
        runtime.list_session_admissions = self.list_session_admissions
        runtime.get_session_admission = self.get
        contract = types.ModuleType("gateway.session_contract")
        contract.SessionRef = lambda profile_id, session_id: self.refs.append(
            (profile_id, session_id)
        ) or SimpleNamespace(profile_id=profile_id, session_id=session_id)
        api = types.ModuleType("gateway.session_api")

        def restore_api_session(authority, session_id):
            if self.restore_error is not None:
                raise self.restore_error
            self.restored.append(session_id)
            authority.sessions.add(session_id)

        api.restore_api_session = restore_api_session
        authorities = types.ModuleType("gateway.session_authorities")
        authorities.authority_for_home = lambda runner, home: self.authority
        authorities.owner_scope = lambda authority: mock.MagicMock()
        # The write is a method on the authority, never a module symbol: the fake holds it on a class
        # too, so a gate that asked the module would fail here as it would on a real host.
        authority = types.ModuleType("gateway.session_authority")

        class SessionAuthority:  # noqa: N801 - named as Hermes names it
            resolve_unknown_as_owner = FakeAuthority.resolve_unknown_as_owner

        authority.SessionAuthority = SessionAuthority
        return {
            "hermes_state_runtime": runtime,
            "gateway": types.ModuleType("gateway"),
            "gateway.session_contract": contract,
            "gateway.session_api": api,
            "gateway.session_authorities": authorities,
            "gateway.session_authority": authority,
        }

    def list_session_admissions(self, db, *, session_id):
        self.reads.append(session_id)
        return self.rows

    def get(self, db, *, admission_id):
        for row in self.rows:
            if row["admission_id"] == admission_id:
                return row
        return None


class FakeAuthority:
    def __init__(self, host: Host) -> None:
        self.host = host
        self.profile_id = "default"
        self.db = object()
        self.sessions = set()

    async def resolve_unknown_as_owner(self, ref, admission_id, generation, **_):
        self.host.resolved.append((ref.session_id, admission_id, generation))
        # The resolution's own effect: the row is terminal, so it is no longer pending.
        for row in self.host.rows:
            if row["admission_id"] == admission_id:
                row["status"] = "terminal"
                row["outcome"] = "interrupted"
        return SimpleNamespace(status="terminal", outcome="interrupted")


class ViewTest(unittest.TestCase):
    def test_what_waits_is_the_line_and_what_was_lost_holds_it(self) -> None:
        found = pending.view(
            [
                admission("a", "unknown"),
                admission("b", "queued", "the older one"),
                admission("c", "queued", "and the newer"),
            ]
        )
        self.assertEqual(found["lost"], "a")
        self.assertEqual(
            found["items"],
            [
                {"id": "a", "text": ""},
                {"id": "b", "text": "the older one"},
                {"id": "c", "text": "and the newer"},
            ],
        )

    def test_a_running_turn_is_not_something_waiting(self) -> None:
        # The host is executing a turn: it is not in line, and it is the reason a thread may still be
        # empty — the app reads that as `running`, never as a row to draw.
        found = pending.view([admission("a", "started", "at work"), admission("b", "queued", "next")])
        self.assertEqual([item["id"] for item in found["items"]], ["b"])
        self.assertIsNone(found["lost"])
        self.assertTrue(found["running"])

    def test_a_native_rows_words_are_its_event_text(self) -> None:
        row = admission("a", "queued", payload={"native_text_v1": {"event": {"text": "from a bot"}}})
        self.assertEqual(pending.view([row])["items"][0]["text"], "from a bot")

    def test_rows_without_an_identity_or_the_shape_are_dropped(self) -> None:
        found = pending.view([{"status": "queued"}, "not a row", admission("", "queued", "x")])
        self.assertEqual(found["items"], [])

    def test_nothing_pending_is_not_a_pause(self) -> None:
        self.assertEqual(
            pending.view([]), {"items": [], "lost": None, "running": False}
        )

    def test_a_long_message_crosses_only_as_far_as_a_row_draws_it(self) -> None:
        # The card draws one line of 200 characters; the envelope is cut at `WIRE_TEXT`.
        row = admission("a", "queued", "x" * 20_000)
        text = pending.view([row])["items"][0]["text"]
        self.assertEqual(len(text), pending.WIRE_TEXT)


class AvailableTest(unittest.TestCase):
    def test_a_host_holding_what_the_route_reads_is_asked(self) -> None:
        host = Host([])
        with mock.patch.dict(sys.modules, host.modules()):
            self.assertIsNone(pending.available())

    def test_a_host_without_the_ledger_advertises_nothing(self) -> None:
        host = Host([])
        modules = host.modules()
        modules["gateway.session_contract"] = types.ModuleType("gateway.session_contract")
        with mock.patch.dict(sys.modules, modules):
            self.assertIn("session ledger has moved", pending.available() or "")

    def test_a_host_that_can_read_but_never_clear_advertises_nothing(self) -> None:
        # A card whose one control could only refuse would hide the composer behind it.
        host = Host([])
        modules = host.modules()
        authority = types.ModuleType("gateway.session_authority")
        authority.SessionAuthority = object
        modules["gateway.session_authority"] = authority
        with mock.patch.dict(sys.modules, modules):
            self.assertIn("session ledger has moved", pending.available() or "")

    def test_a_host_without_an_importable_module_advertises_nothing(self) -> None:
        host = Host([])
        modules = host.modules()
        del modules["hermes_state_runtime"]
        with mock.patch.dict(sys.modules, modules):
            self.assertIn("no session admission ledger", pending.available() or "")


class ReadTest(unittest.TestCase):
    def test_a_session_is_read_through_the_ledgers_own_reader(self) -> None:
        host = Host([admission("a", "unknown"), admission("b", "queued", "older")])
        with mock.patch.dict(sys.modules, host.modules()):
            found = pending.read_for(SimpleNamespace(gateway_runner=object()), Path("/home"), "s1")
        self.assertEqual(host.reads, ["s1"])
        self.assertEqual(found["lost"], "a")
        self.assertEqual(len(found["items"]), 2)

    def test_a_host_without_an_authority_says_it_cannot_read_rather_than_nothing_waiting(self) -> None:
        # A home no authority serves can't be read at all: "nothing is waiting" would be a claim about
        # a session nothing looked at, and the card it suppresses may still be needed.
        host = Host([admission("a", "unknown")])
        modules = host.modules()
        modules["gateway.session_authorities"].authority_for_home = lambda runner, home: None
        with mock.patch.dict(sys.modules, modules):
            with self.assertRaises(pending.PendingError) as raised:
                pending.read_for(SimpleNamespace(gateway_runner=object()), Path("/home"), "s1")
        self.assertEqual(raised.exception.status, 501)
        self.assertEqual(host.reads, [])

    def test_a_host_that_cannot_scope_the_profile_refuses_rather_than_guessing(self) -> None:
        # Running the resolution in the launch profile's scope would read another profile's config:
        # a scope that is there and fails is refused, not replaced with the ambient one.
        host = Host([admission("a", "unknown")])
        modules = host.modules()
        modules["gateway.session_authorities"].owner_scope = mock.MagicMock(
            side_effect=RuntimeError("no such profile")
        )
        with mock.patch.dict(sys.modules, modules):
            with self.assertRaises(pending.PendingError) as raised:
                asyncio.run(
                    pending.discard_for(
                        SimpleNamespace(gateway_runner=object()), Path("/home"), "s1", "a"
                    )
                )
        self.assertEqual(raised.exception.status, 502)
        self.assertEqual(host.resolved, [])

    def test_a_reader_that_answers_something_but_rows_is_not_an_empty_queue(self) -> None:
        host = Host([])
        host.list_session_admissions = lambda db, *, session_id: {"rows": []}
        with mock.patch.dict(sys.modules, host.modules()):
            with self.assertRaises(pending.PendingError) as raised:
                pending.read_for(SimpleNamespace(gateway_runner=object()), Path("/home"), "s1")
        self.assertEqual(raised.exception.status, 502)


class DiscardTest(unittest.TestCase):
    def discard(self, host: Host, admission_id: str = "a") -> dict:
        with mock.patch.dict(sys.modules, host.modules()):
            return asyncio.run(pending.discard_for(
                SimpleNamespace(gateway_runner=object()), Path("/home"), "s1", admission_id
            ))

    def test_a_lost_turn_is_acknowledged_at_the_generation_the_owner_stamped(self) -> None:
        host = Host([admission("a", "unknown", generation=7), admission("b", "queued", "older")])
        found = self.discard(host)
        self.assertEqual(host.resolved, [("s1", "a", 7)])
        self.assertEqual(host.refs, [("default", "s1")])
        self.assertIsNone(found["lost"])

    def test_a_session_the_owner_is_not_holding_is_restored_first(self) -> None:
        host = Host([admission("a", "unknown")])
        self.discard(host)
        self.assertEqual(host.restored, ["s1"])

    def test_a_session_already_live_is_not_restored_again(self) -> None:
        host = Host([admission("a", "unknown")])
        host.authority.sessions.add("s1")
        self.discard(host)
        self.assertEqual(host.restored, [])

    def test_a_turn_that_moved_on_is_refused_rather_than_acknowledged(self) -> None:
        host = Host([admission("a", "terminal")])
        with self.assertRaises(pending.PendingError) as raised:
            self.discard(host)
        self.assertEqual(raised.exception.status, 409)
        self.assertEqual(host.resolved, [])

    def test_another_sessions_row_is_refused(self) -> None:
        host = Host([admission("a", "unknown", target_session_id="other")])
        with self.assertRaises(pending.PendingError) as raised:
            self.discard(host)
        self.assertEqual(raised.exception.status, 409)

    def test_a_host_that_cannot_resolve_a_lost_turn_says_so(self) -> None:
        host = Host([admission("a", "unknown")])
        host.authority.resolve_unknown_as_owner = None
        with self.assertRaises(pending.PendingError) as raised:
            self.discard(host)
        self.assertEqual(raised.exception.status, 501)

    def test_a_ledger_that_cannot_be_read_is_not_a_turn_that_moved_on(self) -> None:
        # A locked store or a schema that drifted says so as a failure (502), never as "give up, the
        # turn is gone" (409): the app's card would still show the lost turn.
        host = Host([admission("a", "unknown")])

        def broken(db, *, admission_id):
            raise RuntimeError("database is locked")

        host.get = broken
        with self.assertRaises(pending.PendingError) as raised:
            self.discard(host)
        self.assertEqual(raised.exception.status, 502)

    def test_a_generation_that_moved_under_the_app_is_refused(self) -> None:
        host = Host([admission("a", "unknown")])

        class Stale(Exception):
            reason = "stale_generation"

        async def stale(ref, admission_id, generation, **_):
            raise Stale()

        host.authority.resolve_unknown_as_owner = stale
        with self.assertRaises(pending.PendingError) as raised:
            self.discard(host)
        self.assertEqual(raised.exception.status, 409)


if __name__ == "__main__":
    unittest.main()
