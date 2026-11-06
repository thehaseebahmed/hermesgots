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
from plugin.store import db_path

ARTIFACT = Path(openui.__file__).parent / "openui" / "prompt.txt"
APP_ARTIFACT = Path(openui.__file__).parent / "openui" / "app-prompt.txt"
UNREGISTERED = openui._refusal_reason
UNREGISTERED_APP = openui._app_refusal_reason


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
        app_state = mock.patch.object(openui, "_app_refusal_reason", UNREGISTERED_APP)
        state.start()
        app_state.start()
        self.addCleanup(state.stop)
        self.addCleanup(app_state.stop)


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


class AppSectionTest(SectionState):
    def test_the_app_section_registers_under_its_own_id(self) -> None:
        ctx = FakeCtx()
        self.assertTrue(openui.app_register(ctx))
        self.assertEqual(ctx.calls[0]["id"], "apps")
        self.assertEqual(ctx.calls[0]["position"], "after_memory")
        self.assertEqual(ctx.calls[0]["content"], openui.app_content)

    def test_a_host_that_predates_the_app_section_advertises_no_apps(self) -> None:
        # A host whose plugin predates the feature answers no app feature, and the screen reads
        # that as "this bot cannot make apps" rather than as a fault (ADR 0101).
        ctx = SimpleNamespace(register_hook=lambda *args: None)
        self.assertFalse(openui.app_register(ctx))
        self.assertIsNone(openui.app_advertised())

    def test_a_refused_app_section_leaves_both_sections_working_alone(self) -> None:
        with self.assertLogs("plugin.openui", level="WARNING"):
            self.assertFalse(openui.app_register(FakeCtx(refuses=True)))
        self.assertIsNone(openui.app_advertised())
        self.assertTrue(openui.register(FakeCtx()))
        self.assertIsNotNone(openui.advertised())

    def test_the_app_version_rides_beside_its_feature(self) -> None:
        openui.app_register(FakeCtx())
        header = APP_ARTIFACT.read_text(encoding="utf-8").splitlines()[0]
        self.assertEqual(openui.app_advertised(), {"version": header.rsplit(" ", 1)[1]})
        self.assertEqual(openui.APP_FEATURE, "apps")
        self.assertNotIn(":", openui.APP_FEATURE)


class AppRunTest(unittest.TestCase):
    """The seam the two sections divide sessions by: a marked run is an app's, anything else a chat's."""

    def setUp(self) -> None:
        self.home = Path(tempfile.mkdtemp())
        self.path = db_path(self.home)

    def home_for(self):
        return mock.patch.object(openui, "path_for", return_value=self.path)

    def test_a_marked_run_is_told_the_app_section_and_none_of_the_chats(self) -> None:
        with self.home_for():
            self.assertTrue(openui.mark_app_run("run-1"))
            session = {"session_id": "run-1", "profile_name": "default"}
            self.assertEqual(openui.app_content(session), openui.APP_TEXT)
            self.assertEqual(openui.content(session), "")

    def test_a_chat_is_told_the_library_and_none_of_the_apps_rules(self) -> None:
        with self.home_for():
            session = {"session_id": "chat-1", "profile_name": "default"}
            self.assertEqual(openui.content(session), openui.TEXT)
            self.assertEqual(openui.app_content(session), "")

    def test_a_mark_names_one_session_alone(self) -> None:
        with self.home_for():
            self.assertTrue(openui.mark_app_run("run-1"))
            self.assertTrue(openui.is_app_run({"session_id": "run-1"}, self.path))
            self.assertFalse(openui.is_app_run({"session_id": "run-2"}, self.path))
            self.assertFalse(openui.is_app_run({}, self.path))
            self.assertFalse(openui.is_app_run(None, self.path))

    def test_off_withholds_both_sections_even_from_an_app_run(self) -> None:
        with self.home_for():
            self.assertTrue(openui.mark_app_run("run-1"))
            openui.set_enabled(self.path, False)
            session = {"session_id": "run-1"}
            self.assertEqual(openui.app_content(session), "")
            self.assertEqual(openui.content(session), "")
            openui.set_enabled(self.path, True)
            self.assertEqual(openui.app_content(session), openui.APP_TEXT)

    def test_a_finished_run_forgets_its_mark(self) -> None:
        with self.home_for():
            self.assertTrue(openui.mark_app_run("run-1"))
            openui.unmark_app_run("run-1")
            self.assertFalse(openui.is_app_run({"session_id": "run-1"}, self.path))
            # And a clear with nothing to clear, or no session at all, is a quiet no-op.
            openui.unmark_app_run("run-1")
            openui.unmark_app_run(None)
            openui.unmark_app_run("")

    def test_a_mark_with_no_session_or_no_store_marks_nothing(self) -> None:
        with self.home_for():
            self.assertFalse(openui.mark_app_run(""))
        with mock.patch.object(openui, "path_for", return_value=None):
            self.assertFalse(openui.mark_app_run("run-1"))


class ArtifactTest(unittest.TestCase):
    def test_a_missing_artifact_does_not_break_the_import(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            copy = Path(folder) / "openui.py"
            shutil.copyfile(openui.__file__, copy)
            spec = importlib.util.spec_from_file_location("gots_openui_unreadable", copy)
            module = importlib.util.module_from_spec(spec)
            with self.assertLogs("gots_openui_unreadable", level="WARNING"):
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
            spec = importlib.util.spec_from_file_location("gots_openui_oversize", copy)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
        self.assertGreater(len(module.TEXT), module.LIMIT)
        self.assertFalse(module.register(FakeCtx()))
        self.assertIsNone(module.advertised())


if __name__ == "__main__":
    unittest.main()
