"""The workflow library: the presets every bot ships with, the rule over a whole workflow, forking a
preset, refusing to delete one a project names, and the snapshot a task keeps of it.

A throwaway Hermes home, so the library is the store's: these read it back through the plugin's own
calls, with no HTTP anywhere.

Run: python3 -m unittest plugin.tests.test_workflows -v
"""

from __future__ import annotations

import json
import sqlite3
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from typing import Any, Dict, List
from unittest.mock import patch

from plugin import pipeline, workflows
from plugin.store import connect, db_path
from plugin.tests._helpers import stub_projects_db


class LibraryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)

    def test_a_fresh_store_answers_the_three_presets(self) -> None:
        found = workflows.library(self.home)
        self.assertEqual(
            [one["name"] for one in found],
            ["Build · Test · Review · Summary", "Build ⇄ Test · Review · Summary", "One run"],
        )
        self.assertTrue(all(one["preset"] for one in found), "and all of them are presets")

    def test_a_project_that_picked_nothing_reads_one_run(self) -> None:
        found = workflows.pick(self.home, "p1")
        self.assertEqual(found["id"], workflows.DEFAULT_ID)
        self.assertEqual(found["name"], "One run", "one prompt run is the shape it works in")
        self.assertEqual([stage["name"] for stage in found["stages"]], ["Build"])
        self.assertTrue(found["stages"][0]["ships"], "and that run ships the draft itself")

    def test_the_preset_shapes_are_the_ones_the_issue_names(self) -> None:
        found = {one["id"]: one for one in workflows.library(self.home)}
        self.assertEqual(
            [stage["name"] for stage in found["preset:one-run"]["stages"]], ["Build"]
        )
        self.assertEqual(
            found["preset:loop"]["stages"][1]["loop"], {"from": "Build", "cap": 3}
        )
        self.assertTrue(found["preset:loop"]["stages"][1]["check"] == workflows.GATE)
        self.assertTrue(found["preset:staged"]["stages"][2]["ships"])

    def test_a_preset_is_refreshed_in_place_when_the_plugin_version_moves(self) -> None:
        workflows.library(self.home)
        conn = connect(db_path(self.home))
        try:
            conn.execute(
                "UPDATE workflows SET body = ?, version = '0.0.1' WHERE id = ?",
                (json.dumps({"name": "Old", "stages": [{"name": "Old", "ships": True}]}), "preset:staged"),
            )
        finally:
            conn.close()
        with patch.object(workflows, "_version", return_value="9.9.9"):
            found = workflows.library(self.home)
        refreshed = next(one for one in found if one["id"] == "preset:staged")
        self.assertEqual(refreshed["name"], "Build · Test · Review · Summary")
        self.assertEqual(len(refreshed["stages"]), 4, "the body is the preset's again")

    def test_a_preset_a_user_deleted_is_not_seeded_again(self) -> None:
        workflows.delete(self.home, "preset:loop")
        self.assertNotIn(
            "preset:loop",
            [one["id"] for one in workflows.library(self.home)],
            "what was taken away stays away",
        )

    def test_a_created_workflow_is_the_librarys_and_is_not_a_preset(self) -> None:
        entry = workflows.create(
            self.home, {"name": "Mine", "stages": workflows.from_skills("plan", ["code-review"])}
        )
        self.assertFalse(entry["preset"])
        self.assertTrue(entry["id"].startswith("wf-"))
        self.assertIn(entry["id"], [one["id"] for one in workflows.library(self.home)])

    def test_a_read_of_an_unknown_id_is_nothing(self) -> None:
        self.assertIsNone(workflows.get(self.home, "wf-nowhere"))


class ForkTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)

    def test_a_write_to_a_preset_forks_it_under_a_new_id(self) -> None:
        found = workflows.update(
            self.home,
            workflows.DEFAULT_ID,
            {
                "name": "Mine",
                "stages": [
                    {"name": "Migrate", "ships": True},
                    {"name": "Verify", "steps": ["code-review"]},
                ],
            },
        )
        self.assertNotEqual(found["id"], workflows.DEFAULT_ID)
        self.assertEqual(found["name"], "Mine")
        self.assertFalse(found["preset"])

    def test_a_preset_body_is_never_written(self) -> None:
        before = workflows.get(self.home, workflows.DEFAULT_ID)
        workflows.update(
            self.home, workflows.DEFAULT_ID, {"name": "Mine", "stages": [{"name": "Only", "ships": True}]}
        )
        self.assertEqual(workflows.get(self.home, workflows.DEFAULT_ID), before)

    def test_a_fork_that_names_nothing_reads_as_a_copy_of_the_preset(self) -> None:
        found = workflows.update(
            self.home, "preset:staged", {"stages": [{"name": "Only", "ships": True}]}
        )
        self.assertEqual(found["name"], "Build · Test · Review · Summary (copy)")

    def test_a_workflow_of_its_own_is_written_in_place(self) -> None:
        entry = workflows.create(self.home, {"name": "Mine", "stages": [{"name": "Build", "ships": True}]})
        found = workflows.update(
            self.home, entry["id"], {"name": "Renamed", "stages": [{"name": "Migrate", "ships": True}]}
        )
        self.assertEqual(found["id"], entry["id"])
        self.assertEqual(found["name"], "Renamed")
        self.assertEqual(found["stages"][0]["name"], "Migrate")

    def test_a_write_to_an_unknown_id_is_nothing(self) -> None:
        self.assertIsNone(workflows.update(self.home, "wf-nowhere", {"name": "Mine", "stages": []}))

    def test_a_refused_body_is_never_stored(self) -> None:
        with self.assertRaises(ValueError):
            workflows.create(self.home, {"name": "Mine", "stages": []})
        self.assertEqual(len(workflows.library(self.home)), 3, "three presets and nothing else")


class DeleteTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.home.joinpath("projects.db").write_text("")

    def choose(self, project_id: str, name: str = "Mine") -> Dict[str, Any]:
        entry = workflows.create(self.home, {"name": name, "stages": [{"name": "Build", "ships": True}]})
        self.pick(project_id, entry["id"])
        return entry

    def pick(self, project_id: str, workflow_id: str) -> None:
        conn = connect(db_path(self.home))
        try:
            conn.execute(
                """INSERT INTO project_afk (project_id, enabled, at, workflow_id) VALUES (?, 0, ?, ?)""",
                (project_id, int(time.time()), workflow_id),
            )
        finally:
            conn.close()

    def test_deleting_a_workflow_a_project_names_is_refused_and_names_it(self) -> None:
        entry = self.choose("p1")
        patch_db = stub_projects_db(projects=[SimpleNamespace(id="p1", name="Memento")])
        with patch_db:
            with self.assertRaises(workflows.Refused) as refused:
                workflows.delete(self.home, entry["id"])
        self.assertIn("Memento", str(refused.exception), "the user is told which project it is")
        self.assertIsNotNone(workflows.get(self.home, entry["id"]), "and nothing was deleted")

    def test_a_workflow_no_project_names_is_deleted(self) -> None:
        entry = workflows.create(self.home, {"name": "Mine", "stages": [{"name": "Build", "ships": True}]})
        self.assertTrue(workflows.delete(self.home, entry["id"]))
        self.assertIsNone(workflows.get(self.home, entry["id"]))

    def test_deleting_an_unknown_workflow_is_nothing(self) -> None:
        self.assertFalse(workflows.delete(self.home, "wf-nowhere"))

    def test_a_project_whose_workflow_is_gone_runs_the_default_preset(self) -> None:
        entry = self.choose("p1")
        conn = connect(db_path(self.home))
        try:
            conn.execute("UPDATE workflows SET deleted = 1 WHERE id = ?", (entry["id"],))
        finally:
            conn.close()
        self.assertEqual(workflows.pick(self.home, "p1")["id"], workflows.DEFAULT_ID)


