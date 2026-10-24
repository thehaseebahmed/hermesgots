"""Tests for the profile-scoped skills read and switch (``plugin/skill_catalog.py``).

Hermes's skills scan, its provenance reads, its disabled list, its config write scope and its
caches are stood in for through ``sys.modules`` (the ``test_dictation.py`` pattern), so each test
asserts only this module's own rules: the row shape the host's answer becomes, which rows are left
out, that the scan runs inside the scope for the given profile, that the helper's name resolves
under either spelling, that only a host with neither spelling raises ImportError, and that the
switch writes one name in the profile's global disabled list inside the host's own write scope —
with the refusals and the cache clearing that go with it.
"""

from __future__ import annotations

import contextlib
import copy
import sys
import types
import unittest
from unittest import mock

from plugin import skill_catalog


class Host:
    """The stand-in host's modules, and what the read and the switch asked of them."""

    def __init__(self):
        self.modules = {}
        self.scopes = []
        self.platforms = []
        self.catalog_calls = {}
        # The switch's own trail: the write scopes entered, the disabled lists saved (with the
        # config each was saved in), and the caches cleared.
        self.write_scopes = []
        self.saves = []
        self.caches = []


def hermes(
    rows=None,
    *,
    catalog=None,
    disabled=(),
    bundled=(),
    hub=(),
    essential=("hermes-agent",),
    project=0,
    plugin_rows=None,
    old_names=False,
    takes_keyword=True,
    omit=(),
    cache_fails=False,
):
    """Fake every host module the read and the switch import lazily, for one test.

    ``rows`` is the plain listing's answer; when it is left out it is built from ``catalog``, so a
    catalog row marked ``hidden`` (one the real scan would drop from the listing) is the only thing
    missing from it. ``omit`` names a module to leave unimportable, and ``cache_fails`` makes the
    skills cache's clear raise, as a host whose cache moved out from under it would.
    """
    host = Host()
    scopes, platforms, catalog_calls = host.scopes, host.platforms, host.catalog_calls

    @contextlib.contextmanager
    def _profile_scope(profile):
        scopes.append(profile)
        yield

    profiles = types.ModuleType("hermes_cli.web_server_profiles")
    profiles._profile_scope = _profile_scope
    host.modules["hermes_cli.web_server_profiles"] = profiles

    # The config write scope, which is what the switch's write has to run inside: a save made while
    # one is held is recorded as such, so a test can assert the ordering rather than infer it.
    held = []

    @contextlib.contextmanager
    def config_write_scope(profile):
        host.write_scopes.append(profile)
        held.append(profile)
        try:
            yield
        finally:
            held.pop()

    common = types.ModuleType("hermes_cli.web_routers._common")
    common.config_write_scope = config_write_scope
    host.modules["hermes_cli.web_routers._common"] = common

    entries = [dict(entry) for entry in catalog] if catalog is not None else None
    if rows is None:
        rows = [
            {
                "name": entry["load_name"],
                "description": entry.get("description", ""),
                "category": entry.get("category"),
            }
            for entry in (entries or [])
            if entry.get("load_name")
            and not entry.get("hidden")
            and entry.get("status") != "shadowed"
        ]
    listed = [dict(row) for row in rows]

    skills = types.ModuleType("tools.skills_tool")
    scan = (
        (lambda **_kwargs: [dict(row) for row in listed])
        if takes_keyword
        else (lambda: [dict(row) for row in listed])
    )
    sort = lambda found: sorted(found, key=lambda s: (s.get("category") or "", s["name"]))
    if old_names:
        skills._find_all_skills = scan
        skills._sort_skills = sort
    else:
        skills.find_all_skills = scan
        skills.sort_skills = sort
    if entries is not None:

        def _skill_catalog(**kwargs):
            catalog_calls.update(kwargs)
            return [{k: v for k, v in entry.items() if k != "hidden"} for entry in entries]

        skills._skill_catalog = _skill_catalog
    host.modules["tools.skills_tool"] = skills

    utils = types.ModuleType("agent.skill_utils")
    utils.ESSENTIAL_SKILLS = frozenset(essential)
    utils.TIER_PROJECT = project
    host.modules["agent.skill_utils"] = utils

    config_state = {"skills": {"disabled": sorted(disabled)}}

    def load_config():
        # A config read is a read of the profile's file: what a save wrote is what the next read
        # sees, which is what makes a switch's answered row the state it landed in.
        return copy.deepcopy(config_state)

    config = types.ModuleType("hermes_cli.config")
    config.load_config = load_config
    host.modules["hermes_cli.config"] = config

    def get_disabled_skills(loaded, platform=None):
        platforms.append(platform)
        return set(loaded["skills"]["disabled"]) - set(essential)

    def save_disabled_skills(loaded, disabled, platform=None):
        # The host's own writer, in its own shape: essential names are subtracted, no platform means
        # the global list, and a platform would write the slot ADR 0044 forbids Gots to write.
        written = set(disabled) - set(essential)
        loaded.setdefault("skills", {})
        if platform is None:
            loaded["skills"]["disabled"] = sorted(written)
        else:
            loaded["skills"].setdefault("platform_disabled", {})[platform] = sorted(written)
        host.saves.append(
            {
                "config": loaded,
                "disabled": sorted(written),
                "platform": platform,
                "in_scope": bool(held),
            }
        )
        # Hermes's writer ends by saving the config it was handed, so that is what a later read of
        # the profile's file now holds.
        config_state.clear()
        config_state.update(copy.deepcopy(loaded))

    skills_config = types.ModuleType("hermes_cli.skills_config")
    skills_config.get_disabled_skills = get_disabled_skills
    skills_config.save_disabled_skills = save_disabled_skills
    host.modules["hermes_cli.skills_config"] = skills_config

    def clear_skills_cache():
        host.caches.append("skills")
        if cache_fails:
            raise RuntimeError("this host's skills cache moved")

    skills.clear_skills_cache = clear_skills_cache

    prompt_builder = types.ModuleType("agent.prompt_builder")

    def clear_skills_system_prompt_cache(clear_snapshot=False):
        host.caches.append(("prompt", clear_snapshot))
        if cache_fails:
            raise RuntimeError("this host's prompt cache moved")

    prompt_builder.clear_skills_system_prompt_cache = clear_skills_system_prompt_cache
    host.modules["agent.prompt_builder"] = prompt_builder

    usage = types.ModuleType("tools.skill_usage")
    usage._read_bundled_names = lambda: set(bundled)
    usage._read_hub_installed_names = lambda: set(hub)
    host.modules["tools.skill_usage"] = usage

    manager = types.SimpleNamespace(
        list_plugin_skill_metadata=lambda: [dict(entry) for entry in (plugin_rows or [])]
    )
    plugins = types.ModuleType("hermes_cli.plugins")
    plugins.get_plugin_manager = lambda: manager
    host.modules["hermes_cli.plugins"] = plugins

    for module in omit:
        host.modules[module] = None
    return host


