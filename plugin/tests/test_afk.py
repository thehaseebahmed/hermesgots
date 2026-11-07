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
from unittest.mock import patch

from plugin import (
    afk,
    chats,
    github,
    outbox,
    projects,
    prompt_builder,
    sessions,
    usage,
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
    set_usage_threshold,
    sweep,
    sweep_all,
    write_from,
)
from plugin.store import connect, db_path, get_setting, put_setting
from plugin.tasks import CLAIM_LABEL, READY_LABEL
from plugin.tests._helpers import (
    issue_row,
    stub_projects_db,
    usage_window,
)


def folder(path: str) -> SimpleNamespace:
    """A project folder as the plugin reads one: only where it is."""
    return SimpleNamespace(path=path)


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
            patch.object(github, "origin_repo", return_value="mock-user/gots"),
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
                "repo": "mock-user/gots",
                "number": 265,
                "title": "Task 265",
                "url": "https://github.com/mock-user/gots/issues/265",
                "created_at": "2026-10-01T00:00:00Z",
            },
        )
        with patch("plugin.afk.github.token", return_value=(None, None)):
            # Nothing to release with: the switch is what this test is about.
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

    def test_deleting_a_project_gives_every_holds_claim_back(self) -> None:
        self.stub_projects()
        (self.home / "projects.db").write_text("")
        set_on(self.home, "p1", self.folders(), True)
        for number in (265, 266):
            afk._hold(
                self.home,
                "p1",
                {
                    "repo": "mock-user/gots",
                    "number": number,
                    "title": f"Task {number}",
                    "url": f"https://github.com/mock-user/gots/issues/{number}",
                    "created_at": "2026-10-01T00:00:00Z",
                },
            )
        with (
            patch("plugin.afk.github.token", return_value=("token", None)),
            patch("plugin.afk.github.release_claim") as release_claim,
        ):
            self.assertTrue(projects.remove(self.home, "p1"))
        released = sorted(call.args[:2] for call in release_claim.call_args_list)
        self.assertEqual(
            released,
            [("mock-user/gots", 265), ("mock-user/gots", 266)],
            "a task left labelled and assigned would never be read as ready again (ADR 0012)",
        )
        self.assertEqual(afk._holds(self.home, "p1"), [])


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


