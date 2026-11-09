"""The plugin's two version stamps, held to one answer.

``plugin.yaml`` is what Hermes reads to decide an install's version, and ``dashboard/manifest.json``
is what the dashboard tab reports beside it. They are written by hand in two files and nothing has
ever compared them, so #960 bumped one and the other was left at 0.112.0 while the plugin answered
0.113.0 — a release that names one version in two files can't be checked against anything.

Run: python3 -m unittest plugin.tests.test_plugin_versions -v
"""

from __future__ import annotations

import json
import re
import unittest
from pathlib import Path

PLUGIN = Path(__file__).resolve().parents[1]
MANIFEST = PLUGIN / "dashboard" / "manifest.json"
YAML = PLUGIN / "plugin.yaml"


def manifest_version() -> str:
    return str(json.loads(MANIFEST.read_text(encoding="utf-8"))["version"])


def yaml_version() -> str:
    text = YAML.read_text(encoding="utf-8")
    found = re.search(r"^version:\s*[\"']?([^\"'\s]+)", text, re.M)
    return found.group(1) if found else ""


class VersionParityTest(unittest.TestCase):
    def test_both_files_name_the_same_version(self) -> None:
        # One version, two stamps: a release that moves one and not the other is a plugin whose
        # dashboard and whose loader disagree about what was installed.
        self.assertEqual(yaml_version(), manifest_version())

    def test_the_version_is_three_numbers(self) -> None:
        # Hermes compares versions as numbers, and the app's MIN_PLUGIN_VERSION is read the same way,
        # so a stamp that isn't a plain major.minor.patch is one neither side can order.
        self.assertRegex(yaml_version(), r"^\d+\.\d+\.\d+$")