class RulesTests(unittest.TestCase):
    """One rule over a whole workflow, the same one the app's editor calls."""

    def workflow(self, *stages: Dict[str, Any], name: str = "Mine") -> Dict[str, Any]:
        return {"name": name, "stages": list(stages)}

    def test_a_workflow_is_a_name_and_its_stages(self) -> None:
        with self.assertRaises(ValueError):
            workflows.normalise([])
        with self.assertRaises(ValueError):
            workflows.normalise({"stages": [{"name": "Build", "ships": True}]})
        with self.assertRaises(ValueError):
            workflows.normalise({"name": "Mine"})
        with self.assertRaises(ValueError):
            workflows.normalise({"name": "Mine", "stages": []})

    def test_stage_names_are_trimmed_and_must_be_unique(self) -> None:
        found = workflows.normalise(
            self.workflow({"name": " Build ", "ships": True}, {"name": "Review"})
        )
        self.assertEqual([stage["name"] for stage in found["stages"]], ["Build", "Review"])
        with self.assertRaises(ValueError):
            workflows.normalise(
                self.workflow({"name": "Build", "ships": True}, {"name": " Build "})
            )

    def test_a_stage_needs_a_name(self) -> None:
        with self.assertRaises(ValueError):
            workflows.normalise(self.workflow({"name": "  ", "ships": True}))

    def test_twelve_stages_at_most(self) -> None:
        thirteen = [{"name": f"S{index}"} for index in range(13)]
        thirteen[-1]["ships"] = True
        with self.assertRaises(ValueError):
            workflows.normalise(self.workflow(*thirteen))
        twelve = [{"name": f"S{index}"} for index in range(12)]
        twelve[-1]["ships"] = True
        self.assertEqual(len(workflows.normalise(self.workflow(*twelve))["stages"]), 12)

    def test_exactly_one_stage_ships(self) -> None:
        with self.assertRaises(ValueError):
            workflows.normalise(self.workflow({"name": "Build"}))
        with self.assertRaises(ValueError):
            workflows.normalise(
                self.workflow({"name": "Build", "ships": True}, {"name": "Review", "ships": True})
            )

    def test_a_shipping_stage_cannot_be_a_gate_stage(self) -> None:
        # A gate stage posts no run, so it could never open a pull request.
        with self.assertRaises(ValueError):
            workflows.normalise(
                self.workflow({"name": "Test", "check": workflows.GATE, "ships": True})
            )
        # One run ships from a stage that names no check at all.
        workflows.normalise(self.workflow({"name": "Build", "ships": True}))

    def test_a_stage_that_names_both_steps_and_a_check_is_refused(self) -> None:
        # A stage either runs its skills or is the checkpoint the host answers; naming both leaves
        # the engine unable to say which of the two a run of it is.
        with self.assertRaises(ValueError) as caught:
            workflows.normalise(
                self.workflow(
                    {"name": "Build", "steps": ["plan"], "check": workflows.GATE},
                    {"name": "Ship", "ships": True},
                )
            )
        self.assertIn("runs its skills or the host answers it", str(caught.exception))

    def test_a_loops_cap_is_between_one_and_ten(self) -> None:
        for cap in (0, 11, "3", None, True):
            with self.subTest(cap=cap):
                with self.assertRaises(ValueError):
                    workflows.normalise(
                        self.workflow(
                            {"name": "Build"},
                            {"name": "Test", "loop": {"from": "Build", "cap": cap}, "ships": True},
                        )
                    )
        found = workflows.normalise(
            self.workflow(
                {"name": "Build"},
                {"name": "Test", "loop": {"from": "Build", "cap": 10}, "ships": True},
            )
        )
        self.assertEqual(found["stages"][1]["loop"], {"from": "Build", "cap": 10})

    def test_a_loop_starts_at_a_stage_before_the_one_it_ends_on(self) -> None:
        for start in ("Test", "Nowhere", ""):
            with self.subTest(start=start):
                with self.assertRaises(ValueError):
                    workflows.normalise(
                        self.workflow(
                            {"name": "Build"},
                            {"name": "Test", "loop": {"from": start, "cap": 2}, "ships": True},
                        )
                    )

    def test_steps_are_trimmed_and_named_once_in_order(self) -> None:
        found = workflows.normalise(
            self.workflow({"name": "Build", "steps": [" code-review ", "code-review", "", "tdd"], "ships": True})
        )
        self.assertEqual(found["stages"][0]["steps"], ["code-review", "tdd"])

    def test_the_only_check_is_the_gate(self) -> None:
        with self.assertRaises(ValueError):
            workflows.normalise(self.workflow({"name": "Build", "check": "tests", "ships": True}))
        found = workflows.normalise(self.workflow({"name": "Build", "ships": True}))
        self.assertIsNone(found["stages"][0]["check"], "no check is a stage that just runs")