def scanned(name, **patch):
    """One row the host's scan would resolve: unique and loadable unless the test says otherwise."""
    return {
        "name": name,
        "description": f"{name} does things",
        "category": "ops",
        "tier": 1,
        "status": "unique",
        "load_name": name,
        **patch,
    }


class SkillCatalogTests(unittest.TestCase):
    def test_a_row_carries_where_it_came_from_and_how_it_is_doing(self):
        host = hermes(catalog=[scanned("plan", description="Make a plan")], bundled=("plan",))
        with mock.patch.dict(sys.modules, host.modules):
            got = skill_catalog.read("bot-a")
        self.assertEqual(
            got,
            [
                {
                    "name": "plan",
                    "description": "Make a plan",
                    "category": "ops",
                    "origin": "builtin",
                    "enabled": True,
                    "loadError": None,
                    "switchable": True,
                }
            ],
        )
        # Off skills and hidden ones are what the row's own fields are for, so the scan is asked for
        # both rather than for the menu's own subset.
        self.assertEqual(host.catalog_calls, {"skip_disabled": True, "include_hidden": True})

    def test_each_origin_the_host_reports(self):
        host = hermes(
            catalog=[scanned("plan"), scanned("hub-skill"), scanned("written-here")],
            bundled=("plan",),
            hub=("hub-skill",),
        )
        with mock.patch.dict(sys.modules, host.modules):
            got = skill_catalog.read("bot-a")
        self.assertEqual(
            [(row["name"], row["origin"]) for row in got],
            [("hub-skill", "hub"), ("plan", "builtin"), ("written-here", "yours")],
        )

    def test_a_plain_listing_answers_a_host_without_the_catalog(self):
        host = hermes([{"name": "plan", "description": "", "category": None}])
        with mock.patch.dict(sys.modules, host.modules):
            got = skill_catalog.read("bot-a")
        self.assertEqual(
            got,
            [
                {
                    "name": "plan",
                    "description": "",
                    "category": None,
                    "origin": "yours",
                    "enabled": True,
                    "loadError": None,
                    "switchable": True,
                }
            ],
        )

    def test_a_host_whose_helpers_ship_underscored_still_answers(self):
        host = hermes(
            [{"name": "plan", "description": "Make a plan", "category": "ops"}], old_names=True
        )
        with mock.patch.dict(sys.modules, host.modules):
            got = skill_catalog.read("bot-a")
        self.assertEqual([row["name"] for row in got], ["plan"])

    def test_a_listing_that_takes_no_keyword_still_answers(self):
        host = hermes([{"name": "plan", "description": "", "category": None}], takes_keyword=False)
        with mock.patch.dict(sys.modules, host.modules):
            got = skill_catalog.read("bot-a")
        self.assertEqual([row["name"] for row in got], ["plan"])

    def test_neither_naming_raises_import_error(self):
        bare = hermes()
        for skills in (
            types.ModuleType("tools.skills_tool"),
            # A module that has one of the two: half a listing is no listing at all.
            types.SimpleNamespace(find_all_skills=lambda: []),
        ):
            with mock.patch.dict(
                sys.modules,
                dict(bare.modules, **{"tools.skills_tool": skills}),
            ):
                with self.assertRaises(ImportError):
                    skill_catalog.read("bot-a")

    def test_a_shadowed_copy_and_a_project_skill_are_left_out(self):
        host = hermes(
            catalog=[
                scanned("plan"),
                scanned("plan", tier=3, status="shadowed", load_name=None),
                scanned("repo-only", tier=0),
            ],
            project=0,
        )
        with mock.patch.dict(sys.modules, host.modules):
            got = skill_catalog.read("bot-a")
        self.assertEqual([row["name"] for row in got], ["plan"])

    def test_a_disabled_skill_is_off(self):
        host = hermes(catalog=[scanned("plan"), scanned("log-triage")], disabled=("plan",))
        with mock.patch.dict(sys.modules, host.modules):
            got = skill_catalog.read("bot-a")
        self.assertEqual(
            [(row["name"], row["enabled"]) for row in got],
            [("log-triage", True), ("plan", False)],
        )
        # The global list, which is the only one Gots writes: a platform would mean another answer.
        self.assertEqual(host.platforms, [None])

    def test_an_essential_skill_has_no_switch(self):
        host = hermes(catalog=[scanned("hermes-agent"), scanned("plan")])
        with mock.patch.dict(sys.modules, host.modules):
            got = skill_catalog.read("bot-a")
        self.assertEqual(
            [(row["name"], row["switchable"]) for row in got],
            [("hermes-agent", False), ("plan", True)],
        )

    def test_a_skill_this_platform_cant_run_says_so(self):
        host = hermes(catalog=[scanned("plan"), scanned("mac-only", hidden=True)])
        with mock.patch.dict(sys.modules, host.modules):
            got = skill_catalog.read("bot-a")
        self.assertEqual(
            [(row["name"], row["loadError"]) for row in got],
            [
                ("mac-only", "Skill 'mac-only' is not supported on this platform or environment."),
                ("plan", None),
            ],
        )

    def test_a_name_two_copies_share_says_so(self):
        host = hermes(catalog=[scanned("one", status="ambiguous", load_name=None)])
        with mock.patch.dict(sys.modules, host.modules):
            got = skill_catalog.read("bot-a")
        self.assertEqual(
            [(row["name"], row["loadError"]) for row in got],
            [("one", "Ambiguous skill name 'one': another copy shares it.")],
        )

    def test_plugin_skills_are_merged_after_the_profiles_own(self):
        host = hermes(
            catalog=[scanned("plan")],
            disabled=("ops:deploy",),
            plugin_rows=[
                {
                    "name": "ops:deploy",
                    "description": "Deploy it",
                    "category": "plugin",
                    "frontmatter": {},
                },
                {"name": "ops:rollback", "description": "", "category": "plugin", "frontmatter": {}},
            ],
        )
        with mock.patch.dict(sys.modules, host.modules):
            got = skill_catalog.read("bot-a")
        self.assertEqual(
            got,
            [
                {
                    "name": "plan",
                    "description": "plan does things",
                    "category": "ops",
                    "origin": "yours",
                    "enabled": True,
                    "loadError": None,
                    "switchable": True,
                },
                {
                    "name": "ops:deploy",
                    "description": "Deploy it",
                    "category": "plugin",
                    "origin": "plugin",
                    "enabled": False,
                    "loadError": None,
                    "switchable": True,
                },
                {
                    "name": "ops:rollback",
                    "description": "",
                    "category": "plugin",
                    "origin": "plugin",
                    "enabled": True,
                    "loadError": None,
                    "switchable": True,
                },
            ],
        )

    def test_a_plugin_skill_the_profile_also_has_keeps_the_profiles_row(self):
        host = hermes(
            catalog=[scanned("plan")],
            plugin_rows=[
                {"name": "plan", "description": "From a plugin", "category": "plugin",
                 "frontmatter": {}},
            ],
        )
        with mock.patch.dict(sys.modules, host.modules):
            got = skill_catalog.read("bot-a")
        self.assertEqual([(row["name"], row["origin"]) for row in got], [("plan", "yours")])

    def test_the_scan_runs_inside_the_given_profile_scope(self):
        host = hermes(catalog=[scanned("plan")])
        with mock.patch.dict(sys.modules, host.modules):
            skill_catalog.read("bot-a")
            skill_catalog.read(None)
        self.assertEqual(host.scopes, ["bot-a", None])

    def test_a_host_without_the_provenance_reads_calls_every_local_skill_yours(self):
        host = hermes(catalog=[scanned("plan")], bundled=("plan",), omit=("tools.skill_usage",))
        with mock.patch.dict(sys.modules, host.modules):
            got = skill_catalog.read("bot-a")
        self.assertEqual([row["origin"] for row in got], ["yours"])

    def test_a_host_without_the_skills_config_leaves_enabled_out(self):
        host = hermes(catalog=[scanned("plan")], omit=("hermes_cli.skills_config",))
        with mock.patch.dict(sys.modules, host.modules):
            got = skill_catalog.read("bot-a")
        self.assertEqual(
            got,
            [
                {
                    "name": "plan",
                    "description": "plan does things",
                    "category": "ops",
                    "origin": "yours",
                    "loadError": None,
                    "switchable": True,
                }
            ],
        )

    def test_a_host_without_the_essential_skills_leaves_switchable_out(self):
        host = hermes(catalog=[scanned("plan")], omit=("agent.skill_utils",))
        with mock.patch.dict(sys.modules, host.modules):
            got = skill_catalog.read("bot-a")
        self.assertNotIn("switchable", got[0])

    def test_a_host_without_a_plugin_registry_keeps_the_profiles_rows(self):
        host = hermes(catalog=[scanned("plan")], omit=("hermes_cli.plugins",))
        with mock.patch.dict(sys.modules, host.modules):
            got = skill_catalog.read("bot-a")
        self.assertEqual([row["name"] for row in got], ["plan"])


