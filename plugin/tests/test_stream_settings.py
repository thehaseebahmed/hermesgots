"""A settings change made by something else reaches the ledger.

The plugin's own settings routes note their writes as they make them. A Hermes on the command line,
or a profile another process writes, has no hook into this one at all — and what it changes is drawn
on a device this server will never touch: the composer's mic, whose answer that device keeps for five
minutes. So the stream watches the profile's ``config.yaml`` as a stamp, and a stamp that moves
becomes a row like any other: every open stream sends ``settings`` within a tick, and a device that
was away reads it back from its own cursor (ADR 0164).

Run: python3 -m unittest plugin.tests.test_stream_settings -v
"""

from __future__ import annotations

import asyncio
import contextlib
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from plugin import events, stream
from plugin.store import db_path


def settings_rows(path: Path) -> list[tuple[str, str]]:
    """Every row the reader has noted, as (kind, session): a settings change names no session."""
    rows, _more = events.read_since(path, 0)
    return [(row["kind"], row["session_id"]) for row in rows if row["kind"] == "settings"]


class SettingsReader(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self._dir = tempfile.TemporaryDirectory()
        self.addCleanup(self._dir.cleanup)
        # The store the server hands its streams: the events ledger, as a file under a home.
        self.path = db_path(Path(self._dir.name))
        self.home = Path(self._dir.name)
        self.tasks: list[asyncio.Task] = []
        self.addAsyncCleanup(self.stop)
        # A tick short enough for a test, and the file the reader watches.
        tick = mock.patch.object(stream, "CONFIG_TICK_SECONDS", 0.02)
        tick.start()
        self.addCleanup(tick.stop)
        self.config = self.home / "config.yaml"
        self.write("stt:\n  enabled: true\n")

    def write(self, text: str) -> None:
        """A settings file written by something with no hook here: the CLI, another process."""
        self.config.write_text(text, encoding="utf-8")

    def reading(self) -> None:
        self.tasks.append(stream.watch_config(self.path, self.home))

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

    async def seeded(self) -> None:
        """Waits for the reader's first look: the file as it stood before anything happened."""
        await asyncio.sleep(0.1)

    async def test_a_settings_write_made_elsewhere_is_noted(self) -> None:
        self.reading()
        await self.seeded()
        self.assertEqual(settings_rows(self.path), [], "nothing has happened yet")
        self.write("stt:\n  enabled: false\n  provider: groq\n")
        await self.until(lambda: settings_rows(self.path), "the settings change was never noted")
        self.assertEqual(settings_rows(self.path), [("settings", None)])

    async def test_one_row_per_change_and_no_more(self) -> None:
        self.reading()
        await self.seeded()
        self.write("stt:\n  enabled: false\n")
        await self.until(lambda: settings_rows(self.path), "the first change was never noted")
        await asyncio.sleep(0.1)
        self.assertEqual(len(settings_rows(self.path)), 1, "a file left alone notes nothing further")
        self.write("stt:\n  enabled: true\n  language: es\n")
        await self.until(
            lambda: len(settings_rows(self.path)) == 2, "the second change was never noted"
        )

    async def test_a_file_that_never_moves_notes_nothing(self) -> None:
        self.reading()
        await self.seeded()
        await asyncio.sleep(0.15)
        self.assertEqual(settings_rows(self.path), [])

    async def test_a_file_that_appears_is_a_change(self) -> None:
        # A profile whose settings file did not exist yet: the first write is news like any other.
        self.config.unlink()
        self.reading()
        await self.seeded()
        self.write("stt:\n  enabled: false\n")
        await self.until(lambda: settings_rows(self.path), "the file's arrival was never noted")
        self.assertEqual(settings_rows(self.path), [("settings", None)])


if __name__ == "__main__":
    unittest.main()
