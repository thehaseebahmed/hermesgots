"""Tests for the profile-scoped skills read, switch and sheet (``plugin/skill_catalog.py``).

Hermes's skills scan, its provenance reads, its disabled list, its config write scope, its caches and
the manager's own skill lookup are stood in for through ``sys.modules`` (the ``test_dictation.py``
pattern), so each test asserts only this module's own rules: the row shape the host's answer becomes,
which rows are left out, that the scan runs inside the scope for the given profile, that the helper's
name resolves under either spelling, that only a host with neither spelling raises ImportError, that
the switch writes one name in the profile's global disabled list inside the host's own write scope —
with the refusals and the cache clearing that go with it — and that one skill's sheet reads that
skill's own file, for a switched-off skill too, with one of its files read only when it is asked for,
and that a removal takes the operation its origin has (the Hub's uninstall, the manager's delete) or
answers that origin's own refusal.
"""

from __future__ import annotations

import contextlib
import copy
import sys
import types
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
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
        # The removal's own: which helper was called, with what, and inside which scope.
        self.uninstalls = []
        self.deletes = []
        # How many profile scopes are held right now, so a removal records whether the helper it
        # called ran inside the one the request makes.
        self.inside = 0


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
    skill_dirs=None,
    plugin_dirs=None,
    linked=None,
    readiness=None,
    uninstall=(True, "Uninstalled"),
    delete=None,
):
    """Fake every host module the read, the switch and the sheet import lazily, for one test.

    ``rows`` is the plain listing's answer; when it is left out it is built from ``catalog``, so a
    catalog row marked ``hidden`` (one the real scan would drop from the listing) is the only thing
    missing from it. ``omit`` names a module to leave unimportable, and ``cache_fails`` makes the
    skills cache's clear raise, as a host whose cache moved out from under it would. ``skill_dirs``
    maps a skill's name to its folder for the manager's own lookup, ``plugin_dirs`` does the same for
    the registry's, ``linked`` is what the linked-file listing answers, and ``readiness`` is the
    ``(fields, extras)`` pair the readiness read answers — left out, the host can't say either.
    ``uninstall`` is what the Hub's own uninstall answers — its ``(ok, message)`` pair — and
    ``delete`` what the manager's delete answers (its own dict, or None for a plain success).
    """
    host = Host()
    scopes, platforms, catalog_calls = host.scopes, host.platforms, host.catalog_calls

    @contextlib.contextmanager
    def _profile_scope(profile):
        scopes.append(profile)
        host.inside += 1
        try:
            yield
        finally:
            host.inside -= 1

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
        list_plugin_skill_metadata=lambda: [dict(entry) for entry in (plugin_rows or [])],
        find_plugin_skill=lambda name: (plugin_dirs or {}).get(name),
    )
    plugins = types.ModuleType("hermes_cli.plugins")
    plugins.get_plugin_manager = lambda: manager
    host.modules["hermes_cli.plugins"] = plugins

    # The sheet's read of one skill: the manager's own lookup, which answers for a switched-off skill
    # (the whole reason the sheet doesn't go through `skill_view`, which is here to fail loudly if
    # anything ever reaches for it), and the host's own utf-8-sig read of a skill's text.
    folders = dict(skill_dirs or {})
    manager_tool = types.ModuleType("tools.skill_manager_tool")
    manager_tool._find_skill = lambda name: {"path": folders[name]} if name in folders else None
    host.modules["tools.skill_manager_tool"] = manager_tool

    # The two removals, each the host's own answer: the Hub's tuple for a name its lock file knows,
    # the manager's dict for a skill on the profile — a refusal included, which is the sentence the
    # screen shows. A removal that lands takes the row out of the listing, so the read after it is
    # the list the host would really answer.
    def forget(name):
        # Both the plain listing and the scan's resolved rows, since which one the read uses is the
        # host's own business: after a removal neither carries the skill any more.
        listed[:] = [row for row in listed if row.get("name") != name]
        if entries is not None:
            entries[:] = [
                entry
                for entry in entries
                if entry.get("load_name") != name and entry.get("name") != name
            ]

    def uninstall_skill(name):
        host.uninstalls.append({"name": name, "in_scope": host.inside > 0})
        if uninstall[0]:
            forget(name)
        return uninstall

    hub_install = types.ModuleType("tools.skills_hub_install")
    hub_install.uninstall_skill = uninstall_skill
    host.modules["tools.skills_hub_install"] = hub_install

    def _delete_skill(name, absorbed_into=None):
        host.deletes.append(
            {"name": name, "absorbed_into": absorbed_into, "in_scope": host.inside > 0}
        )
        if delete is None:
            answer = {"success": True, "message": f"Skill '{name}' deleted."}
        else:
            answer = dict(delete)
        if answer.get("success"):
            forget(name)
        return answer

    manager_tool._delete_skill = _delete_skill

    def skill_view(*_args, **_kwargs):
        raise AssertionError("a skill's sheet must not read through skill_view")

    skills.skill_view = skill_view
    skills._read_skill_text = lambda path: Path(path).read_text(encoding="utf-8-sig")
    if linked is not None:
        skills._skill_linked_files = lambda folder: dict(linked)
    if readiness is not None:
        skills._safe_frontmatter = lambda path=None, *, content=None: {"name": "plan"}

        def _skill_readiness(frontmatter, skill_name):
            fields, extras = readiness
            return dict(fields), dict(extras)

        skills._skill_readiness = _skill_readiness

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


