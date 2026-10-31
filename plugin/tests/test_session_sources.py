"""A session's ``source`` is Hermes's own: the plugin repairs the rows it once relabelled and never
writes one again.

Hermes's session authority reads ``sessions.source`` as the surface that OWNS a session and refuses a
``POST /v1/runs`` turn onto any row whose source isn't ``api_server``/``bot_room`` (409
``permission_denied``). The plugin used to write ``Gots``/``Gots Code`` there as a dashboard label, so
every chat it labelled stopped answering from its next message on; ``heal_sources`` puts those rows
back, and nothing writes the column any more.

Run: python3 -m unittest plugin.tests.test_session_sources -v
"""

from __future__ import annotations

import sqlite3
import unittest
from contextlib import closing
from pathlib import Path

import plugin
from plugin import sessions
from plugin.tests._helpers import temp_hermes_home


def write_store(home: Path, rows) -> None:
    with closing(sqlite3.connect(home / "state.db")) as conn:
        conn.execute("CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT)")
        conn.executemany("INSERT INTO sessions VALUES (?, ?)", rows)
        conn.commit()


def read_sources(home: Path) -> dict:
    with closing(sqlite3.connect(home / "state.db")) as conn:
        return dict(conn.execute("SELECT id, source FROM sessions"))


class HealSourcesTests(unittest.TestCase):
    def test_the_labels_this_plugin_wrote_go_back_to_the_api_source(self):
        home = temp_hermes_home(self)
        write_store(home, [("memento-a", "Gots"), ("memento-b", "Gots Code"),
                           ("memento-c", "memento"), ("memento-d", "Memento"),
                           ("memento-e", "memento-code"), ("memento-f", "Memento Code")])
        self.assertEqual(sessions.heal_sources(home), 6)
        self.assertEqual(set(read_sources(home).values()), {"api_server"})

    def test_another_surfaces_session_is_left_alone(self):
        home = temp_hermes_home(self)
        write_store(home, [("telegram-1", "telegram"), ("desktop-1", "desktop"),
                           ("memento-a", "Gots")])
        sessions.heal_sources(home)
        self.assertEqual(read_sources(home), {"telegram-1": "telegram", "desktop-1": "desktop",
                                              "memento-a": "api_server"})

    def test_a_second_pass_moves_nothing(self):
        home = temp_hermes_home(self)
        write_store(home, [("memento-a", "Gots")])
        self.assertEqual(sessions.heal_sources(home), 1)
        self.assertEqual(sessions.heal_sources(home), 0)

    def test_a_home_with_no_store_is_not_an_error(self):
        home = temp_hermes_home(self)
        self.assertEqual(sessions.heal_sources(home), 0)
        self.assertFalse((home / "state.db").exists(), "the repair must not plant a state.db")

    def test_a_healthy_store_is_only_read(self):
        home = temp_hermes_home(self)
        write_store(home, [("memento-a", "api_server")])
        before = (home / "state.db").stat().st_mtime_ns
        self.assertEqual(sessions.heal_sources(home), 0)
        self.assertEqual((home / "state.db").stat().st_mtime_ns, before)


class RepairTests(unittest.IsolatedAsyncioTestCase):
    """``repair_labelled_sources`` is what the API server awaits before its port accepts a turn."""

    async def test_one_store_that_cannot_be_opened_does_not_stop_the_others(self):
        broken = temp_hermes_home(self)
        (broken / "state.db").mkdir()
        good = temp_hermes_home(self)
        write_store(good, [("memento-a", "Gots")])
        failed = await plugin.repair_labelled_sources([broken, good])
        self.assertEqual(failed, [broken])
        self.assertEqual(read_sources(good), {"memento-a": "api_server"})

    async def test_a_home_with_nothing_to_repair_is_not_a_failure(self):
        home = temp_hermes_home(self)
        write_store(home, [("memento-a", "api_server")])
        self.assertEqual(await plugin.repair_labelled_sources([home]), [])


class NoWriterTests(unittest.TestCase):
    """The two writers are gone, not merely unused: either one back re-breaks every labelled chat."""

    def setUp(self) -> None:
        self.root = Path(plugin.__file__).parent
        self.modules = sorted(self.root.glob("*.py"))

    def test_no_module_starts_a_session_by_labelling_it(self):
        self.assertFalse(hasattr(sessions, "started"))
        labelled = [module.name for module in self.modules if "on_session_start" in module.read_text()]
        self.assertEqual(labelled, [])

    def test_the_only_source_write_in_the_plugin_is_the_heal(self):
        self.assertFalse(hasattr(sessions, "label"))
        writers = [module.name for module in self.modules if "UPDATE sessions SET source" in module.read_text()]
        self.assertEqual(writers, ["sessions.py"])


if __name__ == "__main__":
    unittest.main()
