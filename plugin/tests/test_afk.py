"""AFK's switch: whether a project is left to work its own tasks, and why it can't be.

The switch lives in the plugin's store, so these drive a throwaway Hermes home and read it back
through the plugin's own calls; GitHub is patched, and ``hermes_cli.projects_db`` is stubbed the way
the usage tests stub it, since the plugin only ever sees it on a real host.

Run: python3 -m unittest plugin.tests.test_afk -v
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
import sys
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import ModuleType, SimpleNamespace
from typing import Any, Dict, List, Optional
from unittest.mock import ANY, patch

from plugin import (
    afk,
    chats,
    github,
    outbox,
    pipeline,
    projects,
    prompt_builder,
    sessions,
    workflows,
)
from plugin.afk import (
    ARCHIVED,
    NO_GITHUB,
    NO_REPOSITORY,
    Refused,
    read,
    release,
    set_on,
    set_pick_budget,
    set_pick_count,
    set_prompt,
    set_workflow,
    sweep,
    sweep_all,
    write_from,
)
from plugin.store import connect, db_path, get_setting, put_setting
from plugin.tasks import CLAIM_LABEL, READY_LABEL
from plugin.tests._helpers import issue_row, placed, preset, staged as staged_record, stub_projects_db


def folder(path: str) -> SimpleNamespace:
    """A project folder as the plugin reads one: only where it is."""
    return SimpleNamespace(path=path)


def lose_pick(hermes_home: Path, project_id: str = "p1") -> None:
    """Points a project at a workflow the library no longer holds, as a hand edit could.

    The route refuses an id the library doesn't hold, so this is written straight to the row to
    stand in for a store somebody edited behind the plugin's back.
    """
    conn = connect(db_path(hermes_home))
    try:
        conn.execute(
            "UPDATE project_afk SET workflow_id = 'wf-gone' WHERE project_id = ?", (project_id,)
        )
    finally:
        conn.close()


class ProjectsStub(ModuleType):
    """A ``hermes_cli.projects_db`` that records what a project's edit asked of it."""

    def __init__(self, *, deleted: bool = True) -> None:
        super().__init__("hermes_cli.projects_db")
        self.archived: List[str] = []
        self.deleted: List[bool] = []
        self._deleted = deleted

    def connect_closing(self, db_path: Path) -> Any:
        return _Context()

    def get_project(self, conn: Any, project_id: str) -> Any:
        return SimpleNamespace(id=project_id)

    def update_project(self, conn: Any, project_id: str, **fields: Any) -> None:
        pass

    def archive_project(self, conn: Any, project_id: str) -> None:
        self.archived.append(project_id)

    def restore_project(self, conn: Any, project_id: str) -> None:
        pass

    def delete_project(self, conn: Any, project_id: str) -> bool:
        self.deleted.append(self._deleted)
        return self._deleted


class _Context:
    def __enter__(self) -> "_Context":
        return self

    def __exit__(self, *args: object) -> bool:
        return False


class SwitchTests(unittest.TestCase):
    """Whether a project can be left to work, and what it says when it can't."""

    def setUp(self) -> None:
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.checkout = self.home / "checkout"
        (self.checkout / ".git").mkdir(parents=True)
        self._patches = [
            patch.object(github, "token", return_value=("token", "env")),
            patch.object(github, "origin_repo", return_value="mock-user/memento"),
        ]
        for one in self._patches:
            one.start()
            self.addCleanup(one.stop)

    def folders(self, *paths: str) -> List[Any]:
        return [folder(path) for path in (paths or (str(self.checkout),))]

    def stub_projects(self, **kwargs: Any) -> ProjectsStub:
        stub = ProjectsStub(**kwargs)
        module = ModuleType("hermes_cli")
        module.projects_db = stub
        patcher = patch.dict(
            sys.modules, {"hermes_cli": module, "hermes_cli.projects_db": stub}
        )
        patcher.start()
        self.addCleanup(patcher.stop)
        return stub

    def test_a_project_that_can_be_left_to_work_starts_off(self) -> None:
        self.assertEqual(read(self.home, "p1", self.folders()), afk_row())
        self.assertFalse(read(self.home, "p1", self.folders())["on"])

    def test_turning_it_on_is_read_back_from_the_host(self) -> None:
        self.assertEqual(set_on(self.home, "p1", self.folders(), True)["on"], True)
        self.assertTrue(read(self.home, "p1", self.folders())["on"])
        # A fresh read — the app's own, from another device — is the host's answer, not the device's.
        self.assertEqual(read(self.home, "p1", self.folders()), afk_row(on=True))

    def test_turning_it_off_again(self) -> None:
        set_on(self.home, "p1", self.folders(), True)
        self.assertEqual(set_on(self.home, "p1", self.folders(), False)["on"], False)
        self.assertFalse(read(self.home, "p1", self.folders())["on"])

    def test_one_projects_switch_does_not_touch_anothers(self) -> None:
        set_on(self.home, "p1", self.folders(), True)
        self.assertFalse(read(self.home, "p2", self.folders())["on"])
        set_on(self.home, "p2", self.folders(), True)
        set_on(self.home, "p2", self.folders(), False)
        self.assertTrue(read(self.home, "p1", self.folders())["on"])

    def test_a_project_with_no_repository_says_why(self) -> None:
        plain = self.home / "plain"
        plain.mkdir()
        self.assertEqual(
            read(self.home, "p1", self.folders(str(plain))),
            afk_row(reason=NO_REPOSITORY),
        )

    def test_a_project_with_no_repository_cannot_be_turned_on(self) -> None:
        plain = self.home / "plain"
        plain.mkdir()
        with self.assertRaises(Refused) as raised:
            set_on(self.home, "p1", self.folders(str(plain)), True)
        self.assertEqual(str(raised.exception), NO_REPOSITORY)
        self.assertFalse(read(self.home, "p1", self.folders())["on"])

    def test_a_host_without_github_says_why(self) -> None:
        with patch.object(github, "token", return_value=(None, None)):
            self.assertEqual(
                read(self.home, "p1", self.folders()), afk_row(reason=NO_GITHUB)
            )
            with self.assertRaises(Refused) as raised:
                set_on(self.home, "p1", self.folders(), True)
        self.assertEqual(str(raised.exception), NO_GITHUB)
        self.assertFalse(read(self.home, "p1", self.folders())["on"])

    def test_a_project_with_no_repository_is_not_asked_github_about(self) -> None:
        plain = self.home / "plain"
        plain.mkdir()
        with patch.object(github, "token") as token:
            read(self.home, "p1", self.folders(str(plain)))
        token.assert_not_called()

    def test_turning_it_off_is_allowed_even_where_it_cannot_be_on(self) -> None:
        set_on(self.home, "p1", self.folders(), True)
        # The account it was left to work with is gone, so turning it back on would be refused — but
        # putting the project back to work is the user's to do, and always allowed.
        with patch.object(github, "token", return_value=(None, None)):
            with self.assertRaises(Refused):
                set_on(self.home, "p1", self.folders(), True)
            self.assertEqual(set_on(self.home, "p1", self.folders(), False)["on"], False)
        self.assertFalse(read(self.home, "p1", self.folders())["on"])

    def test_an_archived_project_reads_off_whatever_its_row_says(self) -> None:
        # Archived somewhere this plugin didn't do it — Hermes's own dashboard or CLI — so the row is
        # still there; the sheet must not show a switch that would never be acted on, and reading it
        # off is what keeps a restore from resuming work nobody asked for.
        set_on(self.home, "p1", self.folders(), True)
        self.assertEqual(
            read(self.home, "p1", self.folders(), archived=True),
            afk_row(reason=ARCHIVED),
        )
        self.assertFalse(read(self.home, "p1", self.folders())["on"], "the row is written off, not only masked")
        self.assertEqual(
            read(self.home, "p1", self.folders()),
            afk_row(),
            "restoring it starts off",
        )

    def test_a_project_left_on_keeps_its_switch_when_its_reason_comes_back(self) -> None:
        set_on(self.home, "p1", self.folders(), True)
        with patch.object(github, "token", return_value=(None, None)):
            # Still on — the switch is the user's to turn off — but the host now says why it can't work.
            self.assertEqual(
                read(self.home, "p1", self.folders()), afk_row(on=True, reason=NO_GITHUB)
            )

    def test_archiving_a_project_turns_its_switch_off(self) -> None:
        stub = self.stub_projects()
        set_on(self.home, "p1", self.folders(), True)
        projects.update(self.home, "p1", None, None, archived=True)
        self.assertEqual(stub.archived, ["p1"])
        self.assertFalse(read(self.home, "p1", self.folders())["on"])

    def test_editing_a_project_leaves_its_switch_alone(self) -> None:
        self.stub_projects()
        set_on(self.home, "p1", self.folders(), True)
        projects.update(self.home, "p1", "A new name", "And a description")
        self.assertTrue(read(self.home, "p1", self.folders())["on"], "renaming a project doesn't put it away")
        projects.update(self.home, "p1", None, None, archived=False)
        self.assertTrue(read(self.home, "p1", self.folders())["on"], "restoring one that wasn't archived leaves it be")

    def test_an_archived_project_says_why(self) -> None:
        with patch.object(github, "token") as token:
            self.assertEqual(
                read(self.home, "p1", self.folders(), archived=True),
                afk_row(reason=ARCHIVED),
            )
        # Put away before its repositories or the account are looked at: neither can matter.
        token.assert_not_called()

    def test_an_archived_project_cannot_be_turned_on(self) -> None:
        with self.assertRaises(Refused) as raised:
            set_on(self.home, "p1", self.folders(), True, archived=True)
        self.assertEqual(str(raised.exception), ARCHIVED)
        self.assertFalse(read(self.home, "p1", self.folders())["on"])
        # Turning it off is always the user's to do, and this is the state it should be in anyway.
        self.assertEqual(set_on(self.home, "p1", self.folders(), False, archived=True)["on"], False)

    def test_deleting_a_project_forgets_its_switch(self) -> None:
        self.stub_projects()
        (self.home / "projects.db").write_text("")
        set_on(self.home, "p1", self.folders(), True)
        afk._hold(
            self.home,
            "p1",
            {
                "repo": "mock-user/memento",
                "number": 265,
                "title": "Task 265",
                "url": "https://github.com/mock-user/memento/issues/265",
                "created_at": "2026-10-01T00:00:00Z",
            },
        )
        projects.remove(self.home, "p1")
        self.assertFalse(read(self.home, "p1", self.folders())["on"])
        self.assertEqual(
            afk._holds(self.home, "p1"), [], "its holds go with it: nothing is left holding a claim"
        )

    def test_a_project_that_was_not_deleted_keeps_its_switch(self) -> None:
        self.stub_projects(deleted=False)
        (self.home / "projects.db").write_text("")
        set_on(self.home, "p1", self.folders(), True)
        projects.remove(self.home, "p1")
        self.assertTrue(read(self.home, "p1", self.folders())["on"])

    def test_a_failed_forget_does_not_fail_the_delete(self) -> None:
        self.stub_projects()
        (self.home / "projects.db").write_text("")
        set_on(self.home, "p1", self.folders(), True)
        with patch("plugin.afk.forget", side_effect=RuntimeError("database is locked")):
            # The record is gone either way: a switch left behind is a row nothing reads, and the
            # caller must not be told a delete that happened was a failure.
            self.assertTrue(projects.remove(self.home, "p1"))


def default_workflow() -> Dict[str, Any]:
    """The default preset as the AFK read answers it: what a project that picked nothing runs."""
    return {**workflows.one_run(), "at": ANY}


def hold_update(
    home: Path, task: Optional[Dict[str, Any]] = None, project_id: str = "p1", **fields: Any
) -> None:
    """Writes a hold's own columns straight to the store, as a restart or a hand edit would.

    The plugin has no writer for these: a hold's clock moves on its own, and a row from before a
    column existed is not something a route makes. ``task`` names which of the project's holds; the
    oldest is the one when it isn't named.
    """
    where = "project_id = ?"
    values: List[Any] = [*fields.values(), project_id]
    if task is not None:
        where += " AND repo = ? AND number = ?"
        values.extend([task.get("repo"), task.get("number")])
    assignments = ", ".join(f"{name} = ?" for name in fields)
    conn = connect(db_path(home))
    try:
        conn.execute(f"UPDATE holds SET {assignments} WHERE {where}", tuple(values))
    finally:
        conn.close()


def held_task(home: Path, project_id: str = "p1") -> afk.Hold:
    """The project's oldest hold: the task its sheet has always drawn one Working row from."""
    return afk._holds(home, project_id)[0]


def set_skill_columns(
    home: Path, project_id: str, build: Optional[str], critique: List[str]
) -> None:
    """A project's row as a build before the workflow picker wrote it: the two skill columns only."""
    conn = connect(db_path(home))
    try:
        conn.execute(
            """INSERT INTO project_afk (project_id, enabled, at, build_skill, critique_skills)
               VALUES (?, 0, ?, ?, ?)""",
            (project_id, int(time.time()), build, json.dumps(critique)),
        )
    finally:
        conn.close()


def afk_row(
    on: bool = False,
    reason: Optional[str] = None,
    task: Any = None,
    refusal: Optional[str] = None,
    workflow: Any = None,
    prompt: Any = None,
    stage: Optional[str] = None,
    stage_name: Optional[str] = None,
    holds: Any = None,
    pick_count: int = 1,
    prompt_id: Optional[str] = None,
    pick_budget: int = 5,
    holds_held: int = 0,
) -> Dict[str, Any]:
    """The answer `read` gives for a project holding nothing and having picked nothing.

    Spelled once so a column added to the row is one edit here rather than one per test.
    """
    return {
        "on": on,
        "reason": reason,
        "task": task,
        "holds": [] if holds is None else holds,
        "pick_count": pick_count,
        "prompt_id": prompt_id,
        "refusal": refusal,
        "workflow": default_workflow() if workflow is None else workflow,
        "prompt": prompt_builder.DEFAULT_PROMPT if prompt is None else prompt,
        "pick_budget": pick_budget,
        "holds_held": holds_held,
        "stage": stage,
        "stage_name": stage_name,
    }


class AfkHome(unittest.TestCase):
    """A bot's home with one checkout in it, and GitHub answering for it."""

    def setUp(self) -> None:
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.checkout = self.home / "checkout"
        (self.checkout / ".git").mkdir(parents=True)
        for one in (
            patch.object(github, "token", return_value=("token", "env")),
            patch.object(github, "origin_repo", return_value="mock-user/memento"),
        ):
            one.start()
            self.addCleanup(one.stop)

    def folders(self) -> List[Any]:
        return [folder(str(self.checkout))]

    def choose(self, name: str = "Mine", build: Optional[str] = None, steps=()) -> Dict[str, Any]:
        """A workflow of this bot's own, and the project naming it."""
        entry = workflows.create(
            self.home,
            {"name": name, "stages": workflows.from_skills(build, steps)},
        )
        set_workflow(self.home, "p1", entry["id"])
        return entry


