"""The artefacts a canvas session is handed: the design spec, the copy the plugin ships of it, and the
three design skills bundled beside them.

Run: python3 -m unittest plugin.tests.test_canvas_artifacts -v

The spec is authored once, at the repo root, where the app and anyone reading the repository find it.
A plugin is installed without the repository, so it carries its own copy beside the canvas guide — and
a copy is only worth having if it is the same file, so this module holds the two to one set of bytes
rather than to two documents that are meant to agree.

The skills are vendored snapshots of three upstreams, read-only and stripped of anything a scanner
would run or a host execute: no script, no launcher, no engine. Each folder names itself in its own
frontmatter, which is the name `openui.py` registers it under.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path
from typing import List, Optional

ROOT = Path(__file__).resolve().parents[2]
SPEC = ROOT / "DESIGN.md"
PLUGIN_COPY = ROOT / "plugin" / "canvas" / "DESIGN.md"
SKILLS = ROOT / "plugin" / "skills"

# The three the canvas guide names, in the order `openui.py` registers them.
BUNDLED = ("impeccable", "web-design-guidelines", "transitions-dev")
# An extension a host could load and run, and the shebang that makes a suffixless file one anyway.
RUNNABLE = {".py", ".js", ".mjs", ".sh"}


class SpecCopyTest(unittest.TestCase):
    """DESIGN.md at the root and the copy in `plugin/canvas/` are one file."""

    def test_the_plugin_ships_the_spec_byte_for_byte(self) -> None:
        self.assertTrue(
            SPEC.is_file(),
            f"{SPEC} is missing: the design spec is authored at the repo root.",
        )
        self.assertTrue(
            PLUGIN_COPY.is_file(),
            f"{PLUGIN_COPY} is missing: copy DESIGN.md into plugin/canvas/, "
            "since a plugin is installed without the repository.",
        )

        spec, copy = SPEC.read_bytes(), PLUGIN_COPY.read_bytes()
        self.assertEqual(
            len(copy),
            len(spec),
            f"{PLUGIN_COPY.relative_to(ROOT)} is {len(copy)} bytes where DESIGN.md is {len(spec)}.",
        )
        self.assertEqual(
            copy,
            spec,
            f"{PLUGIN_COPY.relative_to(ROOT)} is not DESIGN.md's own bytes: copy it again "
            "(cp DESIGN.md plugin/canvas/DESIGN.md) rather than editing the two.",
        )


def _frontmatter_colours(text: str) -> List[str]:
    """The colour names a spec declares, from its `colors:` map, in the order it writes them."""
    names: List[str] = []
    inside = False
    for line in text.splitlines():
        if line.startswith("colors:"):
            inside = True
            continue
        if inside:
            if line[:1] not in (" ", "\t"):
                break
            name, sep, _value = line.strip().partition(":")
            if sep and name:
                # A nested key is a property of the token above it, not a token of its own.
                names.append(name)
    return names


class SpecAgainstTheAppTest(unittest.TestCase):
    """The spec says what the app's stylesheet says, or the next rename goes unnoticed."""

    def test_every_colour_it_documents_is_one_the_app_declares(self) -> None:
        # The copy test above keeps the two specs identical, and the linter keeps the spec coherent;
        # neither can tell that `app/src/index.css` renamed a token. This is the one test that fails
        # when the spec and the stylesheet drift, which is the only way a rename could land silently.
        css = (ROOT / "app" / "src" / "index.css").read_text(encoding="utf-8")
        declared = set(re.findall(r"^\s*--([a-z0-9-]+)\s*:", css, re.M))
        documented = _frontmatter_colours(SPEC.read_text(encoding="utf-8"))
        self.assertTrue(documented, "DESIGN.md declares no colours at all")
        missing = sorted(name for name in documented if name not in declared)
        self.assertEqual(
            missing,
            [],
            "DESIGN.md documents colours app/src/index.css doesn't declare: "
            + ", ".join(missing),
        )


def _frontmatter_name(text: str) -> Optional[str]:
    """The `name:` a SKILL.md declares at the top level of its frontmatter, or None where it has none."""
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return None
    for line in lines[1:]:
        if line.strip() == "---":
            break
        # An indented key belongs to a nested map (a skill's `metadata:`), not to the skill's name.
        if line[:1] in (" ", "\t"):
            continue
        key, _, value = line.partition(":")
        if key.strip() == "name":
            return value.strip().strip("\"'") or None
    return None


class BundledSkillsTest(unittest.TestCase):
    """The three design skills, as the plugin ships them."""

    def test_the_three_folders_are_there(self) -> None:
        for name in BUNDLED:
            skill = SKILLS / name / "SKILL.md"
            self.assertTrue(
                skill.is_file(),
                f"{skill.relative_to(ROOT)} is missing: the canvas guide names this skill, "
                "so a session that loads it has to find it.",
            )

    def test_each_folder_names_itself_in_its_skill_md(self) -> None:
        # Hermes reads the folder for the skill's file and its frontmatter for the name, so the two
        # disagreeing would register `impeccable` from one place and show another.
        for name in BUNDLED:
            text = (SKILLS / name / "SKILL.md").read_text(encoding="utf-8")
            self.assertEqual(
                _frontmatter_name(text),
                name,
                f"plugin/skills/{name}/SKILL.md's frontmatter `name` is "
                f"{_frontmatter_name(text)!r}, not {name!r}.",
            )

    def test_nothing_under_the_skills_can_run(self) -> None:
        # A vendored skill is read, never executed: the engine, the launcher and the hooks were cut
        # from impeccable, and a script arriving with a snapshot would be something the install
        # scanner has to inspect and the host could run.
        self.assertTrue(SKILLS.is_dir(), f"{SKILLS} is missing: the plugin bundles three skills.")
        offenders = []
        for path in sorted(SKILLS.rglob("*")):
            if not path.is_file():
                continue
            if path.suffix in RUNNABLE:
                offenders.append(f"{path.relative_to(ROOT)} ({path.suffix})")
            elif path.read_bytes()[:2] == b"#!":
                offenders.append(f"{path.relative_to(ROOT)} (shebang)")
        self.assertEqual(offenders, [], "these bundled files could be run: " + ", ".join(offenders))

    def test_the_licences_travel_with_their_skills(self) -> None:
        # A vendored snapshot that loses its notice is a licence problem, not a missing file: Apache-2.0
        # wants its attribution, transitions-dev its own terms, and the guidelines their MIT line.
        for relative in (
            "impeccable/NOTICE",
            "web-design-guidelines/LICENSE",
            "transitions-dev/LICENSE.txt",
        ):
            path = SKILLS / relative
            self.assertTrue(path.is_file(), f"plugin/skills/{relative} is missing.")
            self.assertTrue(
                path.read_text(encoding="utf-8").strip(),
                f"plugin/skills/{relative} is empty.",
            )


if __name__ == "__main__":
    unittest.main()