class SkillSwitchTests(unittest.TestCase):
    """The one write this module makes: one name in the profile's global disabled list."""

    def switched(self, host, name="plan", enabled=False, profile="bot-a"):
        with mock.patch.dict(sys.modules, host.modules):
            return skill_catalog.set_enabled(profile, name, enabled)

    def test_switching_one_off_adds_that_name_to_the_global_list(self):
        host = hermes(catalog=[scanned("plan"), scanned("log-triage")], disabled=("log-triage",))
        row = self.switched(host, "plan", False)
        (save,) = host.saves
        # The key written is the global disabled set, the rest of the list left as it was.
        self.assertEqual(save["disabled"], ["log-triage", "plan"])
        self.assertEqual(save["config"]["skills"]["disabled"], ["log-triage", "plan"])
        # And nothing else: the per-platform slot is never what a Gots switch writes (ADR 0044),
        # which is the one assertion this feature's risk turns on.
        self.assertNotIn("platform_disabled", save["config"]["skills"])
        self.assertIsNone(save["platform"])
        self.assertEqual(set(host.platforms), {None})
        # The write ran inside the host's own config write scope, for this bot.
        self.assertEqual(host.write_scopes, ["bot-a"])
        self.assertTrue(save["in_scope"])
        self.assertFalse(row["enabled"])

    def test_switching_one_on_discards_that_name_and_keeps_the_rest(self):
        host = hermes(
            catalog=[scanned("plan"), scanned("log-triage")],
            disabled=("plan", "log-triage"),
        )
        row = self.switched(host, "plan", True)
        (save,) = host.saves
        self.assertEqual(save["disabled"], ["log-triage"])
        self.assertTrue(row["enabled"])

    def test_a_plugin_skill_is_written_by_the_name_its_row_carries(self):
        host = hermes(
            catalog=[scanned("plan")],
            plugin_rows=[
                {"name": "ops:deploy", "description": "", "category": "plugin", "frontmatter": {}},
            ],
        )
        row = self.switched(host, "ops:deploy", False)
        (save,) = host.saves
        self.assertEqual(save["disabled"], ["ops:deploy"])
        self.assertFalse(row["enabled"])

    def test_a_switch_clears_both_of_hermes_caches(self):
        host = hermes(catalog=[scanned("plan")])
        self.switched(host)
        # Hermes's scan, then its prompt snapshot: the second is what makes the change live for the
        # next turn without a chat in flight losing the abilities it had.
        self.assertEqual(host.caches, ["skills", ("prompt", True)])

    def test_a_cache_that_cant_be_cleared_still_answers_the_switch(self):
        host = hermes(catalog=[scanned("plan")], cache_fails=True)
        row = self.switched(host)
        # Both clears were attempted and neither failure was allowed to undo the write.
        self.assertEqual(host.caches, ["skills", ("prompt", True)])
        self.assertEqual(len(host.saves), 1)
        self.assertFalse(row["enabled"])

    def test_an_essential_skill_is_refused_in_words_before_anything_is_written(self):
        host = hermes(catalog=[scanned("hermes-agent")])
        with mock.patch.dict(sys.modules, host.modules):
            with self.assertRaises(skill_catalog.SkillError) as caught:
                skill_catalog.set_enabled("bot-a", "hermes-agent", False)
        self.assertEqual(caught.exception.status, 400)
        self.assertEqual(str(caught.exception), skill_catalog.ESSENTIAL % "hermes-agent")
        self.assertEqual(host.saves, [])
        self.assertEqual(host.write_scopes, [])

    def test_a_name_the_bot_hasnt_got_is_refused_before_anything_is_written(self):
        host = hermes(catalog=[scanned("plan")])
        with mock.patch.dict(sys.modules, host.modules):
            with self.assertRaises(skill_catalog.SkillError) as caught:
                skill_catalog.set_enabled("bot-a", "ghost", False)
        self.assertEqual(caught.exception.status, 400)
        self.assertEqual(str(caught.exception), skill_catalog.NOT_FOUND % "ghost")
        self.assertEqual(host.saves, [])
        self.assertEqual(host.write_scopes, [])

    def test_a_host_without_the_write_machinery_refuses_with_its_own_reason(self):
        host = hermes(catalog=[scanned("plan")], omit=("hermes_cli.skills_config",))
        with mock.patch.dict(sys.modules, host.modules):
            with self.assertRaises(skill_catalog.SkillError) as caught:
                skill_catalog.set_enabled("bot-a", "plan", False)
        self.assertEqual(caught.exception.status, 501)
        self.assertEqual(str(caught.exception), skill_catalog.UNAVAILABLE_WRITE)