class WorkflowChoiceTests(AfkHome):
    """The workflow a project's AFK work runs under: its own pick, from the bot's library."""

    def test_a_project_that_picked_nothing_reads_one_run(self) -> None:
        found = read(self.home, "p1", self.folders())
        self.assertEqual(found["workflow"]["id"], workflows.DEFAULT_ID)
        self.assertEqual(found["workflow"]["name"], "One run", "the shape a prompt run has")
        self.assertEqual([stage["name"] for stage in found["workflow"]["stages"]], ["Build"])
        self.assertIsNone(found["stage"], "a prompt run is in no stage")
        self.assertIsNone(found["stage_name"])

    def test_a_pick_the_library_lost_reads_one_run(self) -> None:
        self.choose()
        lose_pick(self.home)
        found = read(self.home, "p1", self.folders())
        self.assertEqual(
            found["workflow"]["id"],
            workflows.DEFAULT_ID,
            "a workflow the library doesn't hold is no workflow to run",
        )

    def test_the_pick_is_read_back_from_the_host(self) -> None:
        entry = self.choose(build="plan", steps=["code-review"])
        found = read(self.home, "p1", self.folders())
        self.assertEqual(found["workflow"]["id"], entry["id"])
        self.assertEqual(found["workflow"]["name"], "Mine")
        self.assertEqual(found["workflow"]["stages"][0]["steps"], ["plan"])
        self.assertEqual(found["workflow"]["stages"][2]["steps"], ["code-review"])

    def test_the_pick_is_in_the_store_not_in_memory(self) -> None:
        entry = self.choose()
        conn = sqlite3.connect(db_path(self.home))
        try:
            row = conn.execute(
                "SELECT workflow_id FROM project_afk WHERE project_id = ?", ("p1",)
            ).fetchone()
        finally:
            conn.close()
        self.assertEqual(row, (entry["id"],))

    def test_one_projects_pick_leaves_anothers_alone(self) -> None:
        mine = self.choose(name="Mine")
        theirs = workflows.create(self.home, {"name": "Theirs", "stages": workflows.from_skills(None, [])})
        set_workflow(self.home, "p2", theirs["id"])
        self.assertEqual(read(self.home, "p1", self.folders())["workflow"]["id"], mine["id"])
        self.assertEqual(read(self.home, "p2", self.folders())["workflow"]["id"], theirs["id"])

    def test_the_switch_leaves_the_pick_alone(self) -> None:
        entry = self.choose()
        set_on(self.home, "p1", self.folders(), True)
        set_on(self.home, "p1", self.folders(), False)
        found = read(self.home, "p1", self.folders())
        self.assertEqual(found["workflow"]["id"], entry["id"])

    def test_picking_leaves_a_project_never_turned_on_with_its_switch_off(self) -> None:
        # The row sits under the switch, so choosing a workflow is no reason to start working.
        self.choose()
        self.assertFalse(read(self.home, "p1", self.folders())["on"])

    def test_a_pick_the_library_does_not_hold_is_refused(self) -> None:
        with self.assertRaises(ValueError):
            set_workflow(self.home, "p1", "wf-nowhere")
        self.assertEqual(
            read(self.home, "p1", self.folders())["workflow"]["id"],
            workflows.DEFAULT_ID,
            "nothing was written, so the project still runs the default preset",
        )

    def test_a_write_names_the_switch_or_a_workflow(self) -> None:
        self.assertEqual(write_from({"on": True}), ("on", True))
        self.assertEqual(write_from({"on": False}), ("on", False))
        self.assertEqual(write_from({"workflow_id": "wf-1"}), ("workflow", "wf-1"))
        self.assertEqual(
            write_from({"workflow_id": "  wf-1  "}), ("workflow", "wf-1"), "the id is trimmed"
        )

    def test_a_write_names_one_shape_at_a_time(self) -> None:
        for body in (
            {},
            {"on": True, "workflow_id": "wf-1"},
            {"on": "yes"},
            {"workflow_id": ""},
            {"workflow_id": 3},
        ):
            with self.subTest(body=body):
                with self.assertRaises(ValueError):
                    write_from(body)

    def test_a_project_whose_old_skill_columns_hold_something_is_migrated_once(self) -> None:
        set_skill_columns(self.home, "p1", "plan", ["code-review"])
        found = read(self.home, "p1", self.folders())
        self.assertNotEqual(found["workflow"]["id"], workflows.DEFAULT_ID, "its own workflow")
        self.assertEqual(
            [stage["name"] for stage in found["workflow"]["stages"]],
            ["Build", "Test", "Review"],
            "the three stages those columns described",
        )
        self.assertEqual(found["workflow"]["stages"][0]["steps"], ["plan"])
        self.assertEqual(found["workflow"]["stages"][2]["steps"], ["code-review"])
        again = read(self.home, "p1", self.folders())
        self.assertEqual(again["workflow"], found["workflow"], "written once, then read back")
        self.assertEqual(len(workflows.library(self.home)), 4, "three presets and the migration")


class PromptTests(AfkHome):
    """The project's Prompt: how its AFK work is carried out, kept on the host with the project.

    It is told to a run beside AFK's fixed brief, so it is read off the project's row when the run is
    posted — never from a device — and empty is the bot's default method again.
    """

    def prompt(self, project_id: str = "p1") -> str:
        return read(self.home, project_id, self.folders())["prompt"]

    def test_a_project_nobody_has_edited_reads_the_default_method(self) -> None:
        self.assertEqual(
            self.prompt(),
            prompt_builder.DEFAULT_PROMPT,
            "the host serves the method, so the app holds no copy of it",
        )
        self.assertIsNone(afk._row(self.home, "p1"), "nothing is stored for a project that wrote none")

    def test_a_prompt_written_on_a_device_is_read_back_from_the_host(self) -> None:
        set_prompt(self.home, "p1", "Run the suite twice, and say what the second run found.")
        self.assertEqual(
            self.prompt(), "Run the suite twice, and say what the second run found."
        )
        self.assertEqual(
            afk._row(self.home, "p1")["prompt"],
            "Run the suite twice, and say what the second run found.",
            "the row holds it, and the run is told it off that row",
        )

    def test_an_empty_prompt_is_the_default_again(self) -> None:
        set_prompt(self.home, "p1", "Run the suite twice.")
        set_prompt(self.home, "p1", "   ")
        self.assertEqual(self.prompt(), prompt_builder.DEFAULT_PROMPT)
        self.assertIsNone(
            afk._row(self.home, "p1")["prompt"], "a blank Prompt stores nothing to read back"
        )

    def test_writing_a_prompt_clears_the_workflow_pick(self) -> None:
        self.choose()
        set_prompt(self.home, "p1", "Squash every checkpoint into one commit.")
        self.assertIsNone(afk._row(self.home, "p1")["workflow_id"], "a project is never both")
        self.assertEqual(
            read(self.home, "p1", self.folders())["workflow"]["id"],
            workflows.DEFAULT_ID,
            "it runs no picked workflow any more",
        )

    def test_a_blank_prompt_clears_the_pick_too(self) -> None:
        self.choose()
        set_prompt(self.home, "p1", "")
        self.assertIsNone(afk._row(self.home, "p1")["workflow_id"])

    def test_a_prompt_keeps_a_migration_from_putting_a_pick_back(self) -> None:
        # A row from before the picker: reading it would migrate the project onto the workflow those
        # columns describe, and that pick would be what works the next task instead of the Prompt.
        set_skill_columns(self.home, "p1", "plan", ["code-review"])
        set_prompt(self.home, "p1", "Squash every checkpoint into one commit.")
        self.assertEqual(
            read(self.home, "p1", self.folders())["workflow"]["id"],
            workflows.DEFAULT_ID,
            "the old columns are not a pick this project still holds",
        )

    def test_clearing_a_prompt_does_not_bring_the_old_skills_back(self) -> None:
        set_skill_columns(self.home, "p1", "plan", ["code-review"])
        migrated = read(self.home, "p1", self.folders())["workflow"]["id"]
        self.assertNotEqual(migrated, workflows.DEFAULT_ID, "migrated on its first read")
        set_prompt(self.home, "p1", "Squash every checkpoint into one commit.")
        set_prompt(self.home, "p1", "")
        found = read(self.home, "p1", self.folders())
        self.assertEqual(found["prompt"], prompt_builder.DEFAULT_PROMPT, "empty is the default")
        self.assertEqual(found["workflow"]["id"], workflows.DEFAULT_ID, "and no pick comes back")
        self.assertIsNone(afk._row(self.home, "p1")["workflow_id"])

    def test_picking_a_workflow_clears_the_prompt_too(self) -> None:
        set_prompt(self.home, "p1", "Squash every checkpoint into one commit.")
        self.choose()
        self.assertIsNone(afk._row(self.home, "p1")["prompt"], "a project is never both")
        self.assertEqual(
            self.prompt(),
            prompt_builder.DEFAULT_PROMPT,
            "the sheet shows the method its next run will read",
        )

    def test_one_projects_prompt_leaves_anothers_alone(self) -> None:
        set_prompt(self.home, "p2", "Theirs.")
        self.assertEqual(self.prompt(), prompt_builder.DEFAULT_PROMPT)
        self.assertEqual(self.prompt("p2"), "Theirs.")

    def test_writing_a_prompt_is_no_reason_to_start_working(self) -> None:
        set_prompt(self.home, "p1", "Squash every checkpoint into one commit.")
        self.assertFalse(read(self.home, "p1", self.folders())["on"])

    def test_a_write_names_the_prompt_as_its_own_shape(self) -> None:
        self.assertEqual(write_from({"prompt": "Mine."}), ("prompt", "Mine."))
        self.assertEqual(write_from({"prompt": "  Mine.  "}), ("prompt", "Mine."), "trimmed")
        self.assertEqual(write_from({"prompt": ""}), ("prompt", None), "cleared")
        self.assertEqual(write_from({"prompt": "   "}), ("prompt", None))
        self.assertEqual(write_from({"prompt": None}), ("prompt", None))

    def test_a_prompt_is_never_written_beside_another_shape(self) -> None:
        for body in (
            {"prompt": "Mine.", "on": True},
            {"prompt": "Mine.", "workflow_id": "wf-1"},
            {"prompt": 3},
        ):
            with self.subTest(body=body):
                with self.assertRaises(ValueError):
                    write_from(body)

    def test_a_stored_prompt_is_what_the_run_is_told(self) -> None:
        set_prompt(self.home, "p1", "Squash every checkpoint into one commit.")
        body = afk.run_body(
            self.record(),
            {"repo": "mock-user/memento", "number": 265},
            "Squash every checkpoint into one commit.",
        )
        self.assertIn("Squash every checkpoint into one commit.", body["instructions"])
        self.assertNotIn(
            prompt_builder.DEFAULT_PROMPT,
            body["instructions"],
            "the project's own words stand in for the default",
        )

    def record(self) -> Dict[str, Any]:
        """A session's record as the run's request reads it."""
        return {
            "session_id": "memento-afk-s1",
            "project_id": "p1",
            "mode": "auto",
            "repos": [
                {
                    "name": "mock-user/memento",
                    "repo_root": str(self.checkout),
                    "path": "/trees/afk-265",
                    "branch": "hermes/afk-265",
                }
            ],
        }

    def test_a_staged_tasks_first_run_opens_with_the_issue_too(self) -> None:
        task = {
            "repo": "mock-user/memento",
            "number": 265,
            "title": "It",
            "url": "https://github.com/mock-user/memento/issues/265",
            "body": "Read the frontier first.\n",
        }
        body = afk.run_body({**self.record(), "pipeline": staged_record(pipeline.BUILD)}, task, None)
        self.assertEqual(
            body["input"][0]["content"],
            prompt_builder.afk_input(task),
            "a staged task's first run is handed the issue like any other",
        )
        self.assertIn(
            "in the message this session opened with",
            body["instructions"],
            "and told so, rather than sent to fetch what it was handed",
        )

    def test_a_later_stage_run_keeps_its_one_line_input(self) -> None:
        task = {
            "repo": "mock-user/memento",
            "number": 265,
            "title": "It",
            "url": "https://github.com/mock-user/memento/issues/265",
            "body": "Read the frontier first.\n",
        }
        body = afk.stage_body({**self.record(), "pipeline": staged_record(pipeline.CRITIQUE)}, task)
        self.assertNotIn("Description:", body["input"][0]["content"])
        self.assertNotIn(task["body"], body["input"][0]["content"])
        self.assertTrue(
            body["input"][0]["content"].endswith(f"({task['url']})"),
            "one line naming the stage and the issue, as it always was",
        )
        self.assertIn(
            "isn't repeated here", body["instructions"], "a later run has to read the issue itself"
        )


class ClaimStubTests(unittest.TestCase):
    """A Hermes home with one checkout, and GitHub as the plugin's own HTTP stub.

    ``_get``/``_page`` answer the reads and ``_request`` records the writes.
    """

    def setUp(self) -> None:
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.checkout = self.home / "checkout"
        (self.checkout / ".git").mkdir(parents=True)
        self.issues: List[dict] = []
        self.label_exists = True
        self.write_error: Exception | None = None
        self.write_error_on: str | None = None
        self.read_error: Exception | None = None
        self.writes: List[tuple] = []
        self._patches = [
            patch.object(github, "token", return_value=("token", "env")),
            patch.object(github, "origin_repo", return_value="mock-user/memento"),
            patch.object(github, "_get", self.answer_get),
            patch.object(github, "_page", self.answer_page),
            patch.object(github, "_request", self.answer_request),
        ]
        for one in self._patches:
            one.start()
            self.addCleanup(one.stop)

    def folders(self) -> List[Any]:
        return [folder(str(self.checkout))]

    def on(self) -> None:
        set_on(self.home, "p1", self.folders(), True)

    def sweep(self, skills: Any = None) -> None:
        sweep(self.home, "p1", self.folders(), skills=skills)

    def shown(self) -> dict:
        """What the sheet reads after a sweep: the switch, the task held and the last refusal."""
        return read(self.home, "p1", self.folders())

    def answer_get(self, path: str, auth: Any) -> Any:
        if path == "/user":
            return {"login": "mock-user"}
        if path.startswith("/repos/mock-user/memento/labels/"):
            if self.label_exists:
                return {"name": CLAIM_LABEL}
            # GitHub words a missing label as it words any missing thing.
            raise github.GitHubError("Not Found")
        if path.startswith("/repos/mock-user/memento/issues?"):
            if self.read_error is not None:
                raise self.read_error
            return self.issues
        raise AssertionError(f"unexpected read: {path}")

    def answer_page(self, path: str, auth: Any) -> Any:
        return self.answer_get(path, auth), ""

    def answer_request(self, path: str, auth: Any, method: str = "GET", data: Any = None) -> Any:
        self.writes.append((method, path, data))
        refused = self.write_error is not None and (
            self.write_error_on is None or self.write_error_on in path
        )
        if refused:
            raise self.write_error
        return {}


