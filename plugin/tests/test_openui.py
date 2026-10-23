"""The component library as a system-prompt section: what a new session is told, and what a host
that can't take the section says about itself.

Run: python3 -m unittest plugin.tests.test_openui -v

The section's state is one registration per process, so each case stands in for one plugin load
and puts the module's own answer back first.
"""

from __future__ import annotations

import importlib.util
import shutil
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from plugin import openui

ARTIFACT = Path(openui.__file__).parent / "openui" / "prompt.txt"
UNREGISTERED = openui._refusal_reason


class FakeCtx:
    """The one part of Hermes's plugin context a section needs, and what it was handed."""

    def __init__(self, *, refuses: bool = False) -> None:
        self.calls = []
        self.refuses = refuses

    def register_system_prompt_section(self, section_id, content, **kwargs):
        if self.refuses:
            raise ValueError("this Hermes refuses a section")
        self.calls.append({"id": section_id, "content": content, **kwargs})
        return object()


class SectionState(unittest.TestCase):
    def setUp(self) -> None:
        state = mock.patch.object(openui, "_refusal_reason", UNREGISTERED)
        state.start()
        self.addCleanup(state.stop)


class RegistrationTest(SectionState):
    def test_registers_under_the_id_the_client_reads(self) -> None:
        ctx = FakeCtx()
        self.assertTrue(openui.register(ctx))
        self.assertEqual(ctx.calls[0]["id"], "openui")
        self.assertEqual(ctx.calls[0]["position"], "after_memory")

    def test_a_new_session_is_told_the_artifact(self) -> None:
        ctx = FakeCtx()
        openui.register(ctx)
        told = ctx.calls[0]["content"]
        text = ARTIFACT.read_text(encoding="utf-8")
        self.assertEqual(told({"session_id": "s", "profile_name": "default", "cwd": "/tmp"}), text)
        self.assertEqual(told(), text)
        self.assertIn("openui-lang", text)
        # Over its cap the host drops a section whole rather than truncating it, so the section it
        # was handed has to be under the one the generator and the app's test hold it to.
        self.assertLessEqual(len(text), 4_000)

    def test_a_host_that_predates_the_section_is_told_nothing_about_it(self) -> None:
        ctx = SimpleNamespace(register_hook=lambda *args: None)
        self.assertFalse(openui.register(ctx))
        self.assertIsNone(openui.advertised())

    def test_a_refused_section_leaves_the_plugin_running(self) -> None:
        # The call raises for anything this Hermes doesn't like, and an unguarded one would take
        # every route of the plugin down with it. It still says so in the log.
        with self.assertLogs("plugin.openui", level="WARNING"):
            self.assertFalse(openui.register(FakeCtx(refuses=True)))
        self.assertIsNone(openui.advertised())


class AdvertisementTest(SectionState):
    def test_the_version_rides_beside_the_bare_feature(self) -> None:
        openui.register(FakeCtx())
        header = ARTIFACT.read_text(encoding="utf-8").splitlines()[0]
        self.assertEqual(openui.advertised(), {"version": header.rsplit(" ", 1)[1]})
        self.assertEqual(openui.FEATURE, "openui")
        self.assertNotIn(":", openui.FEATURE)

    def test_a_host_that_cannot_register_advertises_neither(self) -> None:
        # Both of `info`'s splices read this one answer — the feature string and the sibling
        # object — so one None is both halves: no feature entry, and no version beside it.
        openui.register(SimpleNamespace())
        self.assertIsNone(openui.advertised())


class ArtifactTest(unittest.TestCase):
    def test_a_missing_artifact_does_not_break_the_import(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            copy = Path(folder) / "openui.py"
            shutil.copyfile(openui.__file__, copy)
            spec = importlib.util.spec_from_file_location("memento_openui_unreadable", copy)
            module = importlib.util.module_from_spec(spec)
            with self.assertLogs("memento_openui_unreadable", level="WARNING"):
                spec.loader.exec_module(module)
        self.assertEqual(module.TEXT, "")
        self.assertIsNone(module.VERSION)
        self.assertEqual(module.content(), "")
        self.assertFalse(module.register(FakeCtx()))
        self.assertIsNone(module.advertised())

    def test_an_artifact_over_the_limit_is_not_advertised(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            copy = Path(folder) / "openui.py"
            shutil.copyfile(openui.__file__, copy)
            sibling = Path(folder) / "openui"
            sibling.mkdir()
            (sibling / "prompt.txt").write_text(
                "# @openuidev/react-lang 1.0.1\n\n" + "x" * 4_000, encoding="utf-8"
            )
            spec = importlib.util.spec_from_file_location("memento_openui_oversize", copy)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
        self.assertGreater(len(module.TEXT), module.LIMIT)
        self.assertFalse(module.register(FakeCtx()))
        self.assertIsNone(module.advertised())


if __name__ == "__main__":
    unittest.main()
