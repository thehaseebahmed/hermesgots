"""The artefacts a canvas session is handed: the design spec, and the copy the plugin ships of it.

Run: python3 -m unittest plugin.tests.test_canvas_artifacts -v

The spec is authored once, at the repo root, where the app and anyone reading the repository find it.
A plugin is installed without the repository, so it carries its own copy beside the canvas guide — and
a copy is only worth having if it is the same file, so this module holds the two to one set of bytes
rather than to two documents that are meant to agree.
"""

from __future__ import annotations

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC = ROOT / "DESIGN.md"
PLUGIN_COPY = ROOT / "plugin" / "canvas" / "DESIGN.md"


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


if __name__ == "__main__":
    unittest.main()