class ClaimTests(ClaimStubTests):
    """The sweep: the oldest ready task assigned and marked on GitHub, one at a time."""

    def test_the_oldest_ready_task_is_assigned_and_marked(self) -> None:
        self.on()
        self.issues = [
            issue_row(266, created="2026-10-02T00:00:00Z"),
            issue_row(265, created="2026-10-01T00:00:00Z"),
        ]
        self.sweep()
        self.assertEqual(self.shown()["task"]["number"], 265, "the oldest is the one AFK takes")
        self.assertEqual(
            self.writes,
            [
                ("POST", "/repos/mock-user/memento/issues/265/labels", {"labels": [CLAIM_LABEL]}),
                (
                    "POST",
                    "/repos/mock-user/memento/issues/265/assignees",
                    {"assignees": ["mock-user"]},
                ),
            ],
        )

    def test_the_issue_it_claims_opens_its_run(self) -> None:
        body = "## What to build\n\nOldest first.\n\n- one\n- two"
        self.on()
        self.issues = [issue_row(265, body=body)]
        claimed = sweep(self.home, "p1", self.folders(), skills=None)
        self.assertEqual(
            claimed[0]["body"], body, "each task the sweep answers carries the issue's text"
        )
        self.assertNotIn(
            "body", self.shown()["task"], "the row it holds is the sheet's, and the sheet shows none"
        )

    def test_the_claim_mark_is_created_when_the_repository_has_none(self) -> None:
        self.on()
        self.label_exists = False
        self.issues = [issue_row(265)]
        self.sweep()
        method, path, data = self.writes[0]
        self.assertEqual((method, path), ("POST", "/repos/mock-user/memento/labels"))
        self.assertEqual(data["name"], CLAIM_LABEL)
        # And only then is the task claimed with it.
        self.assertEqual(
            self.writes[1],
            ("POST", "/repos/mock-user/memento/issues/265/labels", {"labels": [CLAIM_LABEL]}),
        )

    def test_an_older_task_somebody_already_claimed_is_passed_over(self) -> None:
        self.on()
        self.issues = [
            issue_row(265, labels=(READY_LABEL, CLAIM_LABEL)),
            issue_row(266, created="2026-10-02T00:00:00Z"),
        ]
        self.sweep()
        self.assertEqual(self.shown()["task"]["number"], 266, "the next ready one is taken")

    def test_a_pass_fills_every_place_up_to_the_pick_count_and_no_further(self) -> None:
        """The one-at-a-time pin, at the count that replaced it (ADR 0025).

        A project holds as many tasks as its count says; one pass takes the oldest ready ones up to
        that number, and a pass that finds every place full claims nothing at all — not even a read
        of GitHub.
        """
        self.on()
        afk.set_pick_count(self.home, "p1", 3)
        self.issues = [
            issue_row(267, created="2026-10-03T00:00:00Z"),
            issue_row(265),
            issue_row(266, created="2026-10-02T00:00:00Z"),
        ]
        self.sweep()
        self.assertEqual(
            [hold.task["number"] for hold in afk._holds(self.home, "p1")],
            [265, 266, 267],
            "all three places fill in one pass, oldest first, whatever order GitHub lists them in",
        )
        self.assertEqual(
            [path for method, path, _ in self.writes if path.endswith("/labels")],
            [f"/repos/mock-user/memento/issues/{number}/labels" for number in (265, 266, 267)],
            "each is claimed on GitHub, in the order they were taken",
        )
        self.assertEqual(self.shown()["task"]["number"], 265, "the read still answers the oldest")
        asked = len(self.writes)
        self.sweep()
        self.assertEqual(len(self.writes), asked, "a project at its count claims nothing")

    def test_nothing_is_claimed_before_the_switch_is_on(self) -> None:
        self.issues = [issue_row(265)]
        self.sweep()
        self.assertIsNone(self.shown()["task"], "a project that isn't left to work is never swept")
        self.assertEqual(self.writes, [])

    def test_a_refusal_stops_the_sweep_with_the_switch_left_on_and_its_reason_kept(self) -> None:
        self.on()
        self.issues = [issue_row(265), issue_row(266, created="2026-10-02T00:00:00Z")]
        self.write_error = github.GitHubError("Resource not accessible by personal access token", 403)
        self.sweep()
        shown = self.shown()
        self.assertIsNone(self.shown()["task"], "a task GitHub refused is not held")
        self.assertEqual(shown["refusal"], "Resource not accessible by personal access token")
        self.assertTrue(shown["on"], "a GitHub refusal doesn't turn the project off")
        self.assertTrue(read(self.home, "p1", self.folders())["on"], "the switch stays on")
        self.assertEqual(len(self.writes), 1, "and the sweep stops rather than working the rest")

    def test_a_read_github_refuses_is_recorded_too(self) -> None:
        self.on()
        self.read_error = github.GitHubError("API rate limit exceeded for 1.2.3.4.", 403)
        self.sweep()
        self.assertEqual(self.shown()["refusal"], "API rate limit exceeded for 1.2.3.4.")
        self.assertTrue(read(self.home, "p1", self.folders())["on"])
        self.assertEqual(self.writes, [])

    def test_a_missing_account_is_the_switchs_reason_and_not_a_refusal(self) -> None:
        self.on()
        self.issues = [issue_row(265)]
        with patch.object(github, "token", return_value=(None, "none")):
            self.sweep()
            shown = self.shown()
        self.assertEqual(shown["reason"], NO_GITHUB)
        self.assertIsNone(shown["refusal"], "a fact the switch already says isn't a refusal as well")
        self.assertEqual(self.writes, [])

    def test_a_refused_assignment_takes_the_mark_back_off(self) -> None:
        # The label is on, the assignment is refused: leaving the mark would keep the task out of
        # every frontier while no sweep holds it, which is a task nothing ever works.
        self.on()
        self.issues = [issue_row(265), issue_row(266, created="2026-10-02T00:00:00Z")]
        self.write_error = github.GitHubError("Resource not accessible by personal access token", 403)
        self.write_error_on = "/assignees"
        self.sweep()
        shown = self.shown()
        self.assertIsNone(shown["task"], "a claim it couldn't finish isn't held")
        self.assertEqual(
            self.writes,
            [
                ("POST", "/repos/mock-user/memento/issues/265/labels", {"labels": [CLAIM_LABEL]}),
                (
                    "POST",
                    "/repos/mock-user/memento/issues/265/assignees",
                    {"assignees": ["mock-user"]},
                ),
                ("DELETE", "/repos/mock-user/memento/issues/265/labels/gots-got-it", None),
            ],
            "the mark is taken back off, so the task is in the frontier again",
        )
        self.assertEqual(shown["refusal"], "Resource not accessible by personal access token")

    def test_once_the_task_it_holds_is_released_the_next_sweep_takes_the_one_behind_it(self) -> None:
        self.on()
        self.issues = [issue_row(265), issue_row(266, created="2026-10-02T00:00:00Z")]
        self.sweep()
        self.assertEqual(self.shown()["task"]["number"], 265)
        release(self.home, "p1")
        self.issues = [issue_row(266, created="2026-10-02T00:00:00Z")]
        self.sweep()
        self.assertEqual(self.shown()["task"]["number"], 266, "the one behind it is taken next")

    def test_a_successful_sweep_clears_the_last_refusal(self) -> None:
        self.on()
        self.issues = [issue_row(265)]
        self.write_error = github.GitHubError("GitHub answered 403.", 403)
        self.sweep()
        self.assertEqual(self.shown()["refusal"], "GitHub answered 403.")
        self.write_error = None
        self.sweep()
        self.assertIsNone(self.shown()["refusal"], "GitHub answered, so the reason is stale")
        self.assertEqual(self.shown()["task"]["number"], 265)

    def test_an_empty_frontier_holds_nothing_and_clears_an_old_refusal(self) -> None:
        self.on()
        self.read_error = github.GitHubError("Couldn't reach GitHub from the server.")
        self.sweep()
        self.assertEqual(self.shown()["refusal"], "Couldn't reach GitHub from the server.")
        self.read_error = None
        self.issues = []
        self.sweep()
        self.assertIsNone(self.shown()["task"])
        self.assertIsNone(self.shown()["refusal"])
        self.assertEqual(self.writes, [])

    def test_the_app_reads_the_task_held_and_the_last_refusal(self) -> None:
        self.on()
        self.issues = [issue_row(265)]
        self.sweep()
        shown = read(self.home, "p1", self.folders())
        self.assertEqual(shown["on"], True)
        self.assertIsNone(shown["reason"])
        self.assertEqual(
            shown["task"],
            {
                "repo": "mock-user/memento",
                "number": 265,
                "title": "Task 265",
                "url": "https://github.com/mock-user/memento/issues/265",
                "created_at": "2026-10-01T00:00:00Z",
            },
        )
        self.assertIsNone(shown["refusal"])

    def test_turning_it_on_wakes_the_sweep_now(self) -> None:
        with patch.object(afk, "wake") as wake:
            self.on()
            wake.assert_called_once()
            set_on(self.home, "p1", self.folders(), False)
        self.assertEqual(wake.call_count, 1, "turning it off has nothing to wake for")


class PickCountTests(ClaimStubTests):
    """How many tasks a project holds at once: the read's answer, the write, and what a hold owns."""

    def hold(self, home: Optional[Path] = None) -> List[afk.Hold]:
        return afk._holds(home or self.home, "p1")

    def fill(self, count: int, numbers: List[int]) -> None:
        """A project at ``count`` holding exactly ``numbers``, each in a session of its own."""
        set_pick_count(self.home, "p1", count)
        self.on()
        self.issues = [issue_row(number) for number in numbers]
        self.sweep()
        for number in numbers:
            mine = next(hold for hold in self.hold() if hold.task["number"] == number)
            afk._adopt(self.home, "p1", f"memento-afk-{number}", mine.task)
        self.writes.clear()

    def test_the_read_answers_every_hold_and_the_count(self) -> None:
        self.fill(2, [265, 266])
        shown = self.shown()
        self.assertEqual(shown["pick_count"], 2)
        self.assertEqual(
            [hold["number"] for hold in shown["holds"]],
            [265, 266],
            "the whole list, oldest first",
        )
        self.assertEqual(
            shown["holds"][0],
            {
                "repo": "mock-user/memento",
                "number": 265,
                "title": "Task 265",
                "url": "https://github.com/mock-user/memento/issues/265",
                "created_at": "2026-10-01T00:00:00Z",
                "stage": None,
                "stage_name": None,
                "stalled": None,
            },
            "a hold is its task, the stage it is in, and why it stalled — all null before a start",
        )
        self.assertEqual(
            shown["task"]["number"],
            265,
            "`task` stays the oldest hold, so an app that draws one Working row draws the right one",
        )
        self.assertIsNone(shown["prompt_id"], "a Prompt nobody copied names no library entry")

    def test_a_project_that_names_no_count_reads_as_one(self) -> None:
        self.assertEqual(self.shown()["pick_count"], 1)
        self.assertEqual(self.shown()["holds"], [])

    def test_a_count_a_write_names_is_what_the_sheet_reads_back(self) -> None:
        self.assertEqual(write_from({"pick_count": 4}), ("pick_count", 4))
        afk.set_pick_count(self.home, "p1", 4)
        self.assertEqual(self.shown()["pick_count"], 4)

    def test_a_count_outside_one_to_five_is_refused(self) -> None:
        for body in (0, 6, -1, "3", 2.5, True, None):
            with self.subTest(pick_count=body):
                with self.assertRaises(ValueError) as raised:
                    write_from({"pick_count": body})
                self.assertEqual(
                    str(raised.exception), "pick_count must be a whole number from 1 to 5."
                )

    def test_a_write_names_one_shape_at_a_time(self) -> None:
        with self.assertRaises(ValueError) as raised:
            write_from({"pick_count": 2, "on": True})
        self.assertEqual(
            str(raised.exception), "A write names one of on, workflow_id, prompt or pick_count."
        )

    def test_lowering_the_count_abandons_nothing(self) -> None:
        self.fill(3, [265, 266, 267])
        afk.set_pick_count(self.home, "p1", 1)
        self.assertEqual(
            [hold.task["number"] for hold in self.hold()],
            [265, 266, 267],
            "the surplus is left to finish: releasing it would hand back work already under way",
        )
        self.assertEqual(self.writes, [], "and nothing is given back on GitHub")
        self.assertEqual(self.shown()["pick_count"], 1)
        self.sweep()
        self.assertEqual(len(self.hold()), 3, "the next pass fills to the new count, not under it")

    def test_a_stalled_hold_keeps_its_place_and_its_own_clock(self) -> None:
        self.fill(2, [265, 266])
        old = next(hold.task for hold in self.hold() if hold.task["number"] == 265)
        hold_update(self.home, old, claimed_at=int(time.time()) - afk.STALL_SECONDS - 1)
        self.assertEqual(
            list(afk.stalled(self.home)),
            ["memento-afk-265"],
            "the hold taken long ago is the one waiting; the one claimed after it is still starting",
        )
        self.sweep()
        self.assertEqual(
            [hold.task["number"] for hold in self.hold()],
            [265, 266],
            "a stalled hold is still the project's work in flight, so its place is kept",
        )
        self.assertEqual(self.writes, [], "and nothing is claimed while both places are taken")

    def test_a_task_the_project_already_holds_is_passed_over(self) -> None:
        self.fill(2, [265])
        self.issues = [issue_row(265), issue_row(266, created="2026-10-02T00:00:00Z")]
        self.sweep()
        self.assertEqual(
            [hold.task["number"] for hold in self.hold()],
            [265, 266],
            "the free place goes to the next ready task, and the held one is left where it is",
        )
        self.assertEqual(
            [path for method, path, _ in self.writes if path.endswith("/assignees")],
            ["/repos/mock-user/memento/issues/266/assignees"],
            "nothing is claimed twice",
        )

    def test_a_refusal_part_way_stops_the_pass_with_what_it_already_claimed(self) -> None:
        set_pick_count(self.home, "p1", 2)
        self.on()
        self.issues = [issue_row(265), issue_row(266, created="2026-10-02T00:00:00Z")]
        self.write_error = github.GitHubError("Resource not accessible by personal access token", 403)
        self.write_error_on = "issues/266"
        self.sweep()
        self.assertEqual(
            [hold.task["number"] for hold in self.hold()],
            [265],
            "a task claimed before the refusal is the project's, and the one refused isn't",
        )
        shown = self.shown()
        self.assertEqual(shown["refusal"], "Resource not accessible by personal access token")
        self.assertTrue(shown["on"], "a GitHub refusal doesn't turn the project off")

    def test_giving_one_task_back_frees_exactly_that_hold(self) -> None:
        self.fill(3, [265, 266, 267])
        middle = next(hold.task for hold in self.hold() if hold.task["number"] == 266)
        self.assertTrue(
            afk.release_session(
                self.home,
                {"session_id": "memento-afk-266", "project_id": "p1", "task": middle},
            )
        )
        self.assertEqual(
            [hold.task["number"] for hold in self.hold()],
            [265, 267],
            "the session's own task goes, and the project's other holds stay",
        )
        self.assertEqual(
            [write[1] for write in self.writes],
            [
                "/repos/mock-user/memento/issues/266/labels/gots-got-it",
                "/repos/mock-user/memento/issues/266/assignees",
            ],
            "only that task's claim comes off GitHub",
        )