def afk_row(
    on: bool = False,
    reason: Optional[str] = None,
    task: Any = None,
    refusal: Optional[str] = None,
    prompt: Any = None,
    holds: Any = None,
    pick_count: int = 1,
    prompt_id: Optional[str] = None,
    pick_budget: int = 5,
    holds_held: int = 0,
    usage_threshold: Optional[int] = None,
) -> Dict[str, Any]:
    """The answer `read` gives for a project holding nothing and having written nothing.

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
        "prompt": prompt_builder.DEFAULT_PROMPT if prompt is None else prompt,
        "pick_budget": pick_budget,
        "holds_held": holds_held,
        "usage_threshold": usage_threshold,
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
            patch.object(github, "origin_repo", return_value="mock-user/gots"),
        ):
            one.start()
            self.addCleanup(one.stop)

    def folders(self) -> List[Any]:
        return [folder(str(self.checkout))]

class StartHarness(AfkHome):
    """A home that can start a claimed task: its session made, its run posted, both recorded.

    The task, the record a start hands back and the seams a start crosses live here once, so a
    class testing what a run is told shares them with the class testing what it settles.
    """

    def setUp(self) -> None:
        super().setUp()
        self.home.joinpath("projects.db").write_text("")
        self.task = {
            "repo": "mock-user/gots",
            "number": 265,
            "title": "The frontier is read from GitHub and listed",
            "url": "https://github.com/mock-user/gots/issues/265",
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
                    "name": "mock-user/gots",
                    "repo_root": "/checkout",
                    "path": "/trees/quiet-marmot",
                    "branch": "hermes/quiet-marmot",
                }
            ],
        }
        for one in (
            patch.object(github, "login", return_value="gots-bot"),
            patch.object(github, "_request", self.request),
            patch("plugin.sessions.ensure", side_effect=self.ensure),
            patch("plugin.sessions.apply_cwd"),
            patch("plugin.outbox.post", side_effect=self.post),
        ):
            one.start()
            self.addCleanup(one.stop)

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


class PromptTests(StartHarness):
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

    def test_one_projects_prompt_leaves_anothers_alone(self) -> None:
        set_prompt(self.home, "p2", "Theirs.")
        self.assertEqual(self.prompt(), prompt_builder.DEFAULT_PROMPT)
        self.assertEqual(self.prompt("p2"), "Theirs.")

    def test_writing_a_prompt_is_no_reason_to_start_working(self) -> None:
        set_prompt(self.home, "p1", "Squash every checkpoint into one commit.")
        self.assertFalse(read(self.home, "p1", self.folders())["on"])

    def test_a_write_names_the_prompt_as_its_own_shape(self) -> None:
        self.assertEqual(
            write_from({"prompt": "Mine."}), ("prompt", {"prompt": "Mine.", "prompt_id": None})
        )
        self.assertEqual(
            write_from({"prompt": "  Mine.  "}),
            ("prompt", {"prompt": "Mine.", "prompt_id": None}),
            "trimmed",
        )
        self.assertEqual(
            write_from({"prompt": ""}), ("prompt", {"prompt": None, "prompt_id": None}), "cleared"
        )
        self.assertEqual(write_from({"prompt": "   "}), ("prompt", {"prompt": None, "prompt_id": None}))
        self.assertEqual(write_from({"prompt": None}), ("prompt", {"prompt": None, "prompt_id": None}))

    def test_a_prompt_and_the_entry_it_copied_are_one_shape(self) -> None:
        self.assertEqual(
            write_from({"prompt": "Mine.", "prompt_id": "e-one"}),
            ("prompt", {"prompt": "Mine.", "prompt_id": "e-one"}),
            "a source is a companion to the words, not a shape beside them",
        )
        self.assertEqual(
            write_from({"prompt": "  Mine.  ", "prompt_id": "  e-one  "}),
            ("prompt", {"prompt": "Mine.", "prompt_id": "e-one"}),
            "both halves trimmed",
        )

        set_prompt(self.home, "p1", "Mine.", "e-one")
        self.assertEqual(self.prompt(), "Mine.", "the words are the ones it copied")
        self.assertEqual(
            afk._row(self.home, "p1")["prompt_id"], "e-one", "the row keeps its source"
        )
        self.assertEqual(
            read(self.home, "p1", self.folders())["prompt_id"],
            "e-one",
            "and the sheet is told which entry the copy came from",
        )

    def test_a_plain_prompt_write_clears_its_source(self) -> None:
        # A hand edit detaches the copy: the row must never call the user's own words a stale one.
        set_prompt(self.home, "p1", "Mine.", "e-one")
        set_prompt(self.home, "p1", "Mine, with a line of my own.")
        self.assertIsNone(afk._row(self.home, "p1")["prompt_id"], "the source goes with the words")
        self.assertIsNone(read(self.home, "p1", self.folders())["prompt_id"])

    def test_a_source_without_a_prompt_is_refused(self) -> None:
        for body in (
            {"prompt_id": "e-one"},
            {"prompt_id": None},
            {"on": True, "prompt_id": "e-one"},
        ):
            with self.subTest(body=body):
                with self.assertRaises(ValueError) as refused:
                    write_from(body)
                self.assertEqual(
                    str(refused.exception),
                    "prompt_id needs a prompt beside it.",
                    "an entry id names nothing without the words it describes",
                )

    def test_a_source_beside_a_prompt_has_to_be_an_id(self) -> None:
        for source in (3, "", "   ", None):
            with self.subTest(source=source):
                with self.assertRaises(ValueError):
                    write_from({"prompt": "Mine.", "prompt_id": source})
        with self.assertRaises(ValueError):
            write_from({"prompt": "Mine.", "prompt_id": "e-one", "on": True})

    def test_a_prompt_is_never_written_beside_another_shape(self) -> None:
        for body in (
            {"prompt": "Mine.", "on": True},
            {"prompt": "Mine.", "pick_count": 2},
            {"prompt": 3},
        ):
            with self.subTest(body=body):
                with self.assertRaises(ValueError):
                    write_from(body)

    def test_a_stored_prompt_is_what_the_run_is_told(self) -> None:
        set_prompt(self.home, "p1", "Squash every checkpoint into one commit.")
        body = afk.run_body(
            self.session_record(),
            {"repo": "mock-user/gots", "number": 265},
            "Squash every checkpoint into one commit.",
        )
        self.assertIn("Squash every checkpoint into one commit.", body["instructions"])
        self.assertNotIn(
            prompt_builder.DEFAULT_PROMPT,
            body["instructions"],
            "the project's own words stand in for the default",
        )

    def test_a_claimed_task_is_worked_in_one_run_told_its_prompt(self) -> None:
        """A task's whole work is one run told the project's Prompt.

        Before the stage machine went, a project that had picked a workflow snapshotted it onto the
        session and was briefed for the build stage instead; v58 drops that pick, so what is left to
        prove is that the run is one run and that it is told the Prompt.
        """
        set_on(self.home, "p1", self.folders(), True)
        afk._hold(self.home, "p1", self.task)
        self.start()
        self.assertEqual(len(self.posted), 1, "one run is the task's whole work")
        record = sessions.read(db_path(self.home), self.ensured[0][0])
        self.assertNotIn("pipeline", record, "nothing is staged, so no snapshot is written")
        instructions = self.posted[0]["body"]["instructions"]
        self.assertIn("## The Project's Prompt", instructions, "the method is told in its own section")
        self.assertIn(prompt_builder.DEFAULT_PROMPT, instructions, "the Prompt it works by")
        self.assertNotIn("## User's Workflow", instructions, "no workflow word reaches a run")
        self.assertLess(
            instructions.index("the pull request ships last"),
            instructions.index("## The Project's Prompt"),
            "AFK's fixed points come first",
        )
        self.assertNotIn("This task is worked in", instructions, "no stage is briefed")

    def session_record(self) -> Dict[str, Any]:
        """A session's record as the run's request reads it."""
        return {
            "session_id": "gots-afk-s1",
            "project_id": "p1",
            "mode": "auto",
            "repos": [
                {
                    "name": "mock-user/gots",
                    "repo_root": str(self.checkout),
                    "path": "/trees/afk-265",
                    "branch": "hermes/afk-265",
                }
            ],
        }


class WriteShapeTests(unittest.TestCase):
    """Every shape a project write names has one writer, and that writer takes what it carries.

    The route hands a shape's arguments straight to the writer the table names (`AFK_WRITES`), so a
    payload key no writer accepts is a 500 on a write the sheet offers — not a refusal the user can
    read — and a shape the table forgot is a write nothing performs.
    """

    BODIES = (
        {"on": True},
        {"prompt": "Mine.", "prompt_id": "e-one"},
        {"pick_count": 2},
    )

    SHAPES = "on, prompt or pick_count"

    def test_a_workflow_id_is_no_longer_a_write_this_host_takes(self) -> None:
        """The library is gone, so a pick names no writer: the 400 an unknown shape always got."""
        with self.assertRaises(ValueError) as refused:
            write_from({"workflow_id": "wf-1"})
        self.assertEqual(str(refused.exception), f"{self.SHAPES} is needed.")

    def test_a_build_skill_body_is_not_one_either(self) -> None:
        """The skills columns are neither read nor written now, so a body naming one is refused."""
        with self.assertRaises(ValueError) as refused:
            write_from({"build_skill": "plan"})
        self.assertEqual(str(refused.exception), f"{self.SHAPES} is needed.")

    def test_every_shape_a_write_names_has_a_writer_that_takes_its_arguments(self) -> None:
        import inspect

        import plugin

        for body in self.BODIES:
            with self.subTest(body=body):
                kind, payload = write_from(body)
                writer = plugin.AFK_WRITES.get(kind)
                self.assertIsNotNone(writer, f"{kind} is a write this host performs")
                takes = set(inspect.signature(writer).parameters)
                # `on` also takes the project's folders and whether it is archived: the route adds
                # those, because it is the one write that asks whether the project can work at all.
                wanted = set(payload) | ({"folders", "archived"} if kind == "on" else set())
                self.assertEqual(
                    wanted - takes, set(), f"{kind}'s arguments are the ones its writer takes"
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
            patch.object(github, "origin_repo", return_value="mock-user/gots"),
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

    def sweep(self) -> None:
        sweep(self.home, "p1", self.folders())

    def shown(self) -> dict:
        """What the sheet reads after a sweep: the switch, the task held and the last refusal."""
        return read(self.home, "p1", self.folders())

    def answer_get(self, path: str, auth: Any) -> Any:
        if path == "/user":
            return {"login": "mock-user"}
        if path.startswith("/repos/mock-user/gots/labels/"):
            if self.label_exists:
                return {"name": CLAIM_LABEL}
            # GitHub words a missing label as it words any missing thing.
            raise github.GitHubError("Not Found")
        if path.startswith("/repos/mock-user/gots/issues?"):
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
                ("POST", "/repos/mock-user/gots/issues/265/labels", {"labels": [CLAIM_LABEL]}),
                (
                    "POST",
                    "/repos/mock-user/gots/issues/265/assignees",
                    {"assignees": ["mock-user"]},
                ),
            ],
        )

    def test_the_issue_it_claims_opens_its_run(self) -> None:
        body = "## What to build\n\nOldest first.\n\n- one\n- two"
        self.on()
        self.issues = [issue_row(265, body=body)]
        claimed = sweep(self.home, "p1", self.folders())
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
        self.assertEqual((method, path), ("POST", "/repos/mock-user/gots/labels"))
        self.assertEqual(data["name"], CLAIM_LABEL)
        # And only then is the task claimed with it.
        self.assertEqual(
            self.writes[1],
            ("POST", "/repos/mock-user/gots/issues/265/labels", {"labels": [CLAIM_LABEL]}),
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
            [f"/repos/mock-user/gots/issues/{number}/labels" for number in (265, 266, 267)],
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
                ("POST", "/repos/mock-user/gots/issues/265/labels", {"labels": [CLAIM_LABEL]}),
                (
                    "POST",
                    "/repos/mock-user/gots/issues/265/assignees",
                    {"assignees": ["mock-user"]},
                ),
                ("DELETE", "/repos/mock-user/gots/issues/265/labels/gots-got-it", None),
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
                "repo": "mock-user/gots",
                "number": 265,
                "title": "Task 265",
                "url": "https://github.com/mock-user/gots/issues/265",
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
            afk._adopt(self.home, "p1", f"gots-afk-{number}", mine.task)
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
                "repo": "mock-user/gots",
                "number": 265,
                "title": "Task 265",
                "url": "https://github.com/mock-user/gots/issues/265",
                "created_at": "2026-10-01T00:00:00Z",
                "stalled": None,
            },
            "a hold is its task and why it stalled — all null before a start",
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
        self.assertEqual(write_from({"pick_count": 4}), ("pick_count", {"count": 4}))
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
            str(raised.exception), "A write names one of on, prompt or pick_count."
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
            ["gots-afk-265"],
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
            ["/repos/mock-user/gots/issues/266/assignees"],
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
                {"session_id": "gots-afk-266", "project_id": "p1", "task": middle},
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
                "/repos/mock-user/gots/issues/266/labels/gots-got-it",
                "/repos/mock-user/gots/issues/266/assignees",
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
        self.assertEqual(
            afk.bot_read(self.home),
            {"pick_budget": 5, "holds_held": 0, "usage_threshold": None},
        )

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
            "repo": "mock-user/gots",
            "number": 265,
            "title": "Task 265",
            "url": "https://github.com/mock-user/gots/issues/265",
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
        # What a pass asked GitHub about itself rather than about a repository: whose the token is,
        # and whether the claim label is there yet. Both are once-per-pass facts to a sweep.
        self.logins: List[str] = []
        self.label_reads: List[str] = []
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
            self.logins.append(path)
            return {"login": "mock-user"}
        if "/labels/" in path:
            self.label_reads.append(path)
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

    def test_two_projects_of_one_repository_claim_the_issue_once(self) -> None:
        """A shared checkout: both projects read the same frontier, and a pass hands a task out once.

        Two projects pointing at one repository plan from one list of ready issues, so a pass that
        claimed each project's oldest would take the same issue twice — two holds on one task, four
        GitHub writes, and one of them left with nothing working it.
        """
        self.REPOS = {**self.REPOS, "p2": "mock-user/one"}
        self.turn_on("p1", 1)
        self.turn_on("p2", 1)
        self.issues["mock-user/one"] = [issue_row(265)]
        claimed = self.pass_()
        self.assertEqual(len(claimed), 1, "one ready issue is one claim")
        winner = claimed[0][0]
        self.assertEqual(
            [project_id for project_id in ("p1", "p2") if self.holds(project_id)],
            [winner],
            "exactly one of the two projects holds the task",
        )
        other = "p2" if winner == "p1" else "p1"
        self.assertEqual(self.holds(other), [], "the other project holds nothing")
        self.assertIsNone(
            self.shown(other)["refusal"],
            "it had nothing to claim rather than being held back by the budget, so it says nothing",
        )
        self.assertEqual(
            len(self.writes), 2, "one claim's label and assignment, not two claims' worth"
        )
        self.assertEqual(
            sorted(self.reads), ["mock-user/one", "mock-user/one"], "each project reads it once"
        )

    def test_a_shared_repository_still_hands_its_oldest_tasks_out_in_the_bots_order(self) -> None:
        """The bot-wide ordering survives two projects of one repository, and neither task doubles."""
        self.REPOS = {**self.REPOS, "p2": "mock-user/one"}
        set_pick_budget(self.home, 2)
        self.turn_on("p1", 1)
        self.turn_on("p2", 1)
        self.issues["mock-user/one"] = [
            issue_row(266, created="2026-10-02T00:00:00Z"),
            issue_row(265),
        ]
        claimed = self.pass_()
        self.assertEqual(
            [(project_id, task["number"]) for project_id, task in claimed],
            [("p1", 265), ("p2", 266)],
            "one place each, the oldest ready task first, and no task claimed for both",
        )
        self.assertEqual(self.holds("p1"), [265])
        self.assertEqual(self.holds("p2"), [266])
        self.assertEqual(len(self.writes), 4, "two claims")

    def test_a_pass_asks_whose_the_token_is_and_makes_the_label_once(self) -> None:
        """Three claims of one repository are one read of the account and one look for the label."""
        self.turn_on("p1", 3)
        self.issues["mock-user/one"] = [
            issue_row(265),
            issue_row(266, created="2026-10-02T00:00:00Z"),
            issue_row(267, created="2026-10-03T00:00:00Z"),
        ]
        self.assertEqual(len(self.pass_()), 3)
        self.assertEqual(self.logins, ["/user"], "one read of /user, not one per claim")
        self.assertEqual(len(self.label_reads), 1, "the label is looked for once per repository")

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
                    "the bot's two numbers, answered by whichever project's read the sheet has",
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


def account(*windows: Dict[str, Any], provider: str = "anthropic") -> Dict[str, Any]:
    """The answer ``usage.fetch`` gives for those windows, its deciding window included.

    The deciding window is worked out by the rule itself rather than spelled here, so these tests
    hold the pass to the plugin's own answer and not to a second copy of it.
    """
    return {
        "provider": provider,
        "plan": None,
        "windows": list(windows),
        "deciding": usage.deciding(windows),
    }


class UsageThresholdTests(PickBudgetTests):
    """The bot's usage threshold over its projects: what a pass claims while the account is nearly out.

    The account is the plugin's own stub, the way GitHub is: ``usage.fetch`` answers the windows a
    provider would, and the profile's main model is named by ``host_model.read_main`` without a
    ``config.yaml`` — which is the provider a pickup's first run would spend (ADR 0026).
    """

    OVER = dict(label="Weekly", used=92.0, resets="2026-10-20T00:00:00+00:00")

    def setUp(self) -> None:
        super().setUp()
        self.asks: List[str] = []
        self.answer: Optional[Dict[str, Any]] = account(usage_window(**self.OVER))
        self.raised: Optional[Exception] = None
        self.main: Optional[Dict[str, str]] = {"provider": "anthropic", "model": "claude-sonnet"}
        for one in (
            patch.object(afk.host_model, "read_main", side_effect=lambda _path: self.main),
            patch.object(afk.usage, "fetch", side_effect=self.fetch_usage),
        ):
            one.start()
            self.addCleanup(one.stop)

    def fetch_usage(self, provider: str) -> Optional[Dict[str, Any]]:
        self.asks.append(provider)
        if self.raised is not None:
            raise self.raised
        return self.answer

    def ready(self) -> None:
        self.issues["mock-user/one"] = [issue_row(265), issue_row(266, created="2026-10-02T00:00:00Z")]
        self.issues["mock-user/two"] = [issue_row(267, created="2026-10-03T00:00:00Z")]

    def over(self, threshold: int = 80) -> None:
        set_usage_threshold(self.home, threshold)
        self.answer = account(usage_window(**self.OVER))

    def test_a_project_over_the_threshold_claims_nothing_and_names_the_window(self) -> None:
        self.turn_on("p1", 1)
        self.over(80)
        self.ready()
        self.assertEqual(self.pass_(), [], "a spent account is no reason to take another task")
        self.assertEqual(self.writes, [], "and nothing is touched on GitHub")
        shown = self.shown("p1")
        self.assertEqual(
            shown["refusal"],
            afk.USAGE_HELD.format(window="Weekly", percent="92", threshold=80),
            "the line names the window, its own percent and the number the user set",
        )
        self.assertTrue(shown["on"], "the switch stays on, so the sheet shows why it is holding")
        self.assertIsNone(shown["task"])
        self.assertEqual(self.reads, [], "a held-back project reads no frontier at all")

    def test_a_project_under_the_threshold_claims_the_oldest_ready_task(self) -> None:
        self.turn_on("p1", 1)
        set_usage_threshold(self.home, 95)
        self.ready()
        claimed = self.pass_()
        self.assertEqual(
            [(project_id, task["number"]) for project_id, task in claimed],
            [("p1", 265)],
            "92% used is under a 95% threshold, so the oldest ready task is claimed as usual",
        )
        self.assertIsNone(self.shown("p1")["refusal"])

    def test_the_threshold_is_at_or_above_the_window_it_names(self) -> None:
        self.turn_on("p1", 1)
        set_usage_threshold(self.home, 92)
        self.ready()
        self.assertEqual(self.pass_(), [], "at the threshold is over it, not beside it")
        self.assertIn("92% used", self.shown("p1")["refusal"])

    def test_a_bot_with_no_threshold_never_reads_the_account(self) -> None:
        self.turn_on("p1", 1)
        self.ready()
        self.assertEqual(len(self.pass_()), 1)
        self.assertEqual(self.asks, [], "off means off: a bot with no limit reads nothing")

    def test_a_full_budget_is_stated_ahead_of_the_account_without_reading_it(self) -> None:
        set_pick_budget(self.home, 1)
        held = {
            "repo": "mock-user/two",
            "number": 250,
            "title": "Held",
            "url": "https://github.com/mock-user/two/issues/250",
            "created_at": "2026-09-01T00:00:00Z",
        }
        afk._hold(self.home, "p2", held)
        self.turn_on("p1", 1)
        self.over(80)
        self.ready()
        self.assertEqual(self.pass_(), [])
        self.assertEqual(
            self.shown("p1")["refusal"],
            afk.PICK_BUDGET_FULL.format(held=1, budget=1),
            "the bot's own number is the answer, and it needed no account read to know",
        )
        self.assertEqual(self.asks, [], "the account is not spent to say what the budget already says")

    def test_one_pass_over_two_projects_asks_the_account_once(self) -> None:
        self.turn_on("p1", 1)
        self.turn_on("p2", 1)
        self.over(80)
        self.ready()
        self.assertEqual(self.pass_(), [])
        self.assertEqual(self.asks, ["anthropic"], "one bot, one account, one read")

    def test_an_account_that_cannot_be_read_claims_as_usual(self) -> None:
        self.turn_on("p1", 1)
        self.over(80)
        self.ready()
        self.raised = RuntimeError("down")
        self.assertEqual(
            [(project_id, task["number"]) for project_id, task in self.pass_()],
            [("p1", 265)],
            "a host that can't read an account is not a reason to stop working",
        )
        self.assertIsNone(self.shown("p1")["refusal"], "and nothing is recorded about it")

    def test_an_answer_with_no_windows_claims_as_usual(self) -> None:
        self.turn_on("p1", 1)
        self.over(80)
        self.ready()
        self.answer = account()
        self.assertEqual(len(self.pass_()), 1)
        self.assertIsNone(self.shown("p1")["refusal"])

    def test_a_main_model_the_host_cannot_name_claims_as_usual(self) -> None:
        self.turn_on("p1", 1)
        self.over(80)
        self.ready()
        self.main = None
        self.assertEqual(len(self.pass_()), 1)
        self.assertEqual(self.asks, [], "with no provider there is nothing to ask")
        self.assertIsNone(self.shown("p1")["refusal"])

    def test_the_provider_is_the_profiles_main_model(self) -> None:
        self.turn_on("p1", 1)
        self.over(80)
        self.ready()
        self.main = {"provider": "openrouter", "model": "some/model"}
        self.pass_()
        self.assertEqual(self.asks, ["openrouter"], "the main model's provider, never a fallback")

    def test_an_unreadable_account_is_no_hold_at_all(self) -> None:
        self.turn_on("p1", 1)
        self.over(80)
        self.raised = RuntimeError("down")
        self.assertIsNone(
            afk._Account(self.home).refusal(),
            "no key, a provider that is down: the pass claims, and writes no sentence about it",
        )

    def test_the_account_recovering_claims_again_without_touching_the_switch(self) -> None:
        self.turn_on("p1", 1)
        self.over(80)
        self.ready()
        self.assertEqual(self.pass_(), [])
        self.answer = account(usage_window("Weekly", 40.0, resets="2026-10-20T00:00:00+00:00"))
        claimed = self.pass_()
        self.assertEqual(
            [(project_id, task["number"]) for project_id, task in claimed],
            [("p1", 265)],
            "the next pass claims as soon as there is room, and the stop was a pause",
        )
        self.assertTrue(self.shown("p1")["on"])
        self.assertIsNone(self.shown("p1")["refusal"], "and the claim clears the old line")


class UsageThresholdSettingTests(unittest.TestCase):
    """The threshold's own number: what an unset one reads as, what a write takes, one route for both."""

    def setUp(self) -> None:
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)

    def test_a_bot_that_names_no_threshold_is_off(self) -> None:
        self.assertIsNone(afk.usage_threshold(self.home))
        self.assertIsNone(afk.bot_read(self.home)["usage_threshold"])

    def test_the_threshold_is_read_back_from_the_hosts_own_store(self) -> None:
        set_usage_threshold(self.home, 80)
        self.assertEqual(afk.usage_threshold(self.home), 80)
        self.assertEqual(
            get_setting(db_path(self.home), "afk_usage_threshold"),
            80,
            "the number is the bot's own settings row, beside the pick budget's",
        )

    def test_every_whole_number_from_fifty_to_a_hundred_is_a_threshold(self) -> None:
        for value in range(50, 101):
            with self.subTest(usage_threshold=value):
                self.assertEqual(afk.threshold_from({"usage_threshold": value}), value)
                set_usage_threshold(self.home, value)
                self.assertEqual(afk.usage_threshold(self.home), value)

    def test_a_value_outside_fifty_to_a_hundred_is_refused_naming_the_range(self) -> None:
        for body in (49, 101, 0, -1, "80", 72.5, True, [80]):
            with self.subTest(usage_threshold=body):
                with self.assertRaises(ValueError) as raised:
                    afk.bot_writes({"usage_threshold": body})
                self.assertEqual(
                    str(raised.exception),
                    "usage_threshold must be a whole number from 50 to 100.",
                )

    def test_a_null_threshold_is_off(self) -> None:
        set_usage_threshold(self.home, 80)
        self.assertEqual(afk.bot_writes({"usage_threshold": None}), {"afk_usage_threshold": None})
        afk.write_bot(self.home, afk.bot_writes({"usage_threshold": None}))
        self.assertIsNone(afk.usage_threshold(self.home), "Off is a write of its own")

    def test_a_write_takes_the_threshold_alone_or_beside_the_budget(self) -> None:
        self.assertEqual(afk.bot_writes({"usage_threshold": 90}), {"afk_usage_threshold": 90})
        self.assertEqual(
            afk.bot_writes({"pick_budget": 3, "usage_threshold": 90}),
            {"afk_pick_budget": 3, "afk_usage_threshold": 90},
            "one route carries both of the bot's numbers",
        )
        afk.write_bot(self.home, afk.bot_writes({"pick_budget": 3, "usage_threshold": 90}))
        self.assertEqual(
            (afk.pick_budget(self.home), afk.usage_threshold(self.home)),
            (3, 90),
            "and each lands on its own row",
        )

    def test_a_body_with_one_bad_field_writes_neither(self) -> None:
        with self.assertRaises(ValueError):
            afk.bot_writes({"pick_budget": 3, "usage_threshold": 10})
        self.assertEqual(
            (afk.pick_budget(self.home), afk.usage_threshold(self.home)),
            (5, None),
            "everything named is checked before anything is written",
        )

    def test_a_write_that_names_neither_number_says_what_it_takes(self) -> None:
        for body in ({}, {"on": True}, {"threshold": 90}, {"pick": 3}):
            with self.subTest(body=body):
                with self.assertRaises(ValueError) as raised:
                    afk.bot_writes(body)
                self.assertEqual(str(raised.exception), "pick_budget or usage_threshold is needed.")

    def test_a_stored_threshold_nobody_could_have_set_reads_as_off(self) -> None:
        for stored in (49, 101, "80", 72.5, True, {"usage_threshold": 80}):
            with self.subTest(stored=stored):
                put_setting(db_path(self.home), "afk_usage_threshold", stored)
                self.assertIsNone(afk.usage_threshold(self.home))

    def test_a_projects_read_carries_the_threshold_beside_the_budget(self) -> None:
        set_usage_threshold(self.home, 70)
        set_pick_budget(self.home, 4)
        for project_id in ("p1", "p9"):
            with self.subTest(project=project_id):
                found = read(self.home, project_id, [])
                self.assertEqual((found["pick_budget"], found["usage_threshold"]), (4, 70))


