"""The records beside the code: two lists and one order that nothing else would notice drifting.

Each case here is a fact two files must agree on and no import can check: the categories Android is
told to let peek, the order two `on_session_end` hooks depend on, and nothing more. They are cheap
because the alternative is what happened — a list that lost a member and a notice that named the
wrong wait.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
APP = ROOT / "app"


class ThePeeksAtHighImportance(unittest.TestCase):
    """The android service makes a channel at high importance for the categories that wait on the
    user, and the app's own list is where those four are written down. A channel it creates before
    the app has made one keeps whatever importance it was first given, so a category missing here
    is one whose notice never takes the screen — `research_input` was missing until it was found."""

    def test_the_service_lets_every_importance_four_category_peek(self):
        kinds = (APP / "src" / "lib" / "push-kinds.ts").read_text()
        rows = re.findall(
            r"\{\s*id: \"(\w+)\",[^}]*?importance: (\d),?\s*\}", kinds, re.S
        )
        peeks = {name for name, importance in rows if importance == "4"}
        self.assertTrue(peeks, "push-kinds.ts names no category at importance 4")

        service = (
            APP
            / "android"
            / "app"
            / "src"
            / "main"
            / "java"
            / "dev"
            / "hermesgots"
            / "GotsMessagingService.kt"
        ).read_text()
        carried = re.search(r"WAITS = setOf\((.*?)\)", service, re.S).group(1)
        self.assertEqual(set(re.findall(r"\"(\w+)\"", carried)), peeks)


class TheHooksInOrder(unittest.TestCase):
    """A failed run's words are read back from the row `failures.after_run` writes, so that hook has
    to run before `alerts.turn_finished` reads it. Hermes calls a hook's listeners in the order
    they were registered, which is a fact about `plugin/__init__.py` and nothing else."""

    def test_the_failure_is_written_before_the_notice_reads_it(self):
        source = (ROOT / "plugin" / "__init__.py").read_text()
        registered = re.findall(r'register_hook\("on_session_end", ([\w.]+)\)', source)
        self.assertIn("failures.after_run", registered)
        self.assertIn("alerts.turn_finished", registered)
        self.assertLess(
            registered.index("failures.after_run"),
            registered.index("alerts.turn_finished"),
            "a failed run's notice would read the failure before it was written",
        )