class PickBudgetSettingTests(unittest.TestCase):
    """The bot's pick budget itself: what an unset one reads as, what a write takes, and the answer
    the bot-level route refuses.

    One number on the bot's own store, so most of this needs no project and no GitHub at all — the
    budget is read and written the way the Coding tab's stepper does, and the project's read only
    carries it along.
    """

    def setUp(self) -> None:
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)

    def test_a_bot_that_names_no_budget_works_five(self) -> None:
        self.assertEqual(afk.pick_budget(self.home), 5, "five is every bot's budget until it says")
        self.assertEqual(afk.bot_read(self.home), {"pick_budget": 5, "holds_held": 0})

    def test_the_budget_is_read_back_from_the_hosts_own_store(self) -> None:
        set_pick_budget(self.home, 3)
        self.assertEqual(afk.pick_budget(self.home), 3)
        self.assertEqual(
            get_setting(db_path(self.home), "afk_pick_budget"),
            3,
            "the number is the bot's own settings row, not a column and not memory",
        )
        self.assertEqual(afk.bot_read(self.home)["pick_budget"], 3)

    def test_a_stored_budget_outside_one_to_ten_reads_as_the_nearest_it_can_be(self) -> None:
        for stored, answered in ((0, 1), (-4, 1), (11, 10), (99, 10)):
            with self.subTest(stored=stored):
                put_setting(db_path(self.home), "afk_pick_budget", stored)
                self.assertEqual(afk.pick_budget(self.home), answered)

    def test_a_stored_budget_that_is_no_number_reads_as_five(self) -> None:
        # A row somebody wrote by hand, or one an older build wrote another way: the default is the
        # answer rather than a sheet with no budget on it.
        for stored in ("3", 2.5, True, None, [5], {"pick_budget": 5}):
            with self.subTest(stored=stored):
                put_setting(db_path(self.home), "afk_pick_budget", stored)
                self.assertEqual(afk.pick_budget(self.home), 5)

    def test_every_whole_number_from_one_to_ten_is_a_budget(self) -> None:
        for value in range(1, 11):
            with self.subTest(pick_budget=value):
                self.assertEqual(afk.budget_from({"pick_budget": value}), value)
                set_pick_budget(self.home, value)
                self.assertEqual(afk.pick_budget(self.home), value)

    def test_a_budget_outside_one_to_ten_is_refused(self) -> None:
        for body in (0, 11, -1, "3", 2.5, True, None):
            with self.subTest(pick_budget=body):
                with self.assertRaises(ValueError) as raised:
                    afk.budget_from({"pick_budget": body})
                self.assertEqual(
                    str(raised.exception), "pick_budget must be a whole number from 1 to 10."
                )

    def test_a_write_that_names_no_budget_is_refused_the_same_way(self) -> None:
        for body in ({}, {"on": True}, {"pick_count": 2}):
            with self.subTest(body=body):
                with self.assertRaises(ValueError) as raised:
                    afk.budget_from(body)
                self.assertEqual(
                    str(raised.exception), "pick_budget must be a whole number from 1 to 10."
                )

    def test_a_field_beside_the_budget_is_not_a_refusal(self) -> None:
        # ADR 0026's usage threshold lands on this same route later: a body carrying it must not
        # stop the budget being written.
        self.assertEqual(afk.budget_from({"pick_budget": 4, "threshold": 90}), 4)

    def test_every_projects_read_answers_the_budget_and_the_holds_against_it(self) -> None:
        held = {
            "repo": "mock-user/memento",
            "number": 265,
            "title": "Task 265",
            "url": "https://github.com/mock-user/memento/issues/265",
            "created_at": "2026-10-01T00:00:00Z",
        }
        afk._hold(self.home, "p1", held)
        afk._hold(self.home, "p2", held)
        set_pick_budget(self.home, 3)
        for project_id in ("p1", "p2"):
            with self.subTest(project=project_id):
                found = read(self.home, project_id, [])
                self.assertEqual(
                    (found["pick_budget"], found["holds_held"]),
                    (3, 2),
                    "one read draws the bot's numbers, whatever project the sheet was opened on",
                )

    def test_a_project_with_no_row_answers_the_bot_s_numbers_too(self) -> None:
        found = read(self.home, "p9", [])
        self.assertFalse(found["on"])
        self.assertEqual((found["pick_budget"], found["holds_held"]), (5, 0))


class PickBudgetTests(unittest.TestCase):
    """The bot's pick budget over its projects: what a pass may claim, in which order, and what it
    says on a project it held back (ADR 0042).

    Two projects with a repository each: the budget is only ever about what several projects claim
    together, which one checkout can't show. GitHub is the plugin's own stub, answering each
    repository's issues and recording every read and write.
    """

    REPOS = {"p1": "mock-user/one", "p2": "mock-user/two"}

    def setUp(self) -> None:
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.home.joinpath("projects.db").write_text("")
        self.checkouts: Dict[str, Path] = {}
        for project_id in self.REPOS:
            checkout = self.home / project_id
            (checkout / ".git").mkdir(parents=True)
            self.checkouts[project_id] = checkout
        self.issues: Dict[str, List[dict]] = {repo: [] for repo in self.REPOS.values()}
        self.reads: List[str] = []
        self.writes: List[tuple] = []
        self.write_error: Optional[Exception] = None
        self.write_error_on: Optional[str] = None
        for one in (
            patch.object(github, "token", return_value=("token", "env")),
            patch.object(github, "origin_repo", self.repo_of),
            patch.object(github, "_get", self.answer_get),
            patch.object(github, "_page", self.answer_page),
            patch.object(github, "_request", self.answer_request),
            patch.object(afk, "wake"),
        ):
            one.start()
            self.addCleanup(one.stop)

    def repo_of(self, path: Any) -> Optional[str]:
        for project_id, checkout in self.checkouts.items():
            if str(path) == str(checkout):
                return self.REPOS[project_id]
        return None

    def answer_get(self, path: str, auth: Any) -> Any:
        if path == "/user":
            return {"login": "mock-user"}
        if "/labels/" in path:
            return {"name": CLAIM_LABEL}
        for repo, issues in self.issues.items():
            if path.startswith(f"/repos/{repo}/issues?"):
                self.reads.append(repo)
                return issues
        raise AssertionError(f"unexpected read: {path}")

    def answer_page(self, path: str, auth: Any) -> Any:
        return self.answer_get(path, auth), ""

    def answer_request(self, path: str, auth: Any, method: str = "GET", data: Any = None) -> Any:
        self.writes.append((method, path, data))
        refused = self.write_error is not None and (
            self.write_error_on is None or self.write_error_on in path
        )
        if refused:
            raise self.write_error
        return {}

    def project(self, project_id: str) -> SimpleNamespace:
        return SimpleNamespace(
            id=project_id, folders=[folder(str(self.checkouts[project_id]))], archived=False
        )

    def folders(self, project_id: str) -> List[Any]:
        return [folder(str(self.checkouts[project_id]))]

    def turn_on(self, project_id: str, count: int = 1) -> None:
        set_pick_count(self.home, project_id, count)
        set_on(self.home, project_id, self.folders(project_id), True)

    def pass_(self) -> List[tuple]:
        """One sweep of the whole bot, over both projects as a host lists them."""
        with stub_projects_db(projects=[self.project("p1"), self.project("p2")]):
            return sweep_all(self.home)

    def holds(self, project_id: str) -> List[int]:
        return [hold.task["number"] for hold in afk._holds(self.home, project_id)]

    def shown(self, project_id: str) -> dict:
        return read(self.home, project_id, self.folders(project_id))

    def test_the_budget_caps_what_the_bots_projects_claim_together(self) -> None:
        set_pick_budget(self.home, 2)
        self.turn_on("p1", 2)
        self.turn_on("p2", 2)
        self.issues["mock-user/one"] = [
            issue_row(265),
            issue_row(267, created="2026-10-03T00:00:00Z"),
        ]
        self.issues["mock-user/two"] = [
            issue_row(266, created="2026-10-02T00:00:00Z"),
            issue_row(268, created="2026-10-04T00:00:00Z"),
        ]
        claimed = self.pass_()
        self.assertEqual(
            [(project_id, task["number"]) for project_id, task in claimed],
            [("p1", 265), ("p2", 266)],
            "two places over four free ones, and the two oldest ready tasks take them",
        )
        self.assertEqual(self.holds("p1"), [265])
        self.assertEqual(self.holds("p2"), [266])
        self.assertEqual(self.shown("p1")["holds_held"], 2, "the count is every project's holds")
        self.assertEqual(self.shown("p2")["pick_budget"], 2)

    def test_a_freed_place_goes_to_the_oldest_task_across_the_bot(self) -> None:
        """The frontier's oldest-first rule, read over the bot rather than over one project."""
        set_pick_budget(self.home, 1)
        self.turn_on("p1", 1)
        self.turn_on("p2", 1)
        # p1 is swept first — it is the first project the pass reads — and its task is the newer.
        self.issues["mock-user/one"] = [issue_row(300, created="2026-10-09T00:00:00Z")]
        self.issues["mock-user/two"] = [issue_row(301, created="2026-10-01T00:00:00Z")]
        claimed = self.pass_()
        self.assertEqual(
            [(project_id, task["number"]) for project_id, task in claimed],
            [("p2", 301)],
            "the bot's oldest ready task, not the first project in iteration order",
        )
        self.assertEqual(self.holds("p1"), [], "the newer task waits for the next free place")
        self.assertEqual(self.holds("p2"), [301])
        self.assertEqual(
            self.shown("p1")["refusal"],
            afk.PICK_BUDGET_FULL.format(held=1, budget=1),
            "the project the budget skipped is the one that says so",
        )
        self.assertIsNone(self.shown("p2")["refusal"], "the project that claimed says nothing")

    def test_the_budget_is_counted_once_a_pass_before_any_github_read(self) -> None:
        """A sweep the budget holds back asks GitHub nothing at all, not even what is ready."""
        set_pick_budget(self.home, 1)
        self.turn_on("p1", 1)
        self.issues["mock-user/one"] = [issue_row(265)]
        self.pass_()
        self.assertEqual(self.holds("p1"), [265], "the one place the budget allows is taken")
        self.turn_on("p2", 1)
        self.issues["mock-user/two"] = [issue_row(266)]
        self.reads.clear()
        self.writes.clear()
        with patch.object(afk.tasks, "frontier", wraps=afk.tasks.frontier) as frontier:
            self.pass_()
        frontier.assert_not_called()
        self.assertEqual(self.reads, [], "a project the budget skipped costs no read of GitHub")
        self.assertEqual(self.writes, [])
        self.assertEqual(
            self.shown("p2")["refusal"], afk.PICK_BUDGET_FULL.format(held=1, budget=1)
        )

    def test_a_stalled_hold_counts_against_the_budget(self) -> None:
        """A hold is the bot's claimed work whether or not something is running it."""
        set_pick_budget(self.home, 1)
        self.turn_on("p1", 1)
        self.issues["mock-user/one"] = [issue_row(265)]
        self.pass_()
        stalled = afk._holds(self.home, "p1")[0].task
        afk._stall(self.home, "p1", stalled, afk.FAILED_RUN)
        self.turn_on("p2", 1)
        self.issues["mock-user/two"] = [issue_row(266)]
        self.pass_()
        self.assertEqual(self.holds("p2"), [], "five stalled holds would stop a bot at five")
        self.assertEqual(
            self.shown("p2")["refusal"], afk.PICK_BUDGET_FULL.format(held=1, budget=1)
        )
        self.assertEqual(self.shown("p1")["holds"][0]["stalled"], afk.FAILED_RUN)

    def test_lowering_the_budget_abandons_nothing(self) -> None:
        set_pick_budget(self.home, 2)
        self.turn_on("p1", 2)
        self.issues["mock-user/one"] = [
            issue_row(265),
            issue_row(266, created="2026-10-02T00:00:00Z"),
        ]
        self.pass_()
        self.assertEqual(self.holds("p1"), [265, 266])
        self.writes.clear()
        set_pick_budget(self.home, 1)
        self.assertEqual(
            self.holds("p1"),
            [265, 266],
            "the surplus is left to finish: giving it back would hand back work under way",
        )
        self.assertEqual(self.writes, [], "and nothing is taken off GitHub")
        self.pass_()
        self.assertEqual(self.holds("p1"), [265, 266], "the bot claims nothing until it is under it")
        self.assertEqual(self.writes, [])

    def test_the_refusal_lands_only_on_the_projects_the_budget_skipped(self) -> None:
        set_pick_budget(self.home, 1)
        self.turn_on("p1", 1)
        self.issues["mock-user/one"] = [issue_row(265)]
        self.pass_()
        self.turn_on("p2", 1)
        self.issues["mock-user/two"] = [issue_row(266)]
        self.pass_()
        self.assertEqual(
            self.shown("p2")["refusal"], afk.PICK_BUDGET_FULL.format(held=1, budget=1)
        )
        self.assertIsNone(
            self.shown("p1")["refusal"],
            "a project at its own count was not skipped by the budget, and says nothing of it",
        )

    def test_the_budget_answers_each_projects_read_after_a_pass(self) -> None:
        set_pick_budget(self.home, 3)
        self.turn_on("p1", 2)
        self.issues["mock-user/one"] = [
            issue_row(265),
            issue_row(266, created="2026-10-02T00:00:00Z"),
        ]
        self.pass_()
        for project_id in ("p1", "p2"):
            with self.subTest(project=project_id):
                found = self.shown(project_id)
                self.assertEqual(
                    (found["pick_budget"], found["holds_held"]),
                    (3, 2),
                    "\"Pick budget 2 of 3\", drawn from whichever project's read the sheet has",
                )

    def test_a_refusal_on_one_project_leaves_anothers_claim_standing(self) -> None:
        """GitHub refusing one project's claim is that project's trouble, not the bot's."""
        set_pick_budget(self.home, 2)
        self.turn_on("p1", 1)
        self.turn_on("p2", 1)
        self.issues["mock-user/one"] = [issue_row(265)]
        self.issues["mock-user/two"] = [issue_row(266, created="2026-10-02T00:00:00Z")]
        self.write_error = github.GitHubError("GitHub answered 403.", 403)
        self.write_error_on = "mock-user/one"
        claimed = self.pass_()
        self.assertEqual(
            [(project_id, task["number"]) for project_id, task in claimed],
            [("p2", 266)],
            "the other project's task is still claimed",
        )
        self.assertEqual(self.shown("p1")["refusal"], "GitHub answered 403.")
        self.assertEqual(self.shown("p1")["holds_held"], 1)


class AfkSessionTests(ClaimStubTests):
    """AFK holding a claimed task in a published session, and giving that claim back.

    The session is made and published the way ``afk.start`` leaves it, and the user's own mark then
    arrives through the chat list.
    """

    SESSION = "memento-afk-s1"

    def setUp(self) -> None:
        super().setUp()
        self.on()
        self.issues = [issue_row(265), issue_row(266, created="2026-10-02T00:00:00Z")]
        self.sweep()
        self.task = self.shown()["task"]
        repos = [
            {
                "name": "mock-user/memento",
                "repo_root": str(self.checkout),
                "path": "/trees/afk-265",
                "branch": "hermes/afk-265",
            }
        ]
        sessions._upsert(db_path(self.home), self.SESSION, "p1", repos, "auto", "/files/afk-265")
        afk._adopt(self.home, "p1", self.SESSION, self.task)
        afk.publish(self.home, self.SESSION, "p1", self.task)
        self.writes.clear()

    def merged(self, **marks: Any) -> None:
        """The app's own write to the chat list: the session it marks, at a newer change clock."""
        record = chats.read(db_path(self.home))[self.SESSION]
        value = {**record["value"], **marks}
        at = int(time.time() * 1000) + 60_000
        chats.merge(db_path(self.home), {self.SESSION: {"at": at, "value": value}})

    def deleted(self) -> None:
        at = int(time.time() * 1000) + 60_000
        chats.merge(db_path(self.home), {self.SESSION: {"at": at, "deleted": True}})

    def aged(self, seconds: int, task: Optional[Dict[str, Any]] = None) -> None:
        """The hold as a restart finds it: taken a while ago, with nothing running it since."""
        hold_update(self.home, task, claimed_at=int(time.time()) - seconds)

    def released(self) -> List[tuple]:
        return [write for write in self.writes if write[0] == "DELETE"]


