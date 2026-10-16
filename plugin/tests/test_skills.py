"""Tests for the profile-scoped skills list (``plugin/skill_catalog.py``).

Hermes's skills scan and profile scope are stood in for through ``sys.modules`` (the
``test_dictation.py`` pattern), so each test asserts only this module's own rules: what the
scan's rows become, that the scan runs inside the scope for the given profile, and that a Hermes
without those internals raises ImportError.
"""

from __future__ import annotations

import contextlib
import sys
import types
import unittest
from unittest import mock

from plugin import skill_catalog


def hermes(rows=None):
    """Fake ``hermes_cli.web_server_profiles`` and ``tools.skills_tool`` for one test."""
    scopes = []

    @contextlib.contextmanager
    def _profile_scope(profile):
        scopes.append(profile)
        yield

    profiles = types.ModuleType("hermes_cli.web_server_profiles")
    profiles._profile_scope = _profile_scope
    skills = types.ModuleType("tools.skills_tool")
    skills._find_all_skills = lambda: list(rows or [])
    skills._sort_skills = lambda found: sorted(found, key=lambda s: (s.get("category") or "", s["name"]))
    skills.scopes = scopes
    return {"hermes_cli.web_server_profiles": profiles, "tools.skills_tool": skills}


class SkillCatalogTests(unittest.TestCase):
    def test_rows_map_to_name_description_category(self):
        rows = [
            {"name": "plan", "description": "Make a plan", "category": "ops", "tier": "x", "root": "/r"},
            {"name": "github-pr-workflow", "description": "PRs", "category": "git"},
        ]
        with mock.patch.dict(sys.modules, hermes(rows)):
            got = skill_catalog.read("bot-a")
        self.assertEqual(
            got,
            [
                {"name": "github-pr-workflow", "description": "PRs", "category": "git"},
                {"name": "plan", "description": "Make a plan", "category": "ops"},
            ],
        )

    def test_scan_runs_inside_the_given_profile_scope(self):
        stubs = hermes([{"name": "plan", "description": "", "category": None}])
        with mock.patch.dict(sys.modules, stubs):
            skill_catalog.read("bot-a")
            skill_catalog.read(None)
        self.assertEqual(stubs["tools.skills_tool"].scopes, ["bot-a", None])

    def test_missing_hermes_internal_raises_import_error(self):
        with mock.patch.dict(sys.modules, {"tools.skills_tool": None}):
            with self.assertRaises(ImportError):
                skill_catalog.read("bot-a")


if __name__ == "__main__":
    unittest.main()
