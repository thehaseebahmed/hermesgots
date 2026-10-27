"""A title that lands is noted into the events ledger, listening or not.

The watch used to live inside one stream: the moment the device closed the app, the watcher went
with the connection, and the `title` event it would have sent was never logged, so nothing carried
the change back. The reader now lives for the plugin and arms itself off the ledger, so a session
that moved while nothing was listening is watched like any other; a change is a row, which every
open stream sends within a tick and a device that was away reads back from its own cursor.

Run: python3 -m unittest plugin.tests.test_stream_titles -v
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional
from unittest import mock

from plugin import events, stream
from plugin.store import db_path


def compression(home: Path, *ids: str) -> None:
    """A Hermes ``state.db`` where each session was compressed into the next, oldest first."""
    home.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(home / "state.db")) as conn:
        conn.execute(
            "CREATE TABLE sessions (id TEXT PRIMARY KEY, parent_session_id TEXT, end_reason TEXT,"
            " model_config TEXT, source TEXT)"
        )
        conn.executemany(
            "INSERT INTO sessions VALUES (?, ?, ?, ?, ?)",
            [
                (one, ids[i - 1] if i else None, "compression" if i < len(ids) - 1 else None, None, None)
                for i, one in enumerate(ids)
            ],
        )
        conn.commit()


class FakeSessions:
    """The slice of the host's session store the watcher reads a title from."""

    def __init__(self, title: Optional[str] = "the opener's slice") -> None:
        self.title = title
        self.reads = 0
        self.seen: set[str] = set()

    def get_session_title(self, session_id: str) -> Optional[str]:
        self.reads += 1
        self.seen.add(session_id)
        return self.title


def ledger_titles(path: Path) -> list[tuple[str, str]]:
    rows, _more = events.read_since(path, 0)
    return [(row["kind"], row["session_id"]) for row in rows if row["kind"] == "title"]


class TitleReader(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self._dir = tempfile.TemporaryDirectory()
        # The store the server hands its streams: the events ledger, as a file under a home.
        self.path = db_path(Path(self._dir.name))
        self.addCleanup(self._dir.cleanup)
        # The reader lives for the plugin, so a test gets its own state and cancels its own task.
        for name, value in (
            ("_title_watchers", {}),
            ("TITLE_TICK_SECONDS", 0.02),
            ("TITLE_WATCH_SECONDS", 0.4),
        ):
            patcher = mock.patch.object(stream, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.home = Path(self._dir.name)
        self.tasks: list[asyncio.Task] = []
        self.addAsyncCleanup(self.stop)

    def reading(self, sessions: FakeSessions, home: Optional[Path] = None) -> None:
        self.tasks.append(stream.watch_titles(self.path, sessions, home or self.home))

    async def stop(self) -> None:
        for task in self.tasks:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

    async def until(self, done, what: str) -> None:
        for _ in range(500):
            if done():
                return
            await asyncio.sleep(0.01)
        self.fail(f"{what} never happened")

    async def seeded(self, sessions: FakeSessions) -> None:
        """Waits for the move to be read once: the title it reads is the one it watches from."""
        await self.until(lambda: sessions.reads > 0, "the session's title was never read")

    async def test_a_title_that_changes_is_noted_into_the_ledger(self):
        sessions = FakeSessions()
        self.reading(sessions)
        events.note("session", "session_1", self.path, True)
        await self.seeded(sessions)
        sessions.title = "the title Hermes gave it"
        await self.until(lambda: ledger_titles(self.path), "the title was never noted")
        self.assertEqual(ledger_titles(self.path), [("title", "session_1")])

    async def test_a_title_that_never_changes_notes_nothing(self):
        sessions = FakeSessions()
        stream.TITLE_WATCH_SECONDS = 0.1
        self.reading(sessions)
        events.note("session", "session_1", self.path, True)
        await self.seeded(sessions)
        await asyncio.sleep(0.2)
        self.assertEqual(ledger_titles(self.path), [])

    async def test_a_failed_read_is_not_a_title_change(self):
        sessions = FakeSessions(title=None)
        self.reading(sessions)
        events.note("session", "session_1", self.path, True)
        await self.seeded(sessions)
        await asyncio.sleep(0.1)
        self.assertEqual(ledger_titles(self.path), [])

    async def test_another_move_extends_the_watch(self):
        # The title lands after the first watch window would have closed — a later turn kept the
        # session moving, which is what a slow background title call looks like.
        sessions = FakeSessions()
        stream.TITLE_WATCH_SECONDS = 0.15
        self.reading(sessions)
        events.note("session", "session_1", self.path, True)
        await self.seeded(sessions)
        await asyncio.sleep(0.1)
        events.note("session", "session_1", self.path, True)
        await asyncio.sleep(0.08)
        sessions.title = "the title Hermes gave it"
        await self.until(lambda: ledger_titles(self.path), "the title was never noted")
        self.assertEqual(ledger_titles(self.path), [("title", "session_1")])

    async def test_a_move_while_nothing_is_listening_is_still_noted(self):
        # No stream is open anywhere here: the ledger alone arms the watch, which is the case a
        # watcher inside a connection lost.
        sessions = FakeSessions()
        self.reading(sessions)
        events.note("session", "session_1", self.path, True)
        await self.seeded(sessions)
        sessions.title = "the title Hermes gave it"
        await self.until(lambda: ledger_titles(self.path), "the title was never noted")

    async def test_a_watch_that_runs_out_leaves_nothing_behind(self):
        sessions = FakeSessions()
        stream.TITLE_WATCH_SECONDS = 0.06
        self.reading(sessions)
        events.note("session", "session_1", self.path, True)
        await self.seeded(sessions)
        await asyncio.sleep(0.15)
        self.assertEqual(stream._title_watchers[str(self.path)]["sessions"], {})

    async def test_a_compressed_chat_is_noted_as_the_session_it_started_as(self):
        # The app knows a chat by the session it began as, and so does the title it is given:
        # compression moves the session on, and the event has to name the chat's own id.
        compression(self.home, "session_root", "session_child")
        sessions = FakeSessions()
        self.reading(sessions)
        events.note("session", "session_child", self.path, True)
        await self.seeded(sessions)
        self.assertEqual(sessions.seen, {"session_root"})
        sessions.title = "the title Hermes gave it"
        await self.until(lambda: ledger_titles(self.path), "the title was never noted")
        self.assertEqual(ledger_titles(self.path), [("title", "session_root")])

    async def test_one_reader_watches_every_session_on_the_store(self):
        sessions = FakeSessions()
        self.reading(sessions)
        events.note("session", "session_1", self.path, True)
        events.note("session", "session_2", self.path, True)
        await self.until(lambda: len(sessions.seen) == 2, "both sessions were never read")
        self.assertEqual(len(stream._title_watchers), 1, "a store gets one reader, not one a session")


if __name__ == "__main__":
    unittest.main()
