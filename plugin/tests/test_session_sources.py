"""A session's ``source`` is Hermes's own: the plugin repairs the rows it once relabelled and never
writes one again.

Hermes's session authority reads ``sessions.source`` as the surface that OWNS a session and refuses a
``POST /v1/runs`` turn onto any row whose source isn't ``api_server``/``bot_room`` (409
``permission_denied``). The plugin used to write ``Gots``/``Gots Code`` there as a dashboard label, so
every chat it labelled stopped answering from its next message on; ``heal_sources`` puts those rows
back and nothing writes the column any more.

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


def state(home: Path, rows) -> None:
    with closing(sqlite3.connect(home / "state.db")) as conn:
        conn.execute("CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT)")
        conn.executemany("INSERT INTO sessions VALUES (?, ?)", rows)
        conn.commit()


def sources(home: Path) -> dict:
    with closing(sqlite3.connect(home / "state.db")) as conn:
        return dict(conn.execute("SELECT id, source FROM sessions"))


class FakeDb:
    """The one seam the route's read goes through."""

    def __init__(self, home: Path) -> None:
        self.home = home

    def _execute_write(self, work):
        with closing(sqlite3.connect(self.home / "state.db")) as conn:
            return work(conn)


class HealSourcesTests(unittest.TestCase):
    def test_the_labels_this_plugin_wrote_go_back_to_the_api_source(self):
        home = temp_hermes_home(self)
        state(home, [("memento-a", "Gots"), ("memento-b", "Gots Code"),
                     ("memento-c", "memento"), ("memento-d", "Memento"),
                     ("memento-e", "memento-code"), ("memento-f", "Memento Code")])
        self.assertEqual(sessions.heal_sources(home), 6)
        self.assertEqual(set(sources(home).values()), {"api_server"})

    def test_another_surfaces_session_is_left_alone(self):
        home = temp_hermes_home(self)
        state(home, [("telegram-1", "telegram"), ("desktop-1", "desktop"), ("memento-a", "Gots")])
        sessions.heal_sources(home)
        self.assertEqual(sources(home), {"telegram-1": "telegram", "desktop-1": "desktop",
                                         "memento-a": "api_server"})

    def test_a_second_pass_moves_nothing(self):
        home = temp_hermes_home(self)
        state(home, [("memento-a", "Gots")])
        self.assertEqual(sessions.heal_sources(home), 1)
        self.assertEqual(sessions.heal_sources(home), 0)

    def test_a_home_with_no_store_is_not_an_error(self):
        self.assertEqual(sessions.heal_sources(temp_hermes_home(self)), 0)


class SourceOfTests(unittest.TestCase):
    def test_it_answers_the_rows_own_source_and_writes_nothing(self):
        home = temp_hermes_home(self)
        state(home, [("memento-a", "Gots")])
        self.assertEqual(sessions.source_of(FakeDb(home), "memento-a"), "Gots")
        self.assertEqual(sources(home), {"memento-a": "Gots"})

    def test_an_unknown_session_answers_none(self):
        home = temp_hermes_home(self)
        state(home, [("memento-a", "api_server")])
        self.assertIsNone(sessions.source_of(FakeDb(home), "memento-b"))


class NoWriterTests(unittest.TestCase):
    """The two writers are gone, not merely unused: either one back re-breaks every labelled chat."""

    def setUp(self) -> None:
        self.root = Path(plugin.__file__).parent

    def test_no_hook_labels_a_session(self):
        self.assertFalse(hasattr(sessions, "started"))
        self.assertNotIn('register_hook("on_session_start"', (self.root / "__init__.py").read_text())

    def test_the_only_source_write_is_the_heal(self):
        self.assertFalse(hasattr(sessions, "label"))
        writes = [
            module for module in ("__init__.py", "link.py")
            if "UPDATE sessions SET source" in (self.root / module).read_text()
        ]
        self.assertEqual(writes, [])


if __name__ == "__main__":
    unittest.main()