class SkillSheetTests(unittest.TestCase):
    """One skill read on its own: its sheet's payload, and one of its files at a time."""

    def setUp(self) -> None:
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def skill(self, name: str = "plan", body: str = "# Plan\n\nWrite it down.\n", **files: str) -> Path:
        """One skill's folder on disk: its SKILL.md, and a file per ``files`` path."""
        folder = self.root / name
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "SKILL.md").write_text(body, encoding="utf-8")
        for path, text in files.items():
            target = folder / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text, encoding="utf-8")
        return folder

    def viewed(self, host, name="plan", profile="bot-a"):
        with mock.patch.dict(sys.modules, host.modules):
            return skill_catalog.view(profile, name)

    def test_a_sheet_is_the_rows_fields_the_skill_and_its_files(self):
        folder = self.skill(**{"references/api.md": "The API.\n"})
        host = hermes(
            catalog=[scanned("plan", description="Make a plan")],
            bundled=("plan",),
            skill_dirs={"plan": folder},
            linked={"references": ["references/api.md"]},
        )
        got = self.viewed(host)
        self.assertEqual(got["name"], "plan")
        self.assertEqual(got["description"], "Make a plan")
        self.assertEqual(got["category"], "ops")
        self.assertEqual(got["origin"], "builtin")
        self.assertTrue(got["enabled"])
        self.assertIsNone(got["loadError"])
        self.assertTrue(got["switchable"])
        # The file as it is, with nothing preprocessed out of it.
        self.assertEqual(got["content"], "# Plan\n\nWrite it down.\n")
        self.assertEqual(got["linkedFiles"], {"references": ["references/api.md"]})
        # The row is the list's own, read inside the profile's scope like every read here.
        self.assertEqual(host.scopes, ["bot-a"])

    def test_a_switched_off_skill_opens_like_any_other(self):
        folder = self.skill()
        host = hermes(catalog=[scanned("plan")], disabled=("plan",), skill_dirs={"plan": folder})
        got = self.viewed(host)
        # The row still says Off — that is what the sheet is opened to look at — and the file is
        # there: the read never goes near `skill_view`, which refuses exactly this skill.
        self.assertFalse(got["enabled"])
        self.assertEqual(got["content"], "# Plan\n\nWrite it down.\n")

    def test_a_name_the_bot_hasnt_got_is_a_404(self):
        host = hermes(catalog=[scanned("plan")], skill_dirs={})
        with mock.patch.dict(sys.modules, host.modules):
            with self.assertRaises(skill_catalog.SkillError) as caught:
                skill_catalog.view("bot-a", "ghost")
        self.assertEqual(caught.exception.status, 404)
        self.assertEqual(str(caught.exception), "Skill 'ghost' isn't on this bot.")

    def test_a_skill_the_host_cannot_resolve_is_refused_in_the_rows_own_words(self):
        host = hermes(catalog=[scanned("one", status="ambiguous", load_name=None)], skill_dirs={})
        with mock.patch.dict(sys.modules, host.modules):
            with self.assertRaises(skill_catalog.SkillError) as caught:
                skill_catalog.view("bot-a", "one")
        self.assertEqual(caught.exception.status, 404)
        self.assertEqual(
            str(caught.exception), "Ambiguous skill name 'one': another copy shares it."
        )

    def test_a_plugin_skills_sheet_is_found_in_the_registry(self):
        folder = self.skill("deploy")
        host = hermes(
            catalog=[scanned("plan")],
            plugin_rows=[
                {"name": "ops:deploy", "description": "Deploy it", "category": "plugin",
                 "frontmatter": {}},
            ],
            plugin_dirs={"ops:deploy": folder / "SKILL.md"},
        )
        got = self.viewed(host, "ops:deploy")
        self.assertEqual(got["origin"], "plugin")
        self.assertEqual(got["content"], "# Plan\n\nWrite it down.\n")

    def test_the_hosts_readiness_and_setup_are_carried_under_its_own_names(self):
        folder = self.skill()
        host = hermes(
            catalog=[scanned("plan")],
            skill_dirs={"plan": folder},
            readiness=(
                {
                    "readiness_status": "setup_needed",
                    "setup_needed": True,
                    "missing_required_environment_variables": ["PLAN_TOKEN"],
                    "required_commands": [],
                },
                {"setup_note": "Setup needed before using this skill: missing env $PLAN_TOKEN.",
                 "setup_help": "Find the token in the plan's settings."},
            ),
        )
        got = self.viewed(host)
        self.assertEqual(got["readiness_status"], "setup_needed")
        self.assertTrue(got["setup_needed"])
        self.assertEqual(got["missing_required_environment_variables"], ["PLAN_TOKEN"])
        self.assertEqual(
            got["setup_note"], "Setup needed before using this skill: missing env $PLAN_TOKEN."
        )
        self.assertEqual(got["setup_help"], "Find the token in the plan's settings.")

    def test_a_host_that_cannot_say_leaves_those_fields_out(self):
        folder = self.skill()
        host = hermes(catalog=[scanned("plan")], skill_dirs={"plan": folder})
        got = self.viewed(host)
        # Left out rather than filled in with something the host never said, and the linked-file
        # listing with them: null is "this host can't list them".
        for field in ("readiness_status", "setup_needed", "setup_note", "setup_help"):
            self.assertNotIn(field, got)
        self.assertIsNone(got["linkedFiles"])

    def test_one_file_is_read_and_nothing_else_of_the_directory(self):
        folder = self.skill(
            **{"references/api.md": "The API.\n", "scripts/run.sh": "echo hi\n"}
        )
        host = hermes(catalog=[scanned("plan")], skill_dirs={"plan": folder})
        with mock.patch.dict(sys.modules, host.modules):
            got = skill_catalog.file("bot-a", "plan", "references/api.md")
        self.assertEqual(got, {"name": "plan", "path": "references/api.md", "content": "The API.\n"})

    def test_a_path_that_leaves_the_skill_is_refused(self):
        folder = self.skill(**{"references/api.md": "The API.\n"})
        (self.root / "outside.md").write_text("Not yours.\n", encoding="utf-8")
        (folder / "references" / "link.md").symlink_to(self.root / "outside.md")
        host = hermes(catalog=[scanned("plan")], skill_dirs={"plan": folder})
        for path in (
            "../outside.md",
            "references/../../outside.md",
            str(self.root / "outside.md"),
            "references/link.md",
        ):
            with self.subTest(path=path):
                with mock.patch.dict(sys.modules, host.modules):
                    with self.assertRaises(skill_catalog.SkillError) as caught:
                        skill_catalog.file("bot-a", "plan", path)
                self.assertEqual(caught.exception.status, 400)
                self.assertEqual(str(caught.exception), skill_catalog.OUTSIDE % path)

    def test_a_file_the_skill_hasnt_got_is_a_404(self):
        folder = self.skill()
        host = hermes(catalog=[scanned("plan")], skill_dirs={"plan": folder})
        with mock.patch.dict(sys.modules, host.modules):
            with self.assertRaises(skill_catalog.SkillError) as caught:
                skill_catalog.file("bot-a", "plan", "references/gone.md")
        self.assertEqual(caught.exception.status, 404)
        self.assertEqual(
            str(caught.exception), "Skill 'plan' has no file 'references/gone.md'."
        )

    def test_a_host_without_the_sheets_machinery_refuses_with_its_own_reason(self):
        folder = self.skill()
        host = hermes(
            catalog=[scanned("plan")],
            skill_dirs={"plan": folder},
            omit=("tools.skill_manager_tool",),
        )
        with mock.patch.dict(sys.modules, host.modules):
            for call in (
                lambda: skill_catalog.view("bot-a", "plan"),
                lambda: skill_catalog.file("bot-a", "plan", "SKILL.md"),
            ):
                with self.assertRaises(skill_catalog.SkillError) as caught:
                    call()
                self.assertEqual(caught.exception.status, 501)
                self.assertEqual(str(caught.exception), skill_catalog.UNAVAILABLE_VIEW)


