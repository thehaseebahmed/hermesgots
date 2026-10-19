"""AFK's switch: whether a project is left to work its own tasks, and why it can't be.

The switch lives in the plugin's store, so these drive a throwaway Hermes home and read it back
through the plugin's own calls; GitHub is patched, and ``hermes_cli.projects_db`` is stubbed the way
the usage tests stub it, since the plugin only ever sees it on a real host.

Run: python3 -m unittest plugin.tests.test_afk -v
"""

from __future__ import annotations

import asyncio
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import ModuleType, SimpleNamespace
from typing import Any, Dict, List
from unittest.mock import patch

from plugin import afk, chats, github, outbox, projects, prompt_builder, sessions
from plugin.afk import (
    ARCHIVED,
    NO_GITHUB,
    NO_REPOSITORY,
    Refused,
    read,
    set_on,
    sweep,
    sweep_all,
)
from plugin.store import db_path
from plugin.tasks import CLAIM_LABEL, READY_LABEL
from plugin.tests._helpers import issue_row, stub_projects_db


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
        self.assertEqual(read(self.home, "p1", self.folders()), {"on": False, "reason": None, "task": None, "refusal": None})
        self.assertFalse(read(self.home, "p1", self.folders())["on"])

    def test_turning_it_on_is_read_back_from_the_host(self) -> None:
        self.assertEqual(set_on(self.home, "p1", self.folders(), True)["on"], True)
        self.assertTrue(read(self.home, "p1", self.folders())["on"])
        # A fresh read — the app's own, from another device — is the host's answer, not the device's.
        self.assertEqual(read(self.home, "p1", self.folders()), {"on": True, "reason": None, "task": None, "refusal": None})

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
            {"on": False, "reason": NO_REPOSITORY, "task": None, "refusal": None},
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
                read(self.home, "p1", self.folders()), {"on": False, "reason": NO_GITHUB, "task": None, "refusal": None}
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
            {"on": False, "reason": ARCHIVED, "task": None, "refusal": None},
        )
        self.assertFalse(read(self.home, "p1", self.folders())["on"], "the row is written off, not only masked")
        self.assertEqual(
            read(self.home, "p1", self.folders()),
            {"on": False, "reason": None, "task": None, "refusal": None},
            "restoring it starts off",
        )

    def test_a_project_left_on_keeps_its_switch_when_its_reason_comes_back(self) -> None:
        set_on(self.home, "p1", self.folders(), True)
        with patch.object(github, "token", return_value=(None, None)):
            # Still on — the switch is the user's to turn off — but the host now says why it can't work.
            self.assertEqual(
                read(self.home, "p1", self.folders()), {"on": True, "reason": NO_GITHUB, "task": None, "refusal": None}
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
                {"on": False, "reason": ARCHIVED, "task": None, "refusal": None},
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
        projects.remove(self.home, "p1")
        self.assertFalse(read(self.home, "p1", self.folders())["on"])

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


class ClaimTests(unittest.TestCase):
    """The sweep: the oldest ready task assigned and marked on GitHub, one at a time.

    GitHub is the plugin's HTTP stub, as the frontier's read is tested: ``_get``/``_page`` answer the
    reads and ``_request`` records the writes, so what's asserted is what AFK would leave on the
    tracker rather than how the module is arranged.
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

    def sweep(self) -> None:
        sweep(self.home, "p1", self.folders())

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

    def test_one_task_at_a_time_even_when_several_are_ready(self) -> None:
        self.on()
        self.issues = [
            issue_row(265),
            issue_row(266, created="2026-10-02T00:00:00Z"),
            issue_row(267, created="2026-10-03T00:00:00Z"),
        ]
        self.sweep()
        asked = len(self.writes)
        self.sweep()
        self.assertEqual(self.shown()["task"]["number"], 265, "the task it holds is still its own")
        self.assertEqual(len(self.writes), asked, "the second sweep claims nothing while one is held")

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
        """Releasing a claim is #270's; the sweep's half is that a freed project takes the next one."""
        self.on()
        self.issues = [issue_row(265), issue_row(266, created="2026-10-02T00:00:00Z")]
        self.sweep()
        self.assertEqual(self.shown()["task"]["number"], 265)
        # The claim released (its own ticket): the row stops holding anything, as #270 will write it.
        afk._update(self.home, "p1", task=None, claimed_at=None)
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
        }
        self.ensured: List[tuple] = []
        self.posted: List[dict] = []
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
            patch("plugin.sessions.ensure", side_effect=self.ensure),
            patch("plugin.sessions.apply_cwd"),
            patch("plugin.outbox.post", side_effect=self.post),
        ):
            one.start()
            self.addCleanup(one.stop)
        set_on(self.home, "p1", [folder(str(self.home / "checkout"))], True)
        afk._hold(self.home, "p1", self.task)

    def ensure(self, path: Any, home: Any, session_id: str, project_id: Any, task: Any, mode: Any) -> dict:
        self.ensured.append((session_id, project_id, task, mode))
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
        self.assertGreater(
            value["updatedAt"],
            value["createdAt"],
            "a record whose updated time isn't newer is hidden by the Code list",
        )
        self.assertGreaterEqual(entry["at"], value["updatedAt"], "the change clock is the record's")

    def test_the_project_row_names_the_session_working_its_task(self) -> None:
        self.start()
        session_id = self.ensured[0][0]
        self.assertEqual(
            afk.task_for_session(self.home, session_id),
            self.task,
            "the host keeps which session works which task, for the pull request that closes it",
        )
        self.assertIsNone(afk.task_for_session(self.home, "memento-afk-not-this-one"))

    def test_a_run_that_never_started_names_no_session(self) -> None:
        outbox.post.side_effect = outbox.StartError("No API key for this bot.", True)
        self.start()
        self.assertIsNone(
            afk.task_for_session(self.home, self.ensured[0][0]),
            "a session nothing was sent in is not the one working the task",
        )

    def test_the_run_starts_with_one_line_naming_the_issue_and_where_it_is(self) -> None:
        self.start()
        self.assertEqual(len(self.posted), 1)
        body = self.posted[0]["body"]
        message = body["input"][0]
        self.assertEqual(message["role"], "user")
        self.assertEqual(
            message["content"],
            "Implement Issue #265 (https://github.com/mock-user/memento/issues/265)",
            "the input is the issue and its url, not its text",
        )

    def test_the_instructions_are_the_afk_prompt_and_carry_no_task_text(self) -> None:
        self.start()
        instructions = self.posted[0]["body"]["instructions"]
        record = {**self.record, "session_id": self.ensured[0][0], "project_id": "p1", "mode": "auto"}
        self.assertEqual(
            instructions,
            prompt_builder.afk_prompt(record, self.task),
            "one module owns every word the agent is told",
        )
        self.assertIn("Never ask the user anything", instructions)
        self.assertIn("delegate_task", instructions)
        self.assertIn("gh issue view", instructions, "it fetches the issue itself")
        self.assertIn(
            "You are working in a git worktree of mock-user/memento",
            instructions,
            "the session's own prompt is kept, so its worktree and pull request lines still hold",
        )
        self.assertNotIn("Read the frontier first.", instructions, "the issue's text isn't copied in")

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

    def test_a_session_that_cannot_be_made_starts_no_run(self) -> None:
        with patch("plugin.sessions.ensure", side_effect=sessions.WorkspaceError("No such project.")):
            self.start()
        self.assertEqual(self.posted, [], "nothing is started for a session that doesn't exist")
        self.assertEqual(self.chats(), {}, "and nothing is published to be opened")

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
                self.assertEqual(sweep(home, "p1", [folder(str(checkout))])["number"], 265)
                self.assertIsNone(
                    sweep(home, "p1", [folder(str(checkout))]),
                    "a project holding one is asked for nothing further",
                )