class AfkSessionTests(ClaimStubTests):
    """AFK holding a claimed task in a published session, and giving that claim back.

    The session is made and published the way ``afk.start`` leaves it, and the user's own mark then
    arrives through the chat list.
    """

    SESSION = "gots-afk-s1"

    def setUp(self) -> None:
        super().setUp()
        self.on()
        self.issues = [issue_row(265), issue_row(266, created="2026-10-02T00:00:00Z")]
        self.sweep()
        self.task = self.shown()["task"]
        repos = [
            {
                "name": "mock-user/gots",
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
                ("DELETE", "/repos/mock-user/gots/issues/265/labels/gots-got-it", None),
                (
                    "DELETE",
                    "/repos/mock-user/gots/issues/265/assignees",
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
                "/repos/mock-user/gots/issues/266/labels",
                "/repos/mock-user/gots/issues/266/assignees",
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
                "/repos/mock-user/gots/issues/265/labels/gots-got-it",
                "/repos/mock-user/gots/issues/265/assignees",
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
        afk._adopt(self.home, "p1", "gots-afk-s2", later)
        self.writes.clear()

        self.assertTrue(afk.release_session(self.home, record))
        self.assertEqual(
            afk._row(self.home, "p1")["task"], later, "the hold the project has now is not that one"
        )
        self.assertEqual(held_task(self.home).session_id, "gots-afk-s2")
        self.assertEqual(
            [write[1] for write in self.released()],
            [
                "/repos/mock-user/gots/issues/265/labels/gots-got-it",
                "/repos/mock-user/gots/issues/265/assignees",
            ],
            "only the closed session's own task comes off GitHub",
        )

    def test_a_session_started_by_hand_releases_nothing(self) -> None:
        self.assertFalse(
            afk.release_session(self.home, {"session_id": "gots-abc", "project_id": "p1"}),
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
                "name": "mock-user/gots",
                "repo_root": str(self.checkout),
                "path": "/trees/hand-made",
                "branch": "hermes/hand-made",
            }
        ]
        sessions._upsert(db_path(self.home), "gots-hand-made", "p1", repos, "auto", None)
        with patch.object(afk, "wake") as wake:
            self.ended(session_id="gots-hand-made", completed=True)
        self.assertEqual(self.shown()["task"], self.task)
        wake.assert_called_once()

    def test_a_record_that_lost_its_task_gives_back_the_hold_its_session_works(self) -> None:
        """A session gives back its own hold, never the project's oldest by accident.

        Two tasks in flight, and the newer one's record names neither of them — the shape a record
        written by an older build has. Its run finishing gives back the task *that* session worked,
        and leaves the older one, which something else is still working, exactly where it is.
        """
        newer = {
            **self.task,
            "number": 266,
            "title": "Task 266",
            "created_at": "2026-10-02T00:00:00Z",
        }
        afk._hold(self.home, "p1", newer)
        repos = [
            {
                "name": "mock-user/gots",
                "repo_root": str(self.checkout),
                "path": "/trees/afk-266",
                "branch": "hermes/afk-266",
            }
        ]
        sessions._upsert(db_path(self.home), "gots-afk-s2", "p1", repos, "auto", "/files/afk-266")
        afk._adopt(self.home, "p1", "gots-afk-s2", newer)
        sessions.set_task(db_path(self.home), "gots-afk-s2", None)
        self.assertIsNone(
            sessions.read(db_path(self.home), "gots-afk-s2")["task"],
            "the record names no task, which is what a run's end then has to go on",
        )

        self.ended("gots-afk-s2", completed=True)
        self.assertEqual(
            [hold.task["number"] for hold in afk._holds(self.home, "p1")],
            [265],
            "the newer task's hold goes and the older one's stays",
        )
        self.assertEqual(held_task(self.home).session_id, self.SESSION, "the older task is untouched")

    def test_giving_a_task_back_without_naming_one_frees_nothing(self) -> None:
        """A hold is given back by naming it, not by falling back on whichever is oldest."""
        afk._free(self.home, "p1")
        self.assertEqual(
            [hold.task["number"] for hold in afk._holds(self.home, "p1")],
            [265],
            "nothing named and no session behind it: the project's oldest is not a default",
        )


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

    def test_a_one_run_task_that_stopped_stalls(self) -> None:
        """A one-run task's whole work is its run, so a run that stopped is what leaves it stalled.

        This is the only way a task's run end is settled now: there is no stage to move on to, so a
        stopped run records why nothing is working the task and a finished one frees the hold.
        """
        self.aged(1)
        with patch("plugin.sessions._paths", return_value=(db_path(self.home), self.home)):
            afk.after_run(session_id=self.SESSION, completed=False, failed=True)
        self.assertIn(self.SESSION, afk.stalled(self.home), "its own reason stands in for the wait")

    def test_a_project_holding_nothing_stalls_nothing(self) -> None:
        afk._free(self.home, "p1", self.task)
        self.assertEqual(afk._holds(self.home, "p1"), [])
        self.assertEqual(afk.stalled(self.home), {})


class SessionTests(StartHarness):
    def setUp(self) -> None:
        super().setUp()
        set_on(self.home, "p1", self.folders(), True)
        afk._hold(self.home, "p1", self.task)

    def test_the_session_is_made_with_a_worktree_of_its_own_in_auto(self) -> None:
        self.start()
        self.assertEqual(len(self.ensured), 1)
        session_id, project_id, task, mode = self.ensured[0]
        self.assertEqual(project_id, "p1")
        self.assertEqual(task, self.task["title"], "the worktree is named after the task")
        self.assertEqual(mode, "auto", "an AFK session runs in Auto")
        self.assertTrue(session_id.startswith("gots-"), "a session id Gots's own hooks label")

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
        self.assertIsNone(sessions.read(db_path(self.home), "gots-afk-not-this-one"))

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
            "[Issue #265](https://github.com/mock-user/gots/issues/265)",
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
            "You are working in a git worktree of mock-user/gots",
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
        with patch.object(
            afk.host_model,
            "read_main",
            return_value={"provider": "openrouter", "model": "anthropic/claude-sonnet-4.5"},
        ):
            self.start()
        posted = self.posted[0]
        self.assertEqual(posted["path"], "/v1/runs")
        self.assertEqual(posted["body"]["session_id"], self.ensured[0][0])
        self.assertEqual(
            (posted["body"]["provider"], posted["body"]["model"]),
            ("openrouter", "anthropic/claude-sonnet-4.5"),
            "a session that has no model yet starts on the profile's own",
        )
        record = next(iter(self.chats().values()))["value"]
        self.assertEqual(
            record["modelChoice"],
            {"provider": "openrouter", "model": "anthropic/claude-sonnet-4.5"},
            "the record pins what the first run took, so the next run keeps it",
        )

    def test_a_host_that_names_no_model_posts_none(self) -> None:
        # Nothing to pin: the run names no model, exactly as every AFK run did before.
        with patch.object(afk.host_model, "read_main", return_value=None):
            self.start()
        self.assertNotIn("model", self.posted[0]["body"])
        self.assertNotIn(
            "modelChoice", next(iter(self.chats().values()))["value"], "and the record pins none"
        )

    def test_a_new_sessions_pin_is_the_profiles_not_a_record_left_at_its_id(self) -> None:
        """``start`` mints the session id, so no record of this session's can exist when the pin is
        read: the profile's main model is the only answer.
        """
        chats.merge(
            db_path(self.home),
            {
                "left-behind": {
                    "at": 1,
                    "value": {
                        "hermesSessionId": "gots-afk-fixed",
                        "modelChoice": {"provider": "deepseek", "model": "deepseek-v4-pro"},
                    },
                }
            },
        )
        with patch.object(afk, "new_session_id", return_value="gots-afk-fixed"), patch.object(
            afk.host_model,
            "read_main",
            return_value={"provider": "openrouter", "model": "anthropic/claude-sonnet-4.5"},
        ):
            self.start()
        self.assertEqual(
            (self.posted[0]["body"]["provider"], self.posted[0]["body"]["model"]),
            ("openrouter", "anthropic/claude-sonnet-4.5"),
            "a session that is starting runs the profile's model, whatever else names its id",
        )
        self.assertEqual(
            self.chats()["gots-afk-fixed"]["value"]["modelChoice"],
            {"provider": "openrouter", "model": "anthropic/claude-sonnet-4.5"},
            "and its record keeps the pick its run went out on",
        )

    def test_begin_hands_back_the_pin_beside_the_prompt(self) -> None:
        """The pin comes out of ``_begin`` with the rest of what a start takes off the project.

        Held as a local in ``start`` — as it was — it had to survive two blocks that can give the
        claim back, and only the fact that every failure there returns first kept it bound.
        """
        with patch.object(
            afk.host_model,
            "read_main",
            return_value={"provider": "openrouter", "model": "anthropic/claude-sonnet-4.5"},
        ):
            began = afk._begin(self.home, "p1")
        self.assertEqual(
            began.pinned, {"provider": "openrouter", "model": "anthropic/claude-sonnet-4.5"}
        )
        self.assertEqual(began.prompt, None, "and the Prompt the project wrote, if any")

    def test_the_pin_is_read_once_for_the_run_and_the_record(self) -> None:
        """One read answers both, so the run and the record it publishes can never disagree."""
        calls: List[Any] = []

        def read_main(config: Any) -> Dict[str, str]:
            calls.append(config)
            return {"provider": "openrouter", "model": "anthropic/claude-sonnet-4.5"}

        with patch.object(afk.host_model, "read_main", side_effect=read_main):
            self.start()
        self.assertEqual(len(calls), 1, "one read, not one per seam")
        self.assertEqual(
            (self.posted[0]["body"]["provider"], self.posted[0]["body"]["model"]),
            ("openrouter", "anthropic/claude-sonnet-4.5"),
        )
        self.assertEqual(
            next(iter(self.chats().values()))["value"]["modelChoice"],
            {"provider": "openrouter", "model": "anthropic/claude-sonnet-4.5"},
            "the record keeps the pick the run went out on",
        )

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
                ("DELETE", "/repos/mock-user/gots/issues/265/labels/gots-got-it", None),
                (
                    "DELETE",
                    "/repos/mock-user/gots/issues/265/assignees",
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
                patch.object(github, "origin_repo", return_value="mock-user/gots"),
                patch.object(github, "_get", lambda path, auth: {"login": "mock-user"}),
                patch.object(github, "_page", lambda path, auth: (rows, "")),
                patch.object(github, "_request", lambda *args, **kwargs: {}),
            ):
                set_on(home, "p1", [folder(str(checkout))], True)
                claimed = sweep(home, "p1", [folder(str(checkout))])
                self.assertEqual([task["number"] for task in claimed], [265])
                self.assertEqual(
                    sweep(home, "p1", [folder(str(checkout))]),
                    [],
                    "a project holding one is asked for nothing further",
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
            patch.object(github, "origin_repo", return_value="mock-user/gots"),
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
        task = {"repo": "mock-user/gots", "number": 265, "title": "Task 265"}
        second = {"repo": "mock-user/gots", "number": 266, "title": "Task 266"}
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
        self.task = {"repo": "mock-user/gots", "number": 265, "title": "Task 265"}
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
        second = {"repo": "mock-user/gots", "number": 266, "title": "Task 266"}
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
        second = {"repo": "mock-user/gots", "number": 266, "title": "Task 266"}
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

    def test_raising_a_number_wakes_the_sweep_and_lowering_it_does_not(self) -> None:
        """Only a raise makes a place the sweep should fill; a lower frees none, so it buys no pass."""
        tmp = TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        home = Path(tmp.name)
        afk.set_pick_count(home, "p1", 1)
        afk.set_pick_budget(home, 3)
        with patch.object(afk, "wake") as wake:
            afk.set_pick_count(home, "p1", 3)
            afk.set_pick_budget(home, 5)
        self.assertEqual(wake.call_count, 2, "each raise asks the sweep to fill what it just made")
        with patch.object(afk, "wake") as wake:
            afk.set_pick_count(home, "p1", 1)
            afk.set_pick_budget(home, 2)
        wake.assert_not_called()


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
        "repo": "mock-user/gots",
        "number": 265,
        "title": "The frontier is read from GitHub and listed",
        "url": "https://github.com/mock-user/gots/issues/265",
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
            "session_id": "gots-afk-265",
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
        self.assertEqual(holds[0].session_id, "gots-afk-265", "the session working it comes along")
        self.assertEqual(holds[0].claimed_at, 1_700_000_100, "and the clock it was claimed on")
        self.assertEqual(holds[0].stalled, "The run failed.")
        self.assertEqual(holds[0].stalled_at, 1_700_000_200)

    def test_the_project_keeps_its_switch_and_what_it_works_with(self) -> None:
        self.v38()
        shown = afk.read(self.home, "p1", [])
        self.assertTrue(shown["on"], "the switch is still the row's")
        self.assertEqual(shown["prompt"], "Work in checkpoints.")
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
        self.assertEqual(holds[0].session_id, "gots-afk-265")


    OLD_SESSIONS = """CREATE TABLE project_sessions (
        session_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        repo_root TEXT NOT NULL,
        path TEXT,
        branch TEXT,
        mode TEXT NOT NULL DEFAULT 'accept_edits',
        plan_pending INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        repos TEXT,
        plan_file TEXT,
        files_dir TEXT,
        task TEXT,
        theseus TEXT,
        pipeline TEXT
    )"""

    OLD_WORKFLOWS = """CREATE TABLE workflows (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        body TEXT NOT NULL,
        preset INTEGER NOT NULL DEFAULT 0,
        version TEXT,
        deleted INTEGER NOT NULL DEFAULT 0,
        at INTEGER NOT NULL
    )"""

    def v57(self) -> None:
        """A store as v57 left it: a project on a workflow, a held task, a staged session."""
        path = db_path(self.home)
        path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(path)
        try:
            conn.execute(self.OLD_AFK)
            for column in ("pick_count", "prompt_id"):
                conn.execute(f"ALTER TABLE project_afk ADD COLUMN {column}")
            conn.execute(
                """INSERT INTO project_afk
                       (project_id, enabled, at, task, claimed_at, refusal, refused_at, session_id,
                        stalled, stalled_at, build_skill, critique_skills, workflow_id, prompt,
                        pick_count, prompt_id)
                   VALUES ('p1', 1, 1700000000, ?, 1700000100, 'GitHub said no.', 1700000200,
                           'gots-afk-265', 'The run failed.', 1700000300, 'planning', '["review"]',
                           'wf-1', 'Work in checkpoints.', 3, 'lib-1')""",
                (json.dumps(self.HELD),),
            )
            conn.execute(self.OLD_SESSIONS)
            conn.execute(
                """INSERT INTO project_sessions
                       (session_id, project_id, repo_root, path, branch, mode, plan_pending,
                        created_at, repos, plan_file, files_dir, task, theseus, pipeline)
                   VALUES ('gots-afk-265', 'p1', '/repos/gots', '/worktrees/265', 'hermes/265', 'auto',
                           1, 1700000400, ?, 'PLAN.md', '/files/265', ?, 'theseus-on',
                           '{"stage": 1, "round": 1, "stages": []}')""",
                (
                    json.dumps([{"name": "gots", "repo_root": "/repos/gots", "path": "/worktrees/265", "branch": "hermes/265"}]),
                    json.dumps(self.HELD),
                ),
            )
            conn.execute(self.OLD_WORKFLOWS)
            conn.execute(
                """CREATE TABLE holds (
                       project_id TEXT NOT NULL,
                       task TEXT NOT NULL,
                       repo TEXT NOT NULL,
                       number INTEGER NOT NULL,
                       created_at TEXT,
                       claimed_at INTEGER,
                       session_id TEXT,
                       stalled TEXT,
                       stalled_at INTEGER,
                       PRIMARY KEY (project_id, repo, number)
                   )"""
            )
            # The hold is a row, as v40 made it: the `task` column the row above still carries is
            # the dead one, and the upgrade must read the table rather than the column.
            conn.execute(
                """INSERT INTO holds
                       (project_id, task, repo, number, created_at, claimed_at, session_id)
                   VALUES ('p1', ?, 'mock-user/gots', 265, '2026-10-01T00:00:00Z', 1700000100,
                           'gots-afk-265')""",
                (json.dumps(self.HELD),),
            )
            conn.execute(
                """INSERT INTO workflows (id, name, body, preset, version, deleted, at)
                   VALUES ('wf-1', 'Mine', '{"stages": []}', 0, NULL, 0, 1700000000)"""
            )
            conn.execute("PRAGMA user_version = 57")
            conn.commit()
        finally:
            conn.close()

    def test_a_v57_store_loses_the_library_and_the_staged_columns(self) -> None:
        self.v57()
        # Reading through the plugin is what opens the store, and so what migrates it.
        self.assertTrue(afk.read(self.home, "p1", [])["on"])
        conn = sqlite3.connect(db_path(self.home))
        try:
            afk_columns = {row[1] for row in conn.execute("PRAGMA table_info(project_afk)")}
            session_columns = {row[1] for row in conn.execute("PRAGMA table_info(project_sessions)")}
            tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
            kept_afk = conn.execute("SELECT * FROM project_afk WHERE project_id = 'p1'").fetchone()
            kept_session = conn.execute(
                "SELECT * FROM project_sessions WHERE session_id = 'gots-afk-265'"
            ).fetchone()
            afk_names = [row[1] for row in conn.execute("PRAGMA table_info(project_afk)")]
            session_names = [row[1] for row in conn.execute("PRAGMA table_info(project_sessions)")]
        finally:
            conn.close()
        self.assertEqual(
            session_columns & {"pipeline"}, set(), "the stage record's column is gone"
        )
        self.assertEqual(
            afk_columns & {"workflow_id", "build_skill", "critique_skills"},
            set(),
            "the library's pick and the two skill columns are gone",
        )
        self.assertNotIn("workflows", tables, "the library's table is gone")
        # What AFK still works by is carried over value for value: this table is every session's
        # row and every project's switch, and a rebuild that lost one would lose a worktree.
        self.assertEqual(
            dict(zip(afk_names, kept_afk)),
            {
                "project_id": "p1",
                "enabled": 1,
                "at": 1_700_000_000,
                "task": json.dumps(self.HELD),
                "claimed_at": 1_700_000_100,
                "refusal": "GitHub said no.",
                "refused_at": 1_700_000_200,
                "session_id": "gots-afk-265",
                "stalled": "The run failed.",
                "stalled_at": 1_700_000_300,
                "prompt": "Work in checkpoints.",
                "pick_count": 3,
                "prompt_id": "lib-1",
            },
        )
        self.assertEqual(
            dict(zip(session_names, kept_session)),
            {
                "session_id": "gots-afk-265",
                "project_id": "p1",
                "repo_root": "/repos/gots",
                "path": "/worktrees/265",
                "branch": "hermes/265",
                "mode": "auto",
                "plan_pending": 1,
                "created_at": 1_700_000_400,
                "repos": json.dumps(
                    [
                        {
                            "name": "gots",
                            "repo_root": "/repos/gots",
                            "path": "/worktrees/265",
                            "branch": "hermes/265",
                        }
                    ]
                ),
                "plan_file": "PLAN.md",
                "files_dir": "/files/265",
                "task": json.dumps(self.HELD),
                "theseus": "theseus-on",
            },
        )

    def test_a_v57_session_reads_back_without_a_pipeline(self) -> None:
        self.v57()
        record = sessions.read(db_path(self.home), "gots-afk-265")
        self.assertIsNotNone(record)
        self.assertNotIn("pipeline", record, "nothing names a stage any more")
        self.assertEqual(record["task"], self.HELD, "and the task it was started for is still there")
        held = afk.read(self.home, "p1", [])
        self.assertEqual(held["prompt"], "Work in checkpoints.")
        self.assertEqual(held["pick_count"], 3)
        self.assertEqual([hold["number"] for hold in held["holds"]], [265], "its hold came along")


    def test_a_store_past_v40_does_not_carry_its_dead_task_again(self) -> None:
        """A task the project freed after v40 must not come back when the store moves past 57.

        `project_afk.task` has been dead since v40 and nothing clears it, so a store already past
        40 keeps its holds in `holds`, not in the column. Reading the column again on a later
        upgrade invents a hold nobody is working — a Working row the app draws, a place taken from
        the pick count, and a stall reported for a session that ended long ago.
        """
        path = db_path(self.home)
        path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(path)
        try:
            conn.execute(self.OLD_AFK)
            for column in ("pick_count", "prompt_id"):
                conn.execute(f"ALTER TABLE project_afk ADD COLUMN {column}")
            conn.execute(
                """INSERT INTO project_afk
                       (project_id, enabled, at, task, claimed_at, session_id, prompt)
                   VALUES ('p1', 1, 1700000000, ?, 1700000100, 'gots-afk-265', 'Work.')""",
                (json.dumps(self.HELD),),
            )
            conn.execute(
                """CREATE TABLE holds (
                       project_id TEXT NOT NULL,
                       task TEXT NOT NULL,
                       repo TEXT NOT NULL,
                       number INTEGER NOT NULL,
                       created_at TEXT,
                       claimed_at INTEGER,
                       session_id TEXT,
                       stalled TEXT,
                       stalled_at INTEGER,
                       PRIMARY KEY (project_id, repo, number)
                   )"""
            )
            conn.execute("PRAGMA user_version = 57")
            conn.commit()
        finally:
            conn.close()

        self.assertEqual(afk._holds(self.home, "p1"), [], "a freed task is not a hold")


class FeatureTests(unittest.TestCase):
    """What this plugin tells an app it can do."""

    def source(self) -> str:
        return (Path(afk.__file__).parent / "__init__.py").read_text()

    def test_the_plugin_advertises_afk_picks(self) -> None:
        """The one flag every pick control gates on: an app behind it draws today's sheet, so the
        name has to be in the features array a real host answers."""
        self.assertRegex(self.source(), r'\n\s+"afk_picks",\n')

    def test_the_plugin_advertises_neither_afk_workflows_nor_afk_skills(self) -> None:
        """The library and the legacy pickers are gone, so no app gates a control on either."""
        source = self.source()
        self.assertFalse("afk_workflows" in source, "afk_workflows is still advertised")
        self.assertFalse("afk_skills" in source, "afk_skills is still advertised")


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
        self.assertIn('"object": "gots.afk.bot"', self.source)

    def test_it_reads_and_writes_the_bots_own_store(self) -> None:
        for call in ("afk.bot_read", "afk.bot_writes", "afk.write_bot"):
            with self.subTest(call=call):
                self.assertIn(call, self.source)

    def test_the_librarys_five_routes_are_gone(self) -> None:
        """The library went with its routes, so nothing registers or answers a /workflows path."""
        self.assertFalse("/workflows" in self.source, "a /workflows route is still registered")


if __name__ == "__main__":
    unittest.main()