class SkillRemoveTests(unittest.TestCase):
    """Removal: one word, three host operations, and each origin's own path or refusal."""

    def removed(self, host, name="plan", profile="bot-a"):
        with mock.patch.dict(sys.modules, host.modules):
            return skill_catalog.remove(profile, name)

    def test_a_hub_skill_goes_through_the_hubs_own_uninstall(self):
        host = hermes(catalog=[scanned("plan"), scanned("log")], hub=("plan",))
        left = self.removed(host)
        self.assertEqual(host.uninstalls, [{"name": "plan", "in_scope": True}])
        self.assertEqual(host.deletes, [])
        # The answer is the list read again, so the app's whole list is the host's own: the skill
        # that went is gone from it and the one that stayed is still there, in the list's row shape.
        self.assertEqual([row["name"] for row in left], ["log"])
        self.assertEqual(set(left[0]), {"name", "description", "category", "origin", "enabled",
                                        "loadError", "switchable"})

    def test_the_hubs_refusal_is_its_own_sentence(self):
        message = "'plan' is not a hub-installed skill (may be a builtin)"
        host = hermes(catalog=[scanned("plan")], hub=("plan",), uninstall=(False, message))
        with mock.patch.dict(sys.modules, host.modules):
            with self.assertRaises(skill_catalog.SkillError) as caught:
                skill_catalog.remove("bot-a", "plan")
        self.assertEqual(caught.exception.status, 400)
        self.assertEqual(str(caught.exception), message)
        # A refusal is no removal: the other helper was never reached, and no cache was cleared.
        self.assertEqual(host.deletes, [])
        self.assertEqual(host.caches, [])

    def test_a_skill_written_on_the_profile_goes_through_the_managers_delete(self):
        folder = Path("/skills/plan")
        host = hermes(catalog=[scanned("plan"), scanned("log")], skill_dirs={"plan": folder})
        left = self.removed(host)
        self.assertEqual(host.deletes, [
            {"name": "plan", "absorbed_into": None, "in_scope": True},
        ])
        self.assertEqual(host.uninstalls, [])
        self.assertEqual([row["name"] for row in left], ["log"])

    def test_the_delete_guards_refusal_is_the_hosts_own_sentence(self):
        message = (
            "Skill 'plan' is pinned and cannot be deleted by skill_manage. Ask the user to run "
            "`hermes curator unpin plan` if they want to delete it."
        )
        host = hermes(catalog=[scanned("plan")], delete={"success": False, "error": message})
        with mock.patch.dict(sys.modules, host.modules):
            with self.assertRaises(skill_catalog.SkillError) as caught:
                skill_catalog.remove("bot-a", "plan")
        self.assertEqual(caught.exception.status, 400)
        self.assertEqual(str(caught.exception), message)
        self.assertEqual(host.caches, [])

    def test_a_builtin_is_refused_without_either_helper(self):
        host = hermes(catalog=[scanned("hermes-agent")], bundled=("hermes-agent",))
        with mock.patch.dict(sys.modules, host.modules):
            with self.assertRaises(skill_catalog.SkillError) as caught:
                skill_catalog.remove("bot-a", "hermes-agent")
        self.assertEqual(caught.exception.status, 400)
        self.assertEqual(
            str(caught.exception), "Skill 'hermes-agent' is built into Hermes, so it can't be removed."
        )
        self.assertEqual(host.uninstalls, [])
        self.assertEqual(host.deletes, [])

    def test_a_plugin_skill_is_refused_without_either_helper(self):
        host = hermes(
            catalog=[scanned("plan")],
            plugin_rows=[{"name": "ops:deploy", "description": "", "category": "plugin"}],
        )
        with mock.patch.dict(sys.modules, host.modules):
            with self.assertRaises(skill_catalog.SkillError) as caught:
                skill_catalog.remove("bot-a", "ops:deploy")
        self.assertEqual(caught.exception.status, 400)
        self.assertEqual(
            str(caught.exception),
            "Skill 'ops:deploy' comes from a plugin, so it can't be removed; switch it off instead.",
        )
        self.assertEqual(host.uninstalls, [])
        self.assertEqual(host.deletes, [])

    def test_a_name_the_bot_hasnt_got_is_a_404(self):
        host = hermes(catalog=[scanned("plan")], hub=("plan",))
        with mock.patch.dict(sys.modules, host.modules):
            with self.assertRaises(skill_catalog.SkillError) as caught:
                skill_catalog.remove("bot-a", "ghost")
        self.assertEqual(caught.exception.status, 404)
        self.assertEqual(str(caught.exception), "Skill 'ghost' isn't on this bot.")
        self.assertEqual(host.uninstalls, [])
        self.assertEqual(host.deletes, [])

    def test_a_removal_clears_both_of_hermes_caches(self):
        host = hermes(catalog=[scanned("plan"), scanned("log")], hub=("plan",))
        self.removed(host)
        self.assertEqual(host.caches, ["skills", ("prompt", True)])

    def test_a_cache_that_cant_be_cleared_still_answers_the_removal(self):
        host = hermes(
            catalog=[scanned("plan"), scanned("log")], hub=("plan",), cache_fails=True
        )
        left = self.removed(host)
        self.assertEqual(host.caches, ["skills", ("prompt", True)])
        self.assertEqual([row["name"] for row in left], ["log"])

    def test_a_host_without_either_removal_refuses_with_its_own_reason(self):
        for missing in ("tools.skills_hub_install", "tools.skill_manager_tool"):
            with self.subTest(missing=missing):
                host = hermes(catalog=[scanned("plan")], hub=("plan",), omit=(missing,))
                with mock.patch.dict(sys.modules, host.modules):
                    with self.assertRaises(skill_catalog.SkillError) as caught:
                        skill_catalog.remove("bot-a", "plan")
                self.assertEqual(caught.exception.status, 501)
                self.assertEqual(str(caught.exception), skill_catalog.UNAVAILABLE_REMOVE)
                self.assertEqual(host.uninstalls, [])
                self.assertEqual(host.deletes, [])


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

    def test_the_sheet_gate_says_why_a_host_without_the_lookup_cannot_open_one(self):
        host = hermes(catalog=[scanned("plan")], omit=("tools.skill_manager_tool",))
        with mock.patch.dict(sys.modules, host.modules):
            self.assertEqual(skill_catalog.viewable(), skill_catalog.UNAVAILABLE_VIEW)

    def test_the_sheet_gate_is_quiet_where_the_lookup_imports(self):
        host = hermes(catalog=[scanned("plan")])
        with mock.patch.dict(sys.modules, host.modules):
            self.assertIsNone(skill_catalog.viewable())

    def test_the_remove_gate_says_why_a_host_without_the_removals_cannot_remove(self):
        for missing in ("tools.skills_hub_install", "tools.skill_manager_tool"):
            with self.subTest(missing=missing):
                host = hermes(catalog=[scanned("plan")], omit=(missing,))
                with mock.patch.dict(sys.modules, host.modules):
                    self.assertEqual(skill_catalog.removable(), skill_catalog.UNAVAILABLE_REMOVE)

    def test_the_remove_gate_is_quiet_where_both_removals_import(self):
        host = hermes(catalog=[scanned("plan")])
        with mock.patch.dict(sys.modules, host.modules):
            self.assertIsNone(skill_catalog.removable())

    def test_the_features_are_the_list_its_switch_its_removal_and_its_sheet(self):
        self.assertEqual(
            [name for name, _gate in skill_catalog.FEATURES],
            ["skills", "skills_write", "skills_remove", "skills_view"],
        )


if __name__ == "__main__":
    unittest.main()