class ReleaseTests(AfkSessionTests):
    """Giving a claim back: the session the user closed, and the task returning to the frontier."""

    def test_discarding_the_session_takes_the_mark_and_the_assignment_off(self) -> None:
        self.merged(discardedAt=int(time.time() * 1000))
        self.sweep()
        self.assertEqual(
            self.released(),
            [
                ("DELETE", "/repos/mock-user/memento/issues/265/labels/gots-got-it", None),
                (
                    "DELETE",
                    "/repos/mock-user/memento/issues/265/assignees",
                    {"assignees": ["mock-user"]},
                ),
            ],
            "both marks go: a task with either one is out of the frontier, so the mark alone "
            "would leave it claimed for good",
        )

    def test_the_task_a_closed_session_gave_back_is_not_claimed_again_by_that_pass(self) -> None:
        # The only task ready is the one being given back, so nothing else can take its place.
        self.issues = [issue_row(265)]
        self.merged(discardedAt=int(time.time() * 1000))
        self.sweep()
        self.assertEqual(len(self.released()), 2, "the claim comes off GitHub")
        self.assertEqual(
            [write for write in self.writes if write[0] == "POST"],
            [],
            "the sweep that gave the task back claims nothing, even a place it just freed",
        )
        self.assertIsNone(
            self.shown()["task"],
            "the user closed the session to be rid of it, so it isn't handed out the moment they "
            "walk away",
        )
        self.sweep()
        self.assertEqual(
            self.shown()["task"]["number"],
            265,
            "the task is back in the frontier, so the next sweep takes the oldest one ready",
        )

    def test_a_place_a_closed_session_freed_is_filled_by_the_task_behind_it(self) -> None:
        self.merged(discardedAt=int(time.time() * 1000))
        self.sweep()
        self.assertEqual(
            [hold.task["number"] for hold in afk._holds(self.home, "p1")],
            [266],
            "265 is given back and not taken again; the place it freed goes to the one behind it",
        )
        self.assertEqual(
            [write[1] for write in self.writes if write[0] == "POST"],
            [
                "/repos/mock-user/memento/issues/266/labels",
                "/repos/mock-user/memento/issues/266/assignees",
            ],
            "and only the task that filled it is claimed on GitHub",
        )

    def test_a_hold_from_before_the_session_column_is_given_back(self) -> None:
        """A hold no session is named for: a task claimed, and no start ever said what works it."""
        hold_update(self.home, session_id=None)
        self.aged(afk.STALL_SECONDS + 1)
        self.sweep()
        self.assertEqual(len(self.released()), 2, "nothing can be working a task no session names")
        self.assertEqual(
            [write[1] for write in self.released()],
            [
                "/repos/mock-user/memento/issues/265/labels/gots-got-it",
                "/repos/mock-user/memento/issues/265/assignees",
            ],
            "the task it named is the one given back, so it is in the frontier and not stuck forever",
        )

    def test_a_task_a_person_also_holds_is_left_to_them(self) -> None:
        self.issues = [issue_row(265, assignees=("someone-else",))]
        self.merged(discardedAt=int(time.time() * 1000))
        self.sweep()
        self.assertEqual(
            self.released()[1][2],
            {"assignees": ["mock-user"]},
            "only the host's own assignment goes: an issue a person holds stays theirs",
        )
        self.sweep()
        self.assertIsNone(
            self.shown()["task"],
            "and the person still holding it keeps the task out of the frontier, so AFK leaves it",
        )

    def test_a_resolved_session_gives_its_task_back_too(self) -> None:
        self.merged(resolvedAt=int(time.time() * 1000))
        self.sweep()
        self.assertEqual(len(self.released()), 2, "the user is done with the session's work")

    def test_a_deleted_session_gives_its_task_back_too(self) -> None:
        self.deleted()
        self.sweep()
        self.assertEqual(len(self.released()), 2)

    def test_a_session_nobody_closed_keeps_its_claim(self) -> None:
        self.sweep()
        self.assertEqual(self.writes, [], "nothing is written while its session still holds the task")
        self.assertEqual(self.shown()["task"]["number"], 265)

    def test_closing_the_session_on_its_own_gives_the_task_back(self) -> None:
        """The route the app's Discard calls: the task comes off the session's own record."""
        record = sessions.read(db_path(self.home), self.SESSION)
        self.assertTrue(afk.release_session(self.home, record))
        self.assertEqual(len(self.released()), 2)
        self.assertIsNone(self.shown()["task"], "the project is free for the next task")
        self.assertEqual(afk._holds(self.home, "p1"), [])

    def test_closing_an_older_session_leaves_the_task_the_project_holds_now(self) -> None:
        """A session closed after its run finished names a task the row has already let go of."""
        record = sessions.read(db_path(self.home), self.SESSION)
        afk._free(self.home, "p1", self.task)
        later = {**self.task, "number": 266, "title": "Task 266"}
        afk._hold(self.home, "p1", later)
        afk._adopt(self.home, "p1", "memento-afk-s2", later)
        self.writes.clear()

        self.assertTrue(afk.release_session(self.home, record))
        self.assertEqual(
            afk._row(self.home, "p1")["task"], later, "the hold the project has now is not that one"
        )
        self.assertEqual(held_task(self.home).session_id, "memento-afk-s2")
        self.assertEqual(
            [write[1] for write in self.released()],
            [
                "/repos/mock-user/memento/issues/265/labels/gots-got-it",
                "/repos/mock-user/memento/issues/265/assignees",
            ],
            "only the closed session's own task comes off GitHub",
        )

    def test_a_session_started_by_hand_releases_nothing(self) -> None:
        self.assertFalse(
            afk.release_session(self.home, {"session_id": "memento-abc", "project_id": "p1"}),
            "a session with no task behind it has no claim to give back",
        )
        self.assertEqual(self.writes, [])

    def test_a_refused_release_is_what_the_sheet_says(self) -> None:
        self.merged(discardedAt=int(time.time() * 1000))
        self.issues = []
        self.write_error = github.GitHubError("Resource not accessible by personal access token", 403)
        self.write_error_on = "/labels/"
        self.sweep()
        shown = self.shown()
        self.assertIsNone(shown["task"], "nothing on the host works the task either way")
        self.assertEqual(shown["refusal"], "Resource not accessible by personal access token")

    def test_a_closed_session_is_given_back_with_the_switch_off(self) -> None:
        """The switch decides whether a new task is taken, not whether a held one goes back."""
        self.merged(discardedAt=int(time.time() * 1000))
        set_on(self.home, "p1", self.folders(), False)
        project = SimpleNamespace(folders=self.folders(), archived=False)
        with patch.object(sessions, "projects", return_value={"p1": project}):
            sweep_all(self.home)
        self.assertEqual(len(self.released()), 2, "the hold is settled whatever the switch says")
        self.assertIsNone(self.shown()["task"])
        self.assertIsNone(self.shown()["reason"], "and nothing new is claimed for it")


class RunEndTests(AfkSessionTests):
    """What a run's end does to the task: a finished one lets go, a stopped one is left alone."""

    def ended(self, session_id: Optional[str] = None, **kwargs: Any) -> None:
        with patch("plugin.sessions._paths", return_value=(db_path(self.home), self.home)):
            afk.after_run(session_id=session_id or self.SESSION, **kwargs)

    def test_a_finished_run_hands_the_project_the_next_task(self) -> None:
        with patch.object(afk, "wake") as wake:
            self.ended(completed=True)
        self.assertIsNone(self.shown()["task"], "the hold is what one task at a time is, so it goes")
        self.assertEqual(self.writes, [], "its claim stays: the task is in review on GitHub")
        wake.assert_called_once()

    def test_a_run_that_reported_failure_alongside_completion_is_a_failure(self) -> None:
        """Hermes can carry more than one flag, and a failure outranks the turn having finished."""
        self.ended(completed=True, failed=True)
        self.assertEqual(self.shown()["task"]["number"], 265, "the claim and the hold both stay")
        self.assertEqual(afk.stalled(self.home)[self.SESSION]["reason"], afk.FAILED_RUN)

    def test_a_failed_run_keeps_the_claim_and_the_session(self) -> None:
        self.ended(completed=False, failed=True)
        self.assertEqual(self.shown()["task"], self.task, "the claim is held for the user to look at")
        self.assertEqual(self.writes, [], "and nothing is written to GitHub")
        self.assertEqual(
            sessions.read(db_path(self.home), self.SESSION)["task"],
            self.task,
            "the session and its record are left alone",
        )
        self.assertIn(self.SESSION, chats.read(db_path(self.home)))

    def test_a_failed_run_says_why_nothing_is_working_it(self) -> None:
        self.ended(completed=False, failed=True)
        shown = afk.stalled(self.home)
        self.assertEqual(shown[self.SESSION]["kind"], "stalled")
        self.assertEqual(shown[self.SESSION]["reason"], afk.FAILED_RUN)

    def test_an_interrupted_run_says_so(self) -> None:
        self.ended(completed=False, interrupted=True)
        self.assertEqual(afk.stalled(self.home)[self.SESSION]["reason"], afk.INTERRUPTED_RUN)

    def test_a_run_that_stopped_without_failing_is_not_called_a_failure(self) -> None:
        """A turn that ends without finishing — a limit reached, an empty answer — is not an error."""
        self.ended(completed=False)
        self.assertEqual(self.shown()["task"], self.task, "the claim is still AFK's")
        self.assertEqual(afk.stalled(self.home)[self.SESSION]["reason"], afk.DEFAULT_STALL)

    def test_a_run_of_a_session_afk_does_not_hold_leaves_the_hold_alone(self) -> None:
        repos = [
            {
                "name": "mock-user/memento",
                "repo_root": str(self.checkout),
                "path": "/trees/hand-made",
                "branch": "hermes/hand-made",
            }
        ]
        sessions._upsert(db_path(self.home), "memento-hand-made", "p1", repos, "auto", None)
        with patch.object(afk, "wake") as wake:
            self.ended(session_id="memento-hand-made", completed=True)
        self.assertEqual(self.shown()["task"], self.task)
        wake.assert_called_once()


class StallTests(AfkSessionTests):
    """A claim nothing is working, where waiting sessions appear."""

    def test_a_session_adopted_after_a_restart_is_reported_with_its_reason(self) -> None:
        self.aged(afk.STALL_SECONDS + 1)
        shown = afk.stalled(self.home)
        self.assertEqual(shown[self.SESSION]["kind"], "stalled")
        self.assertEqual(shown[self.SESSION]["reason"], afk.DEFAULT_STALL)

    def test_a_restart_takes_no_second_session_and_no_second_claim(self) -> None:
        self.aged(afk.STALL_SECONDS + 1)
        self.sweep()
        self.assertEqual(self.writes, [], "the claim stands: nothing is claimed twice")
        self.assertEqual(self.shown()["task"]["number"], 265, "and the task stays AFK's")
        self.assertEqual(held_task(self.home).session_id, self.SESSION, "the same session")

    def test_a_run_in_flight_is_what_working_it_looks_like(self) -> None:
        self.aged(afk.STALL_SECONDS + 1)
        self.assertEqual(afk.stalled(self.home, {self.SESSION: "running"}), {})

    def test_a_claim_just_taken_is_given_its_start(self) -> None:
        self.aged(1)
        self.assertEqual(
            afk.stalled(self.home),
            {},
            "a session's worktrees come first, so a fresh claim hasn't stalled",
        )

    def test_a_run_that_ended_is_reported_at_once(self) -> None:
        self.aged(1)
        with patch("plugin.sessions._paths", return_value=(db_path(self.home), self.home)):
            afk.after_run(session_id=self.SESSION, completed=False, failed=True)
        self.assertIn(self.SESSION, afk.stalled(self.home), "its own reason stands in for the wait")

    def test_a_project_holding_nothing_stalls_nothing(self) -> None:
        afk._free(self.home, "p1")
        self.assertEqual(afk.stalled(self.home), {})


class SessionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.home.joinpath("projects.db").write_text("")
        (self.home / "checkout" / ".git").mkdir(parents=True)
        self.task = {
            "repo": "mock-user/memento",
            "number": 265,
            "title": "The frontier is read from GitHub and listed",
            "url": "https://github.com/mock-user/memento/issues/265",
            "created_at": "2026-10-01T00:00:00Z",
            "body": "Read the frontier first.\n\n- oldest first",
        }
        self.ensured: List[tuple] = []
        self.posted: List[dict] = []
        self.writes: List[tuple] = []
        self.record = {
            "session_id": "",
            "project_id": "p1",
            "mode": "auto",
            "path": "/trees/quiet-marmot",
            "branch": "hermes/quiet-marmot",
            "repo_root": "/checkout",
            "files_dir": "/checkout/files/quiet-marmot",
            "plan_pending": False,
            "repos": [
                {
                    "name": "mock-user/memento",
                    "repo_root": "/checkout",
                    "path": "/trees/quiet-marmot",
                    "branch": "hermes/quiet-marmot",
                }
            ],
        }
        for one in (
            patch.object(github, "token", return_value=("token", "env")),
            patch.object(github, "origin_repo", return_value="mock-user/memento"),
            patch.object(github, "login", return_value="gots-bot"),
            patch.object(github, "_request", self.request),
            patch("plugin.sessions.ensure", side_effect=self.ensure),
            patch("plugin.sessions.apply_cwd"),
            patch("plugin.outbox.post", side_effect=self.post),
        ):
            one.start()
            self.addCleanup(one.stop)
        set_on(self.home, "p1", [folder(str(self.home / "checkout"))], True)
        afk._hold(self.home, "p1", self.task)

    def request(self, path: str, auth: Any, method: str = "GET", data: Any = None) -> Any:
        self.writes.append((method, path, data))
        return {}

    def ensure(self, path: Any, home: Any, session_id: str, project_id: Any, task: Any, mode: Any) -> dict:
        self.ensured.append((session_id, project_id, task, mode))
        sessions._upsert(
            path, session_id, str(project_id), self.record["repos"], mode, self.record["files_dir"]
        )
        return {**self.record, "session_id": session_id, "project_id": project_id, "mode": mode}

    async def post(self, adapter: Any, profile: Any, path: str, body: dict, **kwargs: Any) -> dict:
        self.posted.append({"profile": profile, "path": path, "body": body, **kwargs})
        return {"run_id": "run-1"}

    def adapter(self) -> SimpleNamespace:
        return SimpleNamespace(_host="127.0.0.1", _port=8642, _api_key="host-key")

    def start(self) -> None:
        asyncio.run(afk.start(self.adapter(), self.home, "p1", self.task))

    def chats(self) -> Dict[str, Any]:
        return chats.read(db_path(self.home))

    def test_the_session_is_made_with_a_worktree_of_its_own_in_auto(self) -> None:
        self.start()
        self.assertEqual(len(self.ensured), 1)
        session_id, project_id, task, mode = self.ensured[0]
        self.assertEqual(project_id, "p1")
        self.assertEqual(task, self.task["title"], "the worktree is named after the task")
        self.assertEqual(mode, "auto", "an AFK session runs in Auto")
        self.assertTrue(session_id.startswith("memento-"), "a session id Gots's own hooks label")

    def test_the_chat_record_it_publishes_is_what_makes_the_session_appear(self) -> None:
        self.start()
        records = self.chats()
        self.assertEqual(len(records), 1)
        entry = next(iter(records.values()))
        value = entry["value"]
        self.assertEqual(value["title"], "#265 The frontier is read from GitHub and listed")
        self.assertEqual(value["hermesSessionId"], self.ensured[0][0])
        self.assertEqual(value["projectId"], "p1")
        self.assertEqual(value["mode"], "auto")
        self.assertIs(value["afk"], True, "the list marks it as AFK's")
        self.assertIs(
            value["titleEdited"], True, "Hermes's title, sliced off the opener, never replaces it"
        )
        self.assertGreater(
            value["updatedAt"],
            value["createdAt"],
            "a record whose updated time isn't newer is hidden by the Code list",
        )
        self.assertGreaterEqual(entry["at"], value["updatedAt"], "the change clock is the record's")

    def test_the_session_names_the_task_it_works(self) -> None:
        self.start()
        session_id = self.ensured[0][0]
        record = sessions.read(db_path(self.home), session_id)
        self.assertEqual(
            record["task"],
            {key: self.task[key] for key in afk.HELD},
            "the session keeps the task, for the pull request that closes it",
        )
        self.assertNotIn(
            "body", record["task"], "the issue's text is the run's, and no row of the host's keeps it"
        )
        self.assertIsNone(sessions.read(db_path(self.home), "memento-afk-not-this-one"))

    def test_a_run_that_never_started_names_no_task(self) -> None:
        outbox.post.side_effect = outbox.StartError("No API key for this bot.", True)
        self.start()
        self.assertIsNone(
            sessions.read(db_path(self.home), self.ensured[0][0])["task"],
            "a session nothing was sent in names no task",
        )

    def test_the_run_opens_with_the_issue_it_works(self) -> None:
        self.start()
        self.assertEqual(len(self.posted), 1)
        body = self.posted[0]["body"]
        message = body["input"][0]
        self.assertEqual(message["role"], "user")
        self.assertEqual(
            message["content"],
            "Title: The frontier is read from GitHub and listed\n"
            "Description:\n"
            "Read the frontier first.\n"
            "\n"
            "- oldest first\n"
            "\n"
            "[Issue #265](https://github.com/mock-user/memento/issues/265)",
            "the input is the issue itself, its body verbatim and its link",
        )

    def test_the_instructions_are_the_afk_prompt_and_carry_no_task_text(self) -> None:
        self.start()
        instructions = self.posted[0]["body"]["instructions"]
        record = {
            **self.record,
            "session_id": self.ensured[0][0],
            "project_id": "p1",
            "mode": "auto",
            "pipeline": sessions.read(db_path(self.home), self.ensured[0][0])["pipeline"],
        }
        self.assertEqual(
            instructions,
            prompt_builder.afk_prompt(record, self.task),
            "one module owns every word the agent is told",
        )
        self.assertIn("Never ask the user anything", instructions)
        self.assertIn("its text is the spec", instructions, "the fixed points are AFK's own")
        self.assertIn("gh issue view", instructions, "it fetches the issue itself")
        self.assertIn(
            "You are working in a git worktree of mock-user/memento",
            instructions,
            "the session's own prompt is kept, so its worktree and pull request lines still hold",
        )
        self.assertNotIn("Read the frontier first.", instructions, "the issue's text isn't copied in")

    def test_the_run_is_told_the_prompt_the_host_holds(self) -> None:
        set_prompt(self.home, "p1", "Squash every checkpoint into one commit.")
        self.start()
        self.assertIn(
            "Squash every checkpoint into one commit.",
            self.posted[0]["body"]["instructions"],
            "the Prompt comes off the project's row as the run starts, with the app closed",
        )

    def test_the_run_is_the_sessions_own_and_starts_on_the_hosts_answer(self) -> None:
        self.start()
        posted = self.posted[0]
        self.assertEqual(posted["path"], "/v1/runs")
        self.assertEqual(posted["body"]["session_id"], self.ensured[0][0])
        self.assertNotIn("model", posted["body"], "no model picked: the host's own runs")

    def test_a_key_in_the_homes_own_env_is_the_one_the_run_is_posted_with(self) -> None:
        self.home.joinpath(".env").write_text("API_SERVER_KEY=home-key\n")
        self.start()
        self.assertEqual(self.posted[0]["authorization"], "Bearer home-key")

    def test_a_home_with_no_key_leaves_its_resolution_to_outbox(self) -> None:
        self.start()
        self.assertIsNone(
            self.posted[0]["authorization"],
            "outbox knows the profile's key: a home's own .env is all this adds",
        )

    def test_a_run_that_cannot_start_publishes_nothing(self) -> None:
        outbox.post.side_effect = outbox.StartError("No API key for this bot.", True)
        self.start()
        self.assertEqual(len(self.ensured), 1, "the session was made")
        self.assertEqual(
            self.chats(), {}, "a record the app would open with no run behind it is worse than none"
        )

    def test_a_run_that_cannot_start_gives_the_claim_back(self) -> None:
        outbox.post.side_effect = outbox.StartError("No API key for this bot.", True)
        self.start()
        self.assertEqual(
            self.writes,
            [
                ("DELETE", "/repos/mock-user/memento/issues/265/labels/gots-got-it", None),
                (
                    "DELETE",
                    "/repos/mock-user/memento/issues/265/assignees",
                    {"assignees": ["gots-bot"]},
                ),
            ],
            "nothing began the work, so the task returns to the frontier rather than sitting claimed",
        )
        self.assertIsNone(read(self.home, "p1", [folder(str(self.home / "checkout"))])["task"])

    def test_a_session_that_cannot_be_made_starts_no_run(self) -> None:
        with patch("plugin.sessions.ensure", side_effect=sessions.WorkspaceError("No such project.")):
            self.start()
        self.assertEqual(self.posted, [], "nothing is started for a session that doesn't exist")
        self.assertEqual(self.chats(), {}, "and nothing is published to be opened")
        self.assertEqual(len(self.writes), 2, "and the claim goes back, with no session to show it")

    def test_the_session_working_the_task_is_named_on_the_hold(self) -> None:
        self.start()
        self.assertEqual(
            held_task(self.home).session_id,
            self.ensured[0][0],
            "a restart adopts this session, and the app is told what it is",
        )

    def test_the_sweep_answers_the_task_it_just_claimed(self) -> None:
        with TemporaryDirectory() as tmp:
            home = Path(tmp)
            checkout = home / "checkout"
            (checkout / ".git").mkdir(parents=True)
            home.joinpath("projects.db").write_text("")
            rows = [issue_row(265)]
            with (
                patch.object(github, "token", return_value=("token", "env")),
                patch.object(github, "origin_repo", return_value="mock-user/memento"),
                patch.object(github, "_get", lambda path, auth: {"login": "mock-user"}),
                patch.object(github, "_page", lambda path, auth: (rows, "")),
                patch.object(github, "_request", lambda *args, **kwargs: {}),
            ):
                set_on(home, "p1", [folder(str(checkout))], True)
                claimed = sweep(home, "p1", [folder(str(checkout))], skills=None)
                self.assertEqual([task["number"] for task in claimed], [265])
                self.assertEqual(
                    sweep(home, "p1", [folder(str(checkout))], skills=None),
                    [],
                    "a project holding one is asked for nothing further",
                )


class StagedStartTests(SessionTests):
    """A claimed task's session says which stage it starts in, written before its run is posted."""

    def choose(self, name: str = "Mine", build: Optional[str] = None, steps=()) -> Dict[str, Any]:
        """A workflow of this bot's own, and the project naming it."""
        entry = workflows.create(
            self.home, {"name": name, "stages": workflows.from_skills(build, steps)}
        )
        set_workflow(self.home, "p1", entry["id"])
        return entry

    def test_a_project_with_a_workflow_starts_a_staged_build(self) -> None:
        self.choose(build="plan", steps=["code-review"])
        self.start()
        record = sessions.read(db_path(self.home), self.ensured[0][0])
        staged = pipeline.read(record["pipeline"])
        self.assertEqual(
            pipeline.kind(staged), pipeline.BUILD, "the stage is recorded before the run"
        )
        self.assertEqual(pipeline.steps_of(staged), ["plan", "code-review"])
        text = self.posted[0]["body"]["instructions"]
        self.assertIn("Build stage", text, "and the build is told where it ends")
        self.assertIn('skill_view(name="plan")', text, "and which skill governs it")

    def test_a_project_that_picked_nothing_works_one_prompt_run(self) -> None:
        self.start()
        self.assertEqual(len(self.posted), 1, "one prompt run is the task's whole work")
        record = sessions.read(db_path(self.home), self.ensured[0][0])
        self.assertIsNone(
            record["pipeline"], "a prompt run is no stage, so nothing is snapshotted"
        )
        text = self.posted[0]["body"]["instructions"]
        self.assertIn("the pull request ships last", text, "the brief is AFK's, whatever a prompt says")
        self.assertIn(
            prompt_builder.DEFAULT_PROMPT, text, "the method is the Prompt the project works by"
        )
        self.assertNotIn("This task is worked in stages", text, "there is no stage to be told")
        self.assertIn(
            "ship it yourself with the pull_request tool",
            text,
            "the one run ships the draft itself",
        )

    def test_a_pick_the_library_lost_works_one_prompt_run(self) -> None:
        self.choose()
        lose_pick(self.home)
        self.start()
        record = sessions.read(db_path(self.home), self.ensured[0][0])
        self.assertIsNone(record["pipeline"], "no workflow, so nothing is snapshotted")
        self.assertIn(
            prompt_builder.DEFAULT_PROMPT,
            self.posted[0]["body"]["instructions"],
            "and the run is told its Prompt instead",
        )


class SweepAllTests(unittest.TestCase):
    """Which projects the background sweep looks at, and what it answers the loop with."""

    def setUp(self) -> None:
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.home.joinpath("projects.db").write_text("")
        self.checkout = self.home / "checkout"
        (self.checkout / ".git").mkdir(parents=True)
        for one in (
            patch.object(github, "token", return_value=("token", "env")),
            patch.object(github, "origin_repo", return_value="mock-user/memento"),
        ):
            one.start()
            self.addCleanup(one.stop)

    def project(self, project_id: str, archived: bool = False) -> SimpleNamespace:
        return SimpleNamespace(id=project_id, folders=[folder(str(self.checkout))], archived=archived)

    def read_nothing(self, home: Path, project_id: str, *args: Any, **kwargs: Any) -> afk.Plan:
        """A project read into a plan that claims nothing: what the pass's own reading answers."""
        return afk.Plan(project_id, [])

    def test_a_project_left_on_is_swept_and_one_that_is_off_is_not(self) -> None:
        set_on(self.home, "p1", [folder(str(self.checkout))], True)
        with stub_projects_db(projects=[self.project("p1"), self.project("p2")]):
            with patch.object(afk, "_plan", side_effect=self.read_nothing) as plan:
                sweep_all(self.home)
        self.assertEqual([call.args[1] for call in plan.call_args_list], ["p1"])

    def test_a_project_whose_record_is_gone_is_left_alone(self) -> None:
        set_on(self.home, "p1", [folder(str(self.checkout))], True)
        with stub_projects_db(projects=[]):
            with patch.object(afk, "_plan", side_effect=self.read_nothing) as plan:
                sweep_all(self.home)
        plan.assert_not_called()

    def test_a_failing_project_does_not_stop_the_next_one(self) -> None:
        set_on(self.home, "p1", [folder(str(self.checkout))], True)
        set_on(self.home, "p2", [folder(str(self.checkout))], True)

        def read(home: Path, project_id: str, *args: Any, **kwargs: Any) -> afk.Plan:
            if project_id == "p1":
                raise RuntimeError("database is locked")
            return afk.Plan(project_id, [])

        with stub_projects_db(projects=[self.project("p1"), self.project("p2")]):
            with patch.object(afk, "_plan", side_effect=read) as call:
                sweep_all(self.home)
        self.assertEqual([one.args[1] for one in call.call_args_list], ["p1", "p2"])

    def test_a_sweep_answers_the_tasks_it_just_claimed(self) -> None:
        """The pass's answer is what the loop starts sessions for, in the order it took them."""
        set_on(self.home, "p1", [folder(str(self.checkout))], True)
        task = {"repo": "mock-user/memento", "number": 265, "title": "Task 265"}
        second = {"repo": "mock-user/memento", "number": 266, "title": "Task 266"}
        with stub_projects_db(projects=[self.project("p1"), self.project("p2")]):
            with (
                patch.object(afk, "_plan", return_value=afk.Plan("p1", [task, second])),
                patch.object(github, "login", return_value="mock-user"),
                patch.object(github, "claim_issue"),
            ):
                claimed = sweep_all(self.home)
        self.assertEqual(
            claimed,
            [("p1", task), ("p1", second)],
            "every task a project claimed is answered, in the order the pass took them",
        )


class LoopTests(unittest.TestCase):

    def setUp(self) -> None:
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.task = {"repo": "mock-user/memento", "number": 265, "title": "Task 265"}
        self.starts: List[tuple] = []
        self.patch = patch("plugin.link.served_homes", return_value=[self.home])
        self.patch.start()
        self.addCleanup(self.patch.stop)

    async def start(self, adapter: Any, home: Path, project_id: str, task: dict, **kwargs: Any) -> None:
        self.starts.append((home, project_id, task, adapter))

    def test_the_task_a_sweep_claimed_is_worked_in_a_session(self) -> None:
        adapter = SimpleNamespace()
        with (
            patch.object(afk, "sweep_all", return_value=[("p1", self.task)]),
            patch.object(afk, "start", side_effect=self.start),
        ):
            asyncio.run(afk.sweep_homes(adapter))
        self.assertEqual(self.starts, [(self.home, "p1", self.task, adapter)])

    def test_a_sweep_that_claimed_nothing_starts_nothing(self) -> None:
        with (
            patch.object(afk, "sweep_all", return_value=[]),
            patch.object(afk, "start", side_effect=self.start),
        ):
            asyncio.run(afk.sweep_homes(SimpleNamespace()))
        self.assertEqual(self.starts, [])

    def test_the_tasks_one_pass_claimed_are_started_one_after_another(self) -> None:
        """A start makes a worktree on the project's repository: two at once is a load nobody asked
        for, however many tasks the same pass claimed (ADR 0025)."""
        second = {"repo": "mock-user/memento", "number": 266, "title": "Task 266"}
        running: List[int] = []
        overlaps: List[int] = []

        async def start(adapter: Any, home: Path, project_id: str, task: dict, **kwargs: Any) -> None:
            running.append(task["number"])
            overlaps.append(len(running))
            await asyncio.sleep(0)
            running.remove(task["number"])

        with (
            patch.object(afk, "sweep_all", return_value=[("p1", self.task), ("p1", second)]),
            patch.object(afk, "start", side_effect=start),
        ):
            asyncio.run(afk.sweep_homes(SimpleNamespace()))
        self.assertEqual(overlaps, [1, 1], "the second start waits for the first to finish")

    def test_one_projects_failure_to_start_does_not_stop_anothers(self) -> None:
        second = {"repo": "mock-user/memento", "number": 266, "title": "Task 266"}
        with (
            patch.object(afk, "sweep_all", return_value=[("p1", self.task), ("p2", second)]),
            patch.object(afk, "start", side_effect=[RuntimeError("no worktree"), None]),
        ):
            asyncio.run(afk.sweep_homes(SimpleNamespace()))


class WakeTests(unittest.TestCase):
    """What asks the sweep to look again before its next tick."""

    def test_a_project_session_ending_wakes_the_sweep(self) -> None:
        with patch.object(afk, "wake") as wake:
            with patch("plugin.sessions._paths", return_value=(Path("/x"), Path("/y"))):
                with patch("plugin.sessions.record_for", return_value={"session_id": "s"}):
                    afk.after_run(session_id="s")
        wake.assert_called_once()

    def test_a_chat_ending_wakes_nothing(self) -> None:
        with patch.object(afk, "wake") as wake:
            with patch("plugin.sessions._paths", return_value=(Path("/x"), Path("/y"))):
                with patch("plugin.sessions.record_for", return_value=None):
                    afk.after_run(session_id="chat")
        wake.assert_not_called()

    def test_a_failure_never_reaches_the_host(self) -> None:
        with patch.object(afk, "wake"):
            with patch("plugin.sessions._paths", side_effect=RuntimeError("no home")):
                afk.after_run(session_id="s")

    def test_waking_a_sweep_that_is_not_running_is_harmless(self) -> None:
        afk.wake()


