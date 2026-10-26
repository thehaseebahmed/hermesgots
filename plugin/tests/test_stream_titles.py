"""A title that lands is noted into the events ledger, whoever is connected when it does.

The watch used to live inside one stream: the moment the device closed the app, the watcher went
with the connection, and the `title` event it would have sent was never logged, so nothing carried
the change back. The watch now lives outside the connections, and the change is a row — which every
open stream sends within a tick and a device that was away reads back from its own cursor.

Run: python3 -m unittest plugin.tests.test_stream_titles -v
"""

from __future__ import annotations

import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from plugin import events, stream
from plugin.store import db_path


class FakeSessions:
    """The slice of the host's session store the watcher reads a title from."""

    def __init__(self, title: str | None = "the opener's slice") -> None:
        self.title = title
        self.reads = 0
        self.seen: set[str] = set()

    def get_session_title(self, session_id: str) -> str | None:
        self.reads += 1
        self.seen.add(session_id)
        return self.title


def ledger_titles(path: Path) -> list[tuple[str, str]]:
    rows, _more = events.read_since(path, 0)
    return [(row["kind"], row["session_id"]) for row in rows if row["kind"] == "title"]


class TitlesNotedWhenTheyLand(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self._dir = tempfile.TemporaryDirectory()
        # The store the server hands its streams: the events ledger, as a file under a home.
        self.path = db_path(Path(self._dir.name))
        self.addCleanup(self._dir.cleanup)
        # Each test gets its own watch state, so the watches of one don't outlive it.
        for name in ("_watches", "_watchers"):
            patcher = mock.patch.object(stream, name, {})
            patcher.start()
            self.addCleanup(patcher.stop)

    async def wait_until_idle(self) -> None:
        """Waits for the watcher to leave: it exits once nothing is watched anymore."""
        for _ in range(500):
            if not stream._watchers.get(str(self.path)):
                return
            await asyncio.sleep(0.02)
        self.fail("the title watcher never left")

    async def test_a_title_that_changes_is_noted_into_the_ledger(self):
        sessions = FakeSessions()
        with mock.patch.object(stream, "TITLE_TICK_SECONDS", 0.02), mock.patch.object(
            stream, "TITLE_WATCH_SECONDS", 0.4
        ):
            await stream.watch_title(self.path, sessions, "session_1")
            await asyncio.sleep(0.06)
            sessions.title = "the title Hermes gave it"
            await self.wait_until_idle()
        self.assertEqual(ledger_titles(self.path), [("title", "session_1")])

    async def test_a_title_that_never_changes_notes_nothing(self):
        sessions = FakeSessions()
        with mock.patch.object(stream, "TITLE_TICK_SECONDS", 0.02), mock.patch.object(
            stream, "TITLE_WATCH_SECONDS", 0.1
        ):
            await stream.watch_title(self.path, sessions, "session_1")
            await self.wait_until_idle()
        self.assertEqual(ledger_titles(self.path), [])

    async def test_a_failed_read_is_not_a_title_change(self):
        sessions = FakeSessions(title=None)
        with mock.patch.object(stream, "TITLE_TICK_SECONDS", 0.02), mock.patch.object(
            stream, "TITLE_WATCH_SECONDS", 0.1
        ):
            await stream.watch_title(self.path, sessions, "session_1")
            await self.wait_until_idle()
        self.assertEqual(ledger_titles(self.path), [])

    async def test_another_move_extends_the_watch(self):
        # The title lands after the first watch window would have closed — a second turn kept the
        # session moving, which is exactly what a slow background title call looks like.
        sessions = FakeSessions()
        with mock.patch.object(stream, "TITLE_TICK_SECONDS", 0.02), mock.patch.object(
            stream, "TITLE_WATCH_SECONDS", 0.15
        ):
            await stream.watch_title(self.path, sessions, "session_1")
            await asyncio.sleep(0.08)
            await stream.watch_title(self.path, sessions, "session_1")
            await asyncio.sleep(0.12)
            sessions.title = "the title Hermes gave it"
            await self.wait_until_idle()
        self.assertEqual(ledger_titles(self.path), [("title", "session_1")])

    async def test_nothing_watched_leaves_no_reader_behind(self):
        sessions = FakeSessions()
        with mock.patch.object(stream, "TITLE_TICK_SECONDS", 0.02), mock.patch.object(
            stream, "TITLE_WATCH_SECONDS", 0.06
        ):
            await stream.watch_title(self.path, sessions, "session_1")
            await self.wait_until_idle()
        self.assertNotIn(str(self.path), stream._watches)
        reads = sessions.reads
        await asyncio.sleep(0.15)
        self.assertEqual(sessions.reads, reads, "nothing reads a title once nothing is watched")

    async def test_one_watcher_reads_every_session_on_the_store(self):
        sessions = FakeSessions()
        with mock.patch.object(stream, "TITLE_TICK_SECONDS", 0.02), mock.patch.object(
            stream, "TITLE_WATCH_SECONDS", 0.2
        ):
            await stream.watch_title(self.path, sessions, "session_1")
            first = stream._watchers[str(self.path)]
            await stream.watch_title(self.path, sessions, "session_2")
            self.assertIs(
                stream._watchers[str(self.path)], first, "the store gets one watcher, not one each"
            )
            await self.wait_until_idle()
        self.assertEqual(sessions.seen, {"session_1", "session_2"})


if __name__ == "__main__":
    unittest.main()