class MigrationTests(unittest.TestCase):
    """A project whose row predates the picker, read as the workflow its skills described."""

    def setUp(self) -> None:
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.home.joinpath("projects.db").write_text("")

    def old_row(self, project_id: str, build: Any, critique: List[str]) -> None:
        conn = connect(db_path(self.home))
        try:
            conn.execute(
                """INSERT INTO project_afk (project_id, enabled, at, build_skill, critique_skills)
                   VALUES (?, 0, ?, ?, ?)""",
                (project_id, int(time.time()), build, json.dumps(critique)),
            )
        finally:
            conn.close()

    def test_it_is_the_shape_those_columns_described(self) -> None:
        self.old_row("p1", "plan", ["code-review", "log-triage"])
        found = workflows.migrate(self.home, "p1", "plan", ["code-review", "log-triage"])
        self.assertEqual(
            [stage["name"] for stage in found["stages"]],
            ["Build", "Test", "Review"],
            "the three stages those columns described",
        )
        self.assertEqual(found["stages"][0]["steps"], ["plan"])
        self.assertEqual(found["stages"][1]["check"], workflows.GATE)
        self.assertEqual(found["stages"][2]["steps"], ["code-review", "log-triage"])
        self.assertTrue(found["stages"][2]["ships"], "shipping on Review")

    def test_it_is_written_once(self) -> None:
        self.old_row("p1", "plan", ["code-review"])
        first = workflows.migrate(self.home, "p1", "plan", ["code-review"])
        second = workflows.migrate(self.home, "p1", "plan", ["code-review"])
        self.assertEqual(first, second)
        self.assertEqual(len(workflows.library(self.home)), 4, "three presets and the one migration")

    def test_the_project_names_it_afterwards(self) -> None:
        self.old_row("p1", "plan", ["code-review"])
        first = workflows.migrate(self.home, "p1", "plan", ["code-review"])
        self.assertEqual(workflows.pick(self.home, "p1")["id"], first["id"])

    def test_a_project_of_its_own_keeps_its_shape(self) -> None:
        self.old_row("p1", "plan", ["code-review"])
        self.old_row("p2", "writing-for-agents", [])
        mine = workflows.migrate(self.home, "p1", "plan", ["code-review"])
        theirs = workflows.migrate(self.home, "p2", "writing-for-agents", [])
        self.assertNotEqual(mine["id"], theirs["id"], "one workflow per project, not one shared")
        self.assertEqual(theirs["stages"][0]["steps"], ["writing-for-agents"])

    def test_the_migrated_stages_need_no_library_write_to_be_read(self) -> None:
        self.old_row("p1", None, ["code-review"])
        found = workflows.migrate(self.home, "p1", None, ["code-review"])
        self.assertEqual(found["stages"][0]["steps"], [], "no build skill, and Build names nothing")
        self.assertEqual(found["stages"][2]["steps"], ["code-review"])


class SnapshotTests(unittest.TestCase):
    """A task keeps the workflow it started under, whatever the library does afterwards."""

    def setUp(self) -> None:
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.home.joinpath("projects.db").write_text("")

    def pick(self, project_id: str, workflow_id: str) -> None:
        conn = connect(db_path(self.home))
        try:
            conn.execute(
                """INSERT INTO project_afk (project_id, enabled, at, workflow_id) VALUES (?, 0, ?, ?)""",
                (project_id, int(time.time()), workflow_id),
            )
        finally:
            conn.close()

    def test_the_snapshot_is_the_workflow_as_it_stood(self) -> None:
        entry = workflows.create(
            self.home, {"name": "Mine", "stages": workflows.from_skills("plan", ["code-review"])}
        )
        self.pick("p1", entry["id"])
        snapshot = pipeline.start(workflows.pick(self.home, "p1"))
        self.assertEqual(snapshot["workflow"]["name"], "Mine")
        self.assertEqual(snapshot["stages"][0]["steps"], ["plan"])

    def test_editing_the_entry_leaves_the_snapshot_alone(self) -> None:
        entry = workflows.create(
            self.home, {"name": "Mine", "stages": workflows.from_skills("plan", ["code-review"])}
        )
        self.pick("p1", entry["id"])
        snapshot = pipeline.start(workflows.pick(self.home, "p1"))
        workflows.update(
            self.home,
            entry["id"],
            {"name": "Mine", "stages": [{"name": "Migrate", "steps": ["tdd"], "ships": True}]},
        )
        self.assertEqual(snapshot["stages"][0]["name"], "Build")
        self.assertEqual(snapshot["stages"][0]["steps"], ["plan"])
        self.assertEqual(len(snapshot["stages"]), 3)

    def test_deleting_the_entry_leaves_the_snapshot_alone(self) -> None:
        entry = workflows.create(
            self.home, {"name": "Mine", "stages": workflows.from_skills("plan", ["code-review"])}
        )
        self.pick("p1", entry["id"])
        snapshot = pipeline.start(workflows.pick(self.home, "p1"))
        other = workflows.create(self.home, {"name": "Other", "stages": [{"name": "Only", "ships": True}]})
        self.pick("p2", other["id"])
        conn = connect(db_path(self.home))
        try:
            conn.execute("DELETE FROM project_afk WHERE project_id = 'p1'")
        finally:
            conn.close()
        self.assertTrue(workflows.delete(self.home, entry["id"]))
        self.assertEqual(snapshot["workflow"]["name"], "Mine")
        self.assertEqual(snapshot["stages"][2]["steps"], ["code-review"])

    def test_a_task_started_under_the_one_run_preset_keeps_its_shape(self) -> None:
        snapshot = pipeline.start(workflows.pick(self.home, "p1"))
        self.assertEqual(len(snapshot["stages"]), 1, "one run is one stage")
        self.assertEqual(snapshot["workflow"]["id"], workflows.DEFAULT_ID)
        self.assertTrue(snapshot["stages"][0]["ships"], "the only stage ships")


if __name__ == "__main__":
    unittest.main()