class StagedRunTests(AfkSessionTests):
    """A staged task's run end: the gate's verdict, the stage it starts, and where it stalls."""

    CLEAN = [{"name": "mock-user/memento", "changed": 0, "ahead": 2}]

    def stage(self, kind: str = pipeline.BUILD, critique=("code-review",)) -> dict:
        record = staged_record(kind, steps=tuple(critique))
        sessions.set_pipeline(db_path(self.home), self.SESSION, record)
        return record

    def gated(self, *codes: int) -> dict:
        record = self.stage()
        staged = pipeline.gated(
            record,
            [{"command": f"step-{i}", "code": code} for i, code in enumerate(codes)],
        )
        sessions.set_pipeline(db_path(self.home), self.SESSION, staged)
        return staged

    def pipeline(self) -> Optional[dict]:
        return pipeline.read(sessions.read(db_path(self.home), self.SESSION)["pipeline"])

    SHIPPED = {"number": 265}

    def ended(self, tree: Any = None, shipped: Any = SHIPPED, **kwargs: Any) -> Any:
        """The run's end, with the worktree the host measured and GitHub's pull request answer."""
        answer = (
            patch("plugin.github.pull_request", side_effect=shipped)
            if isinstance(shipped, Exception)
            else patch("plugin.github.pull_request", return_value=shipped)
        )
        with patch.object(afk.ship, "status", return_value=self.CLEAN if tree is None else tree):
            with patch.object(afk, "_start_stage") as started:
                with answer:
                    with patch("plugin.sessions._paths", return_value=(db_path(self.home), self.home)):
                        afk.after_run(session_id=self.SESSION, **kwargs)
        return started

    def test_one_run_gates_itself_and_is_let_go_when_it_has_shipped(self) -> None:
        """One run's only stage is judged at its own end: it ships, and there is no stage after it."""
        record = pipeline.start(preset("preset:one-run"))
        sessions.set_pipeline(
            db_path(self.home), self.SESSION, pipeline.gated(record, [{"command": "true", "code": 0}])
        )
        started = self.ended(completed=True)
        started.assert_not_called()
        self.assertIsNone(self.shown()["task"], "the workflow is over, so the hold goes")
        self.assertEqual(pipeline.kind(self.pipeline()), pipeline.DONE)

    def test_a_build_that_passed_its_gate_starts_its_next_stage_on_the_same_session(self) -> None:
        self.gated(0, 0)
        started = self.ended(completed=True)
        started.assert_called_once()
        home, record = started.call_args[0]
        self.assertEqual(home, self.home)
        self.assertEqual(record["session_id"], self.SESSION, "the same session, not another")
        self.assertEqual(pipeline.kind(record["pipeline"]), pipeline.CRITIQUE)
        self.assertEqual(pipeline.kind(self.pipeline()), pipeline.CRITIQUE)
        self.assertEqual(self.shown()["task"], self.task, "the claim stays: the task isn't finished")
        self.assertEqual(self.writes, [], "nothing is written to GitHub between the stages")

    def test_a_gate_command_that_failed_stalls_the_task_with_the_command_named(self) -> None:
        self.gated(0, 2)
        started = self.ended(completed=True)
        started.assert_not_called()
        self.assertEqual(
            afk.stalled(self.home)[self.SESSION]["reason"],
            "The gate failed: step-1 exited 2.",
            "the user is told what to run themselves",
        )
        self.assertEqual(self.shown()["task"], self.task, "the claim is kept for the user to look at")
        self.assertEqual(pipeline.kind(self.pipeline()), pipeline.GATE, "it is at the gate it failed")

    def test_a_build_that_never_ran_the_gate_stalls(self) -> None:
        self.stage()
        started = self.ended(completed=True)
        started.assert_not_called()
        self.assertEqual(afk.stalled(self.home)[self.SESSION]["reason"], pipeline.NO_GATE)

    def test_a_tree_left_uncommitted_stalls(self) -> None:
        self.gated(0)
        started = self.ended(completed=True, tree=[{"changed": 2, "ahead": 0}])
        started.assert_not_called()
        self.assertEqual(afk.stalled(self.home)[self.SESSION]["reason"], pipeline.UNCOMMITTED)

    def test_a_build_that_left_no_commits_stalls(self) -> None:
        self.gated(0)
        # The session's worktree doesn't exist here, which is what no readable tree looks like too.
        started = self.ended(completed=True, tree=[])
        started.assert_not_called()
        self.assertEqual(afk.stalled(self.home)[self.SESSION]["reason"], pipeline.NO_COMMITS)

    def test_a_review_that_finished_lets_go_of_the_task(self) -> None:
        self.stage(pipeline.CRITIQUE)
        with patch.object(afk, "wake") as wake:
            self.ended(completed=True)
        self.assertIsNone(self.shown()["task"], "the work is in review: the hold is what one task is")
        self.assertEqual(self.writes, [], "its claim stays on GitHub")
        self.assertEqual(pipeline.kind(self.pipeline()), pipeline.DONE, "and the record says how it ended")
        wake.assert_called_once()

    def test_a_workflow_whose_next_stage_is_a_build_starts_that_one(self) -> None:
        record = pipeline.start(
            {
                "id": "wf-two-runs",
                "name": "Build · Test · Polish · Review",
                "stages": [
                    {"name": "Build", "steps": ["plan"]},
                    {"name": "Test", "steps": [], "check": workflows.GATE},
                    {"name": "Polish", "steps": ["code-review"]},
                    {"name": "Review", "steps": [], "ships": True},
                ],
            }
        )
        gated = pipeline.gated(record, [{"command": "true", "code": 0}])
        sessions.set_pipeline(db_path(self.home), self.SESSION, gated)
        started = self.ended(completed=True)
        started.assert_called_once()
        moved = started.call_args[0][1]["pipeline"]
        self.assertEqual(pipeline.stage_name(moved), "Polish", "the workflow's own next stage")
        self.assertEqual(self.shown()["task"], self.task, "the claim stays with it")

    def test_a_review_that_ended_without_a_pull_request_stalls(self) -> None:
        self.stage(pipeline.CRITIQUE)
        with patch.object(afk, "wake"):
            self.ended(completed=True, shipped=None)
        self.assertEqual(
            afk.stalled(self.home)[self.SESSION]["reason"],
            afk.NO_PULL_REQUEST,
            "a review that never opened one reviewed nothing the user can see",
        )
        self.assertEqual(self.shown()["task"], self.task, "so its claim is kept with it")
        self.assertEqual(pipeline.reason(self.pipeline()), afk.NO_PULL_REQUEST)

    def test_a_github_that_cannot_be_asked_does_not_stall_a_finished_review(self) -> None:
        self.stage(pipeline.CRITIQUE)
        with patch.object(afk, "wake"):
            self.ended(completed=True, shipped=github.GitHubError("offline"))
        self.assertIsNone(self.shown()["task"], "the run finished: nothing is stalled over a lookup")

    def test_a_build_that_failed_keeps_its_stage_and_its_claim(self) -> None:
        self.stage()
        started = self.ended(completed=False, failed=True)
        started.assert_not_called()
        self.assertEqual(pipeline.kind(self.pipeline()), pipeline.BUILD, "it stopped where it was building")
        self.assertEqual(afk.stalled(self.home)[self.SESSION]["reason"], afk.FAILED_RUN)
        self.assertEqual(self.shown()["task"], self.task)

    def test_a_review_that_failed_stalls_with_its_stage_kept(self) -> None:
        self.stage(pipeline.CRITIQUE)
        self.ended(completed=False, interrupted=True)
        self.assertEqual(pipeline.kind(self.pipeline()), pipeline.CRITIQUE)
        self.assertEqual(afk.stalled(self.home)[self.SESSION]["reason"], afk.INTERRUPTED_RUN)

    def test_a_prompt_run_is_the_whole_task_and_lets_go_of_it(self) -> None:
        sessions.set_pipeline(db_path(self.home), self.SESSION, None)
        started = self.ended(completed=True)
        started.assert_not_called()
        self.assertIsNone(self.shown()["task"], "one finished run is still the whole task")
        self.assertIsNone(self.pipeline())

    def test_a_held_task_keeps_the_snapshot_it_started_under(self) -> None:
        """A project that picks nothing works one run from now on, but the task it already holds
        keeps the stages it started under: the snapshot is on its own session's record."""
        self.assertEqual(
            self.shown()["workflow"]["id"],
            workflows.DEFAULT_ID,
            "the project reads as one run",
        )
        self.gated(0, 0)
        started = self.ended(completed=True)
        started.assert_called_once()
        moved = started.call_args[0][1]["pipeline"]
        self.assertEqual(pipeline.kind(moved), pipeline.CRITIQUE, "its next stage still runs")
        self.assertEqual(len(pipeline.read(moved)["stages"]), 3, "the stages it started under")

    def test_the_sheet_names_the_stage_the_task_is_in(self) -> None:
        self.stage()
        self.assertEqual(self.shown()["stage"], pipeline.BUILD)
        self.stage(pipeline.GATE_CHECK)
        self.assertEqual(self.shown()["stage"], pipeline.GATE_CHECK, "the gate stage is its own stage")

    def test_the_sheet_names_no_stage_for_a_project_holding_nothing(self) -> None:
        afk._free(self.home, "p1")
        self.assertIsNone(self.shown()["stage"])

    def test_the_stage_outlives_the_hold_on_the_session(self) -> None:
        self.stage(pipeline.DONE)
        afk._free(self.home, "p1")
        self.assertEqual(
            pipeline.kind(self.pipeline()),
            pipeline.DONE,
            "a finished task still says how it got there",
        )


class StagedFlowTests(AfkSessionTests):
    """A task run through its workflow, one run's end at a time.

    The runs are a fake API — each stage's request is kept and answered — and GitHub and the worktree
    are fakes too, so what happens between the runs is the host's own record and nothing else.
    """

    CLEAN = [{"name": "mock-user/memento", "changed": 0, "ahead": 2}]
    LOOP = preset("preset:loop")
    BROKEN = [{"command": "pnpm test", "code": 1}]
    PASSING = [{"command": "pnpm test", "code": 0}]
    SHIPPED = {"number": 265}

    def setUp(self) -> None:
        super().setUp()
        self.posted: List[dict] = []

    def start(self, workflow: Optional[dict] = None) -> dict:
        record = pipeline.start(workflow or self.LOOP)
        sessions.set_pipeline(db_path(self.home), self.SESSION, record)
        return record

    def gated(self, commands: List[dict]) -> dict:
        """The stage's own run answering its gate, as the tool records it."""
        record = pipeline.read(sessions.read(db_path(self.home), self.SESSION)["pipeline"])
        staged = pipeline.gated(record, commands)
        sessions.set_pipeline(db_path(self.home), self.SESSION, staged)
        return staged

    def ended(self, completed: bool = True, shipped: Any = SHIPPED) -> None:
        """The run of the stage the task is in ending, and whatever it starts posted by the fake API."""

        async def post(adapter: Any, profile: Any, path: str, body: dict, **kwargs: Any) -> dict:
            self.posted.append(body)
            return {"run_id": f"run-{len(self.posted)}"}

        def schedule(coroutine: Any, loop: Any) -> None:
            asyncio.run(coroutine)

        with (
            patch.object(afk.ship, "status", return_value=self.CLEAN),
            patch("plugin.outbox.post", side_effect=post),
            patch.object(afk.asyncio, "run_coroutine_threadsafe", side_effect=schedule),
            patch.object(afk, "_loop", object()),
            patch.object(afk, "base_branch", return_value="main"),
            patch("plugin.github.pull_request", return_value=shipped),
            patch("plugin.sessions._paths", return_value=(db_path(self.home), self.home)),
        ):
            afk.after_run(session_id=self.SESSION, completed=completed)

    def pipeline(self) -> Optional[dict]:
        return pipeline.read(sessions.read(db_path(self.home), self.SESSION)["pipeline"])

    def test_a_failing_gate_repeats_the_build_told_what_failed_then_the_review_ships(self) -> None:
        self.start()
        self.gated(self.BROKEN)
        self.ended()
        self.assertEqual(len(self.posted), 1, "the loop posts its next round, and nothing else")
        self.assertEqual(pipeline.stage_name(self.pipeline()), "Build")
        self.assertEqual(self.pipeline()["round"], 2)
        self.assertIn(
            "pnpm test exited 1",
            self.posted[0]["instructions"],
            "round two is told the command that failed and its exit code",
        )
        self.gated(self.PASSING)
        self.ended()
        self.assertEqual(len(self.posted), 2, "the review is the next stage to run")
        self.assertEqual(pipeline.stage_name(self.pipeline()), "Review")
        self.assertEqual(
            self.posted[1]["input"][0]["content"],
            "Review #265 (https://github.com/mock-user/memento/issues/265)",
        )
        self.assertNotIn("The round before this one failed", self.posted[1]["instructions"])
        self.ended()
        self.assertIsNone(self.shown()["task"], "the task is in review: the hold goes")
        self.assertEqual(pipeline.kind(self.pipeline()), pipeline.DONE)
        self.assertEqual(len(self.posted), 2, "the checkpoint and the empty Summary posted nothing")

    def test_the_flow_ends_in_a_summary_run_when_that_stage_names_a_skill(self) -> None:
        """The chain's tail: the review ships the draft, then the wrap-up runs on the same session."""
        workflow = preset("preset:loop")
        workflow["stages"][3]["steps"] = ["weekly-review"]
        self.start(workflow)
        self.gated(self.PASSING)
        self.ended()
        self.assertEqual(pipeline.stage_name(self.pipeline()), "Review")
        self.ended()
        self.assertEqual(len(self.posted), 2, "the review posted nothing: its stage was already running")
        self.assertEqual(pipeline.stage_name(self.pipeline()), "Summary")
        self.assertEqual(
            self.posted[1]["input"][0]["content"],
            "Summary #265 (https://github.com/mock-user/memento/issues/265)",
        )
        self.assertIn("wrap-up", self.posted[1]["instructions"])
        self.assertIn("weekly-review", self.posted[1]["instructions"], "the stage's own skill is named")
        self.ended()
        self.assertIsNone(self.shown()["task"])
        self.assertEqual(len(self.posted), 2, "nothing runs after the last stage")

    def test_a_checkpoint_posts_no_run_whatever_the_stage_before_it_did(self) -> None:
        self.start()
        self.gated(self.PASSING)
        self.ended()
        self.assertEqual(len(self.posted), 1)
        self.assertEqual(
            pipeline.stage_name(self.pipeline()),
            "Review",
            "the host answered the checkpoint from the build's own gate, and the next stage runs",
        )

    def test_a_loop_past_its_cap_stalls_naming_the_command_and_starts_nothing(self) -> None:
        self.start()
        for _ in range(3):
            self.gated(self.BROKEN)
            self.ended()
        self.assertEqual(len(self.posted), 2, "three rounds ran, two of them posted here")
        self.assertEqual(
            afk.stalled(self.home)[self.SESSION]["reason"],
            "The loop ran out of rounds (3) and the gate still failed: pnpm test exited 1.",
        )
        self.assertEqual(self.shown()["task"], self.task, "the claim is kept, as a failed gate keeps it")
        self.assertEqual(pipeline.kind(self.pipeline()), pipeline.GATE, "nothing after it starts")

    def test_a_summary_with_a_skill_posts_a_run_and_an_empty_one_does_not(self) -> None:
        for steps, expected in ((["weekly-review"], 1), ([], 0)):
            with self.subTest(steps=steps):
                record = placed(preset("preset:staged"), 2)
                record["stages"][3]["steps"] = list(steps)
                sessions.set_pipeline(db_path(self.home), self.SESSION, record)
                self.posted.clear()
                self.ended()
                self.assertEqual(len(self.posted), expected)
                if steps:
                    self.assertEqual(
                        self.posted[0]["input"][0]["content"],
                        "Summary #265 (https://github.com/mock-user/memento/issues/265)",
                    )
                    self.assertIn("wrap-up", self.posted[0]["instructions"])

    def test_a_summary_that_finished_ends_the_task(self) -> None:
        record = placed(preset("preset:staged"), 3)
        record["stages"][3]["steps"] = ["weekly-review"]
        sessions.set_pipeline(db_path(self.home), self.SESSION, record)
        with patch.object(afk, "wake") as wake:
            self.ended()
        self.assertIsNone(self.shown()["task"])
        self.assertEqual(pipeline.kind(self.pipeline()), pipeline.DONE)
        wake.assert_called_once()


