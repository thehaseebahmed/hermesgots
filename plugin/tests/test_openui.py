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
    """The one part of Hermes's plugin context a section needs, and what it was handed.

    Its lack of `register_skill` is deliberate: this is the host the plugin ships ahead of, which
    takes its sections and has never heard of a bundled skill.
    """

    def __init__(self, *, refuses: bool = False) -> None:
        self.calls = []
        self.refuses = refuses

    def register_system_prompt_section(self, section_id, content, **kwargs):
        if self.refuses:
            raise ValueError("this Hermes refuses a section")
        self.calls.append({"id": section_id, "content": content, **kwargs})
        return object()


class SkillCtx(FakeCtx):
    """That context with the skill API beside it, recording each skill Hermes was handed."""

    def __init__(self, *, refuses: bool = False) -> None:
        super().__init__(refuses=refuses)
        self.skills = []

    def register_skill(self, name, path, description="", frontmatter=None):
        self.skills.append({"name": name, "path": Path(path), "description": description})
        return True


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


class SkillRegistrationTest(SectionState):
    """The three design skills the canvas guide names, handed to a host that can hold them."""

    def test_the_three_skills_are_registered_with_the_files_that_carry_them(self) -> None:
        ctx = SkillCtx()
        openui.register(ctx)
        self.assertEqual(
            [skill["name"] for skill in ctx.skills],
            ["impeccable", "web-design-guidelines", "transitions-dev"],
        )
        self.assertEqual(tuple(openui.SKILLS), tuple(skill["name"] for skill in ctx.skills))
        for skill in ctx.skills:
            # A path the host can't read is a skill that doesn't load, so it is the file that is
            # checked here rather than the name it was handed under.
            self.assertTrue(
                skill["path"].is_file(),
                f"{skill['name']} was registered with {skill['path']}, which isn't a file.",
            )
            self.assertEqual(skill["path"].name, "SKILL.md")
            self.assertEqual(skill["path"].parent.name, skill["name"])

    def test_each_skill_is_listed_by_its_own_description(self) -> None:
        # Hermes lists a skill by what it was registered with, not by what its file says: a name
        # handed over bare is a row with nothing under it, and this guide sends a session to that
        # listing to choose between the three.
        ctx = SkillCtx()
        openui.register(ctx)
        for skill in ctx.skills:
            said = skill["description"]
            self.assertTrue(said, f"{skill['name']} was registered with no description")
            self.assertIn(said, skill["path"].read_text(encoding="utf-8"))
            self.assertNotIn("\n", said)

    def test_a_host_without_the_skill_api_still_loads(self) -> None:
        # The plugin ships ahead of the host it runs on: this Hermes takes both sections, has no
        # `register_skill`, and must still load with every route it serves.
        ctx = FakeCtx()
        self.assertTrue(openui.register(ctx))
        self.assertEqual([call["id"] for call in ctx.calls], ["openui", "canvas"])
        self.assertFalse(hasattr(ctx, "register_skill"))

    def test_a_missing_folder_logs_and_the_others_still_register(self) -> None:
        # A skill removed from an install doesn't fail: it says so in the log and the other two are
        # handed over, since the guide names three and one folder is not the plugin.
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for name in ("impeccable", "transitions-dev"):
                (root / name).mkdir()
                (root / name / "SKILL.md").write_text(f"---\nname: {name}\n---\n", encoding="utf-8")
            ctx = SkillCtx()
            with mock.patch.object(openui, "SKILLS_ROOT", root):
                with self.assertLogs("plugin.openui", level="WARNING"):
                    openui.register(ctx)
        self.assertEqual([skill["name"] for skill in ctx.skills], ["impeccable", "transitions-dev"])


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
    def test_both_artifacts_fit_the_hosts_section_cap(self) -> None:
        # A section over the cap is dropped whole, so an artifact that outgrows it takes its
        # feature with it — the canvas guide did once, and the host said nothing about why.
        self.assertLessEqual(len(openui.TEXT), openui.LIMIT)
        self.assertLessEqual(len(openui.CANVAS_TEXT), openui.LIMIT)

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