class SweepAllTests(unittest.TestCase):
    """Which projects the background sweep looks at."""

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

    def test_a_project_left_on_is_swept_and_one_that_is_off_is_not(self) -> None:
        set_on(self.home, "p1", [folder(str(self.checkout))], True)
        with stub_projects_db(projects=[self.project("p1"), self.project("p2")]):
            with patch.object(afk, "sweep") as sweep:
                sweep_all(self.home)
        self.assertEqual([call.args[1] for call in sweep.call_args_list], ["p1"])

    def test_a_project_whose_record_is_gone_is_left_alone(self) -> None:
        set_on(self.home, "p1", [folder(str(self.checkout))], True)
        with stub_projects_db(projects=[]):
            with patch.object(afk, "sweep") as sweep:
                sweep_all(self.home)
        sweep.assert_not_called()

    def test_a_failing_project_does_not_stop_the_next_one(self) -> None:
        set_on(self.home, "p1", [folder(str(self.checkout))], True)
        set_on(self.home, "p2", [folder(str(self.checkout))], True)
        with stub_projects_db(projects=[self.project("p1"), self.project("p2")]):
            with patch.object(afk, "sweep", side_effect=[RuntimeError("database is locked"), None]) as call:
                sweep_all(self.home)
        self.assertEqual([one.args[1] for one in call.call_args_list], ["p1", "p2"])

    def test_a_sweep_answers_the_tasks_it_just_claimed(self) -> None:
        set_on(self.home, "p1", [folder(str(self.checkout))], True)
        task = {"repo": "mock-user/memento", "number": 265, "title": "Task 265"}
        with stub_projects_db(projects=[self.project("p1"), self.project("p2")]):
            with patch.object(afk, "sweep", side_effect=[task, None]):
                claimed = sweep_all(self.home)
        self.assertEqual(claimed, [("p1", task)], "only what was claimed is answered")


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


if __name__ == "__main__":
    unittest.main()