class FeatureTests(unittest.TestCase):
    def test_the_gate_says_why_a_host_without_a_listing_cannot_be_read(self):
        with mock.patch.dict(sys.modules, {"tools.skills_tool": None}):
            self.assertEqual(skill_catalog.available(), skill_catalog.UNAVAILABLE)

    def test_the_gate_is_quiet_where_the_listing_imports(self):
        host = hermes(catalog=[scanned("plan")])
        with mock.patch.dict(sys.modules, host.modules):
            self.assertIsNone(skill_catalog.available())

    def test_the_switch_gate_says_why_a_host_without_the_write_cannot_switch(self):
        host = hermes(catalog=[scanned("plan")], omit=("hermes_cli.web_routers._common",))
        with mock.patch.dict(sys.modules, host.modules):
            self.assertEqual(skill_catalog.writable(), skill_catalog.UNAVAILABLE_WRITE)

    def test_the_switch_gate_is_quiet_where_the_write_imports(self):
        host = hermes(catalog=[scanned("plan")])
        with mock.patch.dict(sys.modules, host.modules):
            self.assertIsNone(skill_catalog.writable())

    def test_the_features_are_the_list_and_its_switch(self):
        self.assertEqual(
            [name for name, _gate in skill_catalog.FEATURES], ["skills", "skills_write"]
        )


if __name__ == "__main__":
    unittest.main()