class StagedSweepTests(ClaimStubTests):
    """A workflow naming a skill its bot no longer has: a refusal, no claim, the switch on."""

    def choose(self, build: Optional[str] = None, steps=("code-review",)) -> Dict[str, Any]:
        """A workflow naming those skills, and the project working under it."""
        entry = workflows.create(
            self.home, {"name": "Mine", "stages": workflows.from_skills(build, steps)}
        )
        set_workflow(self.home, "p1", entry["id"])
        return entry

    def test_a_missing_review_skill_claims_nothing_and_says_why(self) -> None:
        self.on()
        self.choose(steps=["code-review"])
        self.issues = [issue_row(265)]
        self.assertEqual(
            sweep(self.home, "p1", self.folders(), skills={"log-triage"}),
            [],
            "nothing is claimed for a skill this bot can't run",
        )
        self.assertEqual(self.writes, [], "and nothing is touched on GitHub")
        shown = self.shown()
        self.assertEqual(shown["task"], None)
        self.assertTrue(shown["on"], "the switch stays on, so the user sees what to fix")
        self.assertEqual(shown["refusal"], afk.MISSING_SKILL.format(name="code-review"))

    def test_a_missing_build_skill_is_the_same_refusal(self) -> None:
        self.on()
        self.choose(build="plan", steps=["code-review"])
        self.issues = [issue_row(265)]
        sweep(self.home, "p1", self.folders(), skills={"code-review"})
        self.assertEqual(self.shown()["refusal"], afk.MISSING_SKILL.format(name="plan"))
        self.assertIsNone(self.shown()["task"])

    def test_a_workflow_the_bot_can_run_claims_as_usual(self) -> None:
        self.on()
        self.choose(build="plan", steps=["code-review"])
        self.issues = [issue_row(265)]
        claimed = sweep(self.home, "p1", self.folders(), skills={"plan", "code-review"})
        self.assertEqual([task["number"] for task in claimed], [265])
        self.assertIsNone(self.shown()["refusal"])

    def test_a_workflow_naming_no_skill_claims_as_usual(self) -> None:
        # The default preset names nothing, so no skill of the bot's can be missing from it.
        self.on()
        self.issues = [issue_row(265)]
        claimed = sweep(self.home, "p1", self.folders(), skills={"code-review"})
        self.assertEqual([task["number"] for task in claimed], [265])
        self.assertIsNone(self.shown()["refusal"])

    def test_a_project_whose_old_columns_named_a_skill_judges_that_skill(self) -> None:
        # The sweep runs with the app closed, so a row from before the picker is migrated here too.
        set_skill_columns(self.home, "p1", "plan", ["code-review"])
        self.on()
        self.issues = [issue_row(265)]
        sweep(self.home, "p1", self.folders(), skills={"log-triage"})
        self.assertEqual(self.shown()["refusal"], afk.MISSING_SKILL.format(name="plan"))
        self.assertIsNone(self.shown()["task"])

    def test_a_host_that_cannot_list_its_skills_judges_no_choice(self) -> None:
        self.on()
        self.choose(steps=["code-review"])
        self.issues = [issue_row(265)]
        claimed = sweep(self.home, "p1", self.folders(), skills=None)
        self.assertEqual(
            [task["number"] for task in claimed], [265], "a host that can't say isn't a host to refuse by"
        )

    def test_the_whole_sweep_reads_the_bots_skills_once(self) -> None:
        self.on()
        self.choose(steps=["code-review"])
        self.issues = [issue_row(265)]
        project = SimpleNamespace(folders=self.folders(), archived=False)
        with patch.object(sessions, "projects", return_value={"p1": project}):
            with patch.object(afk, "_profile_skills", return_value={"other"}) as read:
                sweep_all(self.home)
        read.assert_called_once()
        self.assertEqual(self.shown()["refusal"], afk.MISSING_SKILL.format(name="code-review"))


class StageRunTests(unittest.TestCase):
    """A stage's run: the same session, briefed for the stage the task has moved to."""

    def setUp(self) -> None:
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.task = {
            "repo": "mock-user/memento",
            "number": 265,
            "title": "The frontier is read from GitHub and listed",
            "url": "https://github.com/mock-user/memento/issues/265",
        }
        staged = staged_record(pipeline.CRITIQUE, steps=("code-review", "log-triage"))
        self.record = {
            "session_id": "memento-afk-review",
            "project_id": "p1",
            "mode": "auto",
            "path": "/trees/afk-265",
            "branch": "hermes/afk-265",
            "repo_root": "/checkout",
            "files_dir": "/checkout/files/afk-265",
            "plan_pending": False,
            "pipeline": staged,
            "repos": [
                {
                    "name": "mock-user/memento",
                    "repo_root": "/checkout",
                    "path": "/trees/afk-265",
                    "branch": "hermes/afk-265",
                }
            ],
        }
        self.posted: List[dict] = []
        for one in (
            patch("plugin.outbox.post", side_effect=self.post),
            patch.object(afk, "base_branch", return_value="main"),
        ):
            one.start()
            self.addCleanup(one.stop)

    async def post(self, adapter: Any, profile: Any, path: str, body: dict, **kwargs: Any) -> dict:
        self.posted.append({"profile": profile, "path": path, "body": body, **kwargs})
        return {"run_id": "run-2"}

    def adapter(self) -> SimpleNamespace:
        return SimpleNamespace(_host="127.0.0.1", _port=8642, _api_key="host-key")

    def hold(self) -> afk.Hold:
        """The hold this stage's session works: its task, which the next run is briefed for."""
        return afk.Hold("p1", self.task, self.record["session_id"], None, None, None)

    def run_stage(self) -> dict:
        asyncio.run(afk.work_stage(self.adapter(), self.home, self.record, self.task))
        self.assertEqual(len(self.posted), 1, "one run per stage, not one per skill")
        return self.posted[0]["body"]

    def test_it_posts_the_stages_run_on_the_same_session(self) -> None:
        body = self.run_stage()
        self.assertEqual(body["session_id"], self.record["session_id"])
        self.assertEqual(self.posted[0]["path"], "/v1/runs")
        self.assertNotIn("model", body, "the host's own model runs it")

    def test_its_input_is_one_line_naming_the_stage_and_the_issue(self) -> None:
        body = self.run_stage()
        self.assertEqual(
            body["input"],
            [{"role": "user", "content": "Review #265 (https://github.com/mock-user/memento/issues/265)"}],
        )

    def test_its_instructions_name_the_task_the_base_and_the_skills_in_order(self) -> None:
        text = self.run_stage()["instructions"]
        self.assertIn("mock-user/memento#265", text)
        self.assertIn("base branch main", text, "the branch the pull request is against")
        self.assertIn('"code-review", "log-triage"', text, "the stage's steps, in the order it applies them")
        self.assertIn("Review stage", text)
        self.assertIn("/trees/afk-265", text, "the worktree the review reads")
        self.assertIn("action 'ship'", text, "the shipping stage opens the draft")
        self.assertNotIn("delegate_task", text, "a stage's steps are lenses in one run, not delegates")

    def test_a_stage_that_cannot_start_stalls_the_task(self) -> None:
        outbox.post.side_effect = outbox.StartError("No API key for this bot.", True)
        with (
            patch.object(afk, "holding_project", return_value="p1"),
            patch.object(afk, "_stall") as stall,
        ):
            asyncio.run(afk.work_stage(self.adapter(), self.home, self.record, self.task))
        stall.assert_called_once_with(
            self.home, "p1", self.task, afk.STAGE_FAILED.format(name="Review")
        )

    def test_the_hook_starts_it_on_the_loop_that_owns_the_runs(self) -> None:
        loop = SimpleNamespace()
        with (
            patch.object(afk, "_hold_for_session", return_value=self.hold()),
            patch.object(afk, "_loop", loop),
            patch.object(afk.asyncio, "run_coroutine_threadsafe") as schedule,
        ):
            afk._start_stage(self.home, self.record)
        schedule.assert_called_once()
        coroutine, where = schedule.call_args[0]
        self.assertIs(where, loop, "the loop that owns the runs is the one asked to post it")
        self.assertEqual(coroutine.cr_code.co_name, "work_stage", "and it is the stage's run")
        coroutine.close()  # the loop would await it; nothing here does

    def test_a_host_with_no_loop_stalls_instead_of_dropping_the_task(self) -> None:
        with (
            patch.object(afk, "_hold_for_session", return_value=self.hold()),
            patch.object(afk, "_loop", None),
            patch.object(afk, "_stall") as stall,
        ):
            afk._start_stage(self.home, self.record)
        self.assertEqual(self.posted, [], "nothing is posted off the loop")
        stall.assert_called_once_with(
            self.home, "p1", self.task, afk.STAGE_FAILED.format(name="Review")
        )


class MigrationTests(unittest.TestCase):
    """A store from before picks: the one hold a project had becomes its first row.

    `connect` migrates on open, so a v38 store can only be had by writing one: this is the only
    place in the suite that builds a schema by hand, and the only way to pin what an upgrade does
    with work already in flight.
    """

    OLD_AFK = """CREATE TABLE project_afk (
        project_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL,
        at INTEGER NOT NULL,
        task TEXT,
        claimed_at INTEGER,
        refusal TEXT,
        refused_at INTEGER,
        session_id TEXT,
        stalled TEXT,
        stalled_at INTEGER,
        build_skill TEXT,
        critique_skills TEXT,
        workflow_id TEXT,
        prompt TEXT
    )"""

    HELD = {
        "repo": "mock-user/memento",
        "number": 265,
        "title": "The frontier is read from GitHub and listed",
        "url": "https://github.com/mock-user/memento/issues/265",
        "created_at": "2026-10-01T00:00:00Z",
    }

    def setUp(self) -> None:
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)

    def v38(self, **afk: Any) -> None:
        """A store as v38 left it, with one project's row and whatever that row held."""
        row = {
            "project_id": "p1",
            "enabled": 1,
            "at": 1_700_000_000,
            "task": json.dumps(self.HELD),
            "claimed_at": 1_700_000_100,
            "session_id": "memento-afk-265",
            "stalled": None,
            "stalled_at": None,
            "prompt": "Work in checkpoints.",
            **afk,
        }
        path = db_path(self.home)
        path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(path)
        try:
            conn.execute(self.OLD_AFK)
            conn.execute(
                """INSERT INTO project_afk
                       (project_id, enabled, at, task, claimed_at, refusal, refused_at, session_id,
                        stalled, stalled_at, build_skill, critique_skills, workflow_id, prompt)
                   VALUES (:project_id, :enabled, :at, :task, :claimed_at, NULL, NULL, :session_id,
                           :stalled, :stalled_at, NULL, NULL, 'preset:one-run', :prompt)""",
                row,
            )
            conn.execute("PRAGMA user_version = 38")
            conn.commit()
        finally:
            conn.close()

    def test_the_one_hold_a_project_had_becomes_a_row_of_its_own(self) -> None:
        self.v38(stalled="The run failed.", stalled_at=1_700_000_200)
        holds = afk._holds(self.home, "p1")
        self.assertEqual(len(holds), 1, "exactly one hold: a working claim is never lost or doubled")
        self.assertEqual(holds[0].task, self.HELD)
        self.assertEqual(holds[0].session_id, "memento-afk-265", "the session working it comes along")
        self.assertEqual(holds[0].claimed_at, 1_700_000_100, "and the clock it was claimed on")
        self.assertEqual(holds[0].stalled, "The run failed.")
        self.assertEqual(holds[0].stalled_at, 1_700_000_200)

    def test_the_project_keeps_its_switch_and_what_it_works_with(self) -> None:
        self.v38()
        shown = afk.read(self.home, "p1", [])
        self.assertTrue(shown["on"], "the switch is still the row's")
        self.assertEqual(shown["prompt"], "Work in checkpoints.")
        self.assertEqual(shown["workflow"]["id"], "preset:one-run")
        self.assertEqual(shown["task"], self.HELD, "and the sheet still draws its Working row")
        self.assertEqual([hold["number"] for hold in shown["holds"]], [265])

    def test_the_new_columns_start_empty_and_read_as_one(self) -> None:
        self.v38()
        self.assertIsNone(afk._row(self.home, "p1")["pick_count"], "nothing is stored for a count of one")
        self.assertIsNone(afk._row(self.home, "p1")["prompt_id"])
        self.assertEqual(afk.read(self.home, "p1", [])["pick_count"], 1)

    def test_a_project_that_held_nothing_gains_no_hold(self) -> None:
        self.v38(task=None)
        self.assertEqual(afk._holds(self.home, "p1"), [])

    def test_a_store_upgraded_twice_keeps_one_row(self) -> None:
        self.v38()
        afk._holds(self.home, "p1")
        # An older build opening the store puts its version back below this one, and the next
        # upgrade copies again: the same hold must not become a second row, or the project would be
        # working one task twice.
        conn = sqlite3.connect(db_path(self.home))
        try:
            conn.execute("PRAGMA user_version = 38")
            conn.commit()
        finally:
            conn.close()
        holds = afk._holds(self.home, "p1")
        self.assertEqual(len(holds), 1, "a hold is copied once, whatever the store's version says")
        self.assertEqual(holds[0].session_id, "memento-afk-265")


class FeatureTests(unittest.TestCase):
    """What this plugin tells an app it can do."""

    def test_the_plugin_advertises_afk_picks(self) -> None:
        """The one flag every pick control gates on: an app behind it draws today's sheet, so the
        name has to be in the features array a real host answers."""
        source = (Path(afk.__file__).parent / "__init__.py").read_text()
        self.assertRegex(source, r'\n\s+"afk_picks",\n')


class BotRouteTests(unittest.TestCase):
    """The bot-level AFK route: what it is registered as, and what it answers from.

    The handlers live inside the plugin's registration function, which needs a whole Hermes host, so
    what a test can hold them to is the source itself — the two verbs, the object the app reads, and
    the three plugin calls they answer with. What those calls do is `PickBudgetSettingTests`.
    """

    def setUp(self) -> None:
        self.source = (Path(afk.__file__).parent / "__init__.py").read_text()

    def test_both_of_the_bots_afk_verbs_are_registered_beside_the_projects(self) -> None:
        self.assertRegex(
            self.source, r'app\.router\.add_get\(f"\{PREFIX\}/afk", bot_afk\)'
        )
        self.assertRegex(
            self.source, r'app\.router\.add_post\(f"\{PREFIX\}/afk", post_bot_afk\)'
        )

    def test_its_answer_is_a_bots_own_object(self) -> None:
        self.assertIn('"object": "memento.afk.bot"', self.source)

    def test_it_reads_and_writes_the_bots_own_store(self) -> None:
        for call in ("afk.bot_read", "afk.budget_from", "afk.set_pick_budget"):
            with self.subTest(call=call):
                self.assertIn(call, self.source)


if __name__ == "__main__":
    unittest.main()
