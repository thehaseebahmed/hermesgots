"""The interface switch: one boolean the profile's store holds, the section it withholds, and the
record the route pair answers.

Run: python3 -m unittest plugin.tests.test_openui_switch -v

The switch is read where a session starts, so these cases drive the module's own functions with a
store in a temporary home — the same two calls the plugin's routes make (``enabled`` and
``set_enabled``) — rather than standing up Hermes's API server.
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from plugin import openui
from plugin.store import db_path, get_setting


class SwitchTest(unittest.TestCase):
    def setUp(self) -> None:
        self.home = Path(tempfile.mkdtemp())
        self.path = db_path(self.home)
        # Every case starts from a store with no row in it, which is what a host nobody has
        # switched anything on keeps.
        self.assertEqual(get_setting(self.path, openui.SETTING), None)

    def home_for(self, home: Path):
        """The store the section reads, as the module resolves one for a profile."""
        return mock.patch.object(openui, "path_for", return_value=db_path(home))

    def test_on_until_it_is_turned_off(self) -> None:
        # Nothing stored is not off: a host that has never been asked keeps telling the model the
        # library, which is what every chat before this switch was told.
        self.assertIs(openui.enabled(self.path), True)
        with self.home_for(self.home):
            self.assertEqual(openui.content(), openui.TEXT)

    def test_off_is_a_boolean_and_reads_back(self) -> None:
        self.assertIs(openui.set_enabled(self.path, False), False)
        # `put_setting(path, key, None)` deletes the row, and a missing row reads as the default
        # (on), so off has to be the boolean it is or the switch could never stay off.
        self.assertIs(get_setting(self.path, openui.SETTING), False)
        self.assertIs(openui.enabled(self.path), False)
        # And back on, which is a row of its own rather than a delete.
        self.assertIs(openui.set_enabled(self.path, True), True)
        self.assertIs(get_setting(self.path, openui.SETTING), True)
        self.assertIs(openui.enabled(self.path), True)

    def test_off_withholds_the_section_and_on_tells_it(self) -> None:
        with self.home_for(self.home):
            self.assertEqual(openui.content(), openui.TEXT)
            openui.set_enabled(self.path, False)
            # "" is the only way to withhold a section: the host drops it silently, so the next
            # chat's prompt carries no section at all.
            self.assertEqual(openui.content({"session_id": "s", "profile_name": "default"}), "")
            openui.set_enabled(self.path, True)
            self.assertEqual(openui.content({"session_id": "s", "profile_name": "default"}), openui.TEXT)

    def test_the_section_reads_the_profile_the_session_names(self) -> None:
        # The section is rendered where a thread may have lost the ambient home, so the profile in
        # the session info is the one whose store is asked.
        with mock.patch.object(openui, "path_for", return_value=None) as asked:
            openui.content({"session_id": "s", "profile_name": "coder"})
        asked.assert_called_once_with("coder")

    def test_a_profile_that_cannot_be_resolved_leaves_it_on(self) -> None:
        # No Hermes to ask for the home, and nothing to read: the library is still told, the fail
        # direction the plugin keeps when a read can't be made.
        with mock.patch.object(openui, "path_for", return_value=None):
            self.assertEqual(openui.content({"profile_name": "coder"}), openui.TEXT)
        self.assertIs(openui.enabled(None), True)

    def test_the_answer_names_the_object_the_switch_and_the_version(self) -> None:
        self.assertEqual(
            openui.record(False),
            {"object": "memento.openui", "enabled": False, "version": openui.VERSION},
        )
        # A versioned feature string would read as absent on every screen; the version rides here.
        self.assertEqual(openui.OBJECT, "memento.openui")
        self.assertEqual(openui.FEATURE, "openui")


if __name__ == "__main__":
    unittest.main()
