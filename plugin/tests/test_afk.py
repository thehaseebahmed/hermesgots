"""AFK's switch: whether a project is left to work its own tasks, and why it can't be.

The switch lives in the plugin's store, so these drive a throwaway Hermes home and read it back
through the plugin's own calls; GitHub is patched, and ``hermes_cli.projects_db`` is stubbed the way
the usage tests stub it, since the plugin only ever sees it on a real host.

Run: python3 -m unittest plugin.tests.test_afk -v
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import ModuleType, SimpleNamespace
from typing import Any, List
from unittest.mock import patch

from plugin import afk, github, projects
from plugin.afk import (
    ARCHIVED,
    NO_GITHUB,
    NO_REPOSITORY,
    Refused,
    held,
    is_on,
    read,
    refusal,
    set_on,
    state,
    sweep,
    sweep_all,
)
from plugin.tasks import CLAIM_LABEL, READY_LABEL
from plugin.tests._helpers import stub_projects_db


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
        self.assertEqual(state(self.home, "p1", self.folders()), {"on": False, "reason": None})
        self.assertFalse(is_on(self.home, "p1"))

    def test_turning_it_on_is_read_back_from_the_host(self) -> None:
        self.assertEqual(set_on(self.home, "p1", self.folders(), True)["on"], True)
        self.assertTrue(is_on(self.home, "p1"))
        # A fresh read — the app's own, from another device — is the host's answer, not the device's.
        self.assertEqual(state(self.home, "p1", self.folders()), {"on": True, "reason": None})

    def test_turning_it_off_again(self) -> None:
        set_on(self.home, "p1", self.folders(), True)
        self.assertEqual(set_on(self.home, "p1", self.folders(), False)["on"], False)
        self.assertFalse(is_on(self.home, "p1"))

    def test_one_projects_switch_does_not_touch_anothers(self) -> None:
        set_on(self.home, "p1", self.folders(), True)
        self.assertFalse(is_on(self.home, "p2"))
        set_on(self.home, "p2", self.folders(), True)
        set_on(self.home, "p2", self.folders(), False)
        self.assertTrue(is_on(self.home, "p1"))

    def test_a_project_with_no_repository_says_why(self) -> None:
        plain = self.home / "plain"
        plain.mkdir()
        self.assertEqual(
            state(self.home, "p1", self.folders(str(plain))),
            {"on": False, "reason": NO_REPOSITORY},
        )

    def test_a_project_with_no_repository_cannot_be_turned_on(self) -> None:
        plain = self.home / "plain"
        plain.mkdir()
        with self.assertRaises(Refused) as raised:
            set_on(self.home, "p1", self.folders(str(plain)), True)
        self.assertEqual(str(raised.exception), NO_REPOSITORY)
        self.assertFalse(is_on(self.home, "p1"))

    def test_a_host_without_github_says_why(self) -> None:
        with patch.object(github, "token", return_value=(None, None)):
            self.assertEqual(
                state(self.home, "p1", self.folders()), {"on": False, "reason": NO_GITHUB}
            )
            with self.assertRaises(Refused) as raised:
                set_on(self.home, "p1", self.folders(), True)
        self.assertEqual(str(raised.exception), NO_GITHUB)
        self.assertFalse(is_on(self.home, "p1"))

    def test_a_project_with_no_repository_is_not_asked_github_about(self) -> None:
        plain = self.home / "plain"
        plain.mkdir()
        with patch.object(github, "token") as token:
            state(self.home, "p1", self.folders(str(plain)))
        token.assert_not_called()

    def test_turning_it_off_is_allowed_even_where_it_cannot_be_on(self) -> None:
        set_on(self.home, "p1", self.folders(), True)
        # The account it was left to work with is gone, so turning it back on would be refused — but
        # putting the project back to work is the user's to do, and always allowed.
        with patch.object(github, "token", return_value=(None, None)):
            with self.assertRaises(Refused):
                set_on(self.home, "p1", self.folders(), True)
            self.assertEqual(set_on(self.home, "p1", self.folders(), False)["on"], False)
        self.assertFalse(is_on(self.home, "p1"))

    def test_an_archived_project_reads_off_whatever_its_row_says(self) -> None:
        # Archived somewhere this plugin didn't do it — Hermes's own dashboard or CLI — so the row is
        # still there; the sheet must not show a switch that would never be acted on, and reading it
        # off is what keeps a restore from resuming work nobody asked for.
        set_on(self.home, "p1", self.folders(), True)
        self.assertEqual(
            state(self.home, "p1", self.folders(), archived=True),
            {"on": False, "reason": ARCHIVED},
        )
        self.assertFalse(is_on(self.home, "p1"), "the row is written off, not only masked")
        self.assertEqual(
            state(self.home, "p1", self.folders()),
            {"on": False, "reason": None},
            "restoring it starts off",
        )

    def test_a_project_left_on_keeps_its_switch_when_its_reason_comes_back(self) -> None:
        set_on(self.home, "p1", self.folders(), True)
        with patch.object(github, "token", return_value=(None, None)):
            # Still on — the switch is the user's to turn off — but the host now says why it can't work.
            self.assertEqual(
                state(self.home, "p1", self.folders()), {"on": True, "reason": NO_GITHUB}
            )

    def test_archiving_a_project_turns_its_switch_off(self) -> None:
        stub = self.stub_projects()
        set_on(self.home, "p1", self.folders(), True)
        projects.update(self.home, "p1", None, None, archived=True)
        self.assertEqual(stub.archived, ["p1"])
        self.assertFalse(is_on(self.home, "p1"))

    def test_editing_a_project_leaves_its_switch_alone(self) -> None:
        self.stub_projects()
        set_on(self.home, "p1", self.folders(), True)
        projects.update(self.home, "p1", "A new name", "And a description")
        self.assertTrue(is_on(self.home, "p1"), "renaming a project doesn't put it away")
        projects.update(self.home, "p1", None, None, archived=False)
        self.assertTrue(is_on(self.home, "p1"), "restoring one that wasn't archived leaves it be")

    def test_an_archived_project_says_why(self) -> None:
        with patch.object(github, "token") as token:
            self.assertEqual(
                state(self.home, "p1", self.folders(), archived=True),
                {"on": False, "reason": ARCHIVED},
            )
        # Put away before its repositories or the account are looked at: neither can matter.
        token.assert_not_called()

    def test_an_archived_project_cannot_be_turned_on(self) -> None:
        with self.assertRaises(Refused) as raised:
            set_on(self.home, "p1", self.folders(), True, archived=True)
        self.assertEqual(str(raised.exception), ARCHIVED)
        self.assertFalse(is_on(self.home, "p1"))
        # Turning it off is always the user's to do, and this is the state it should be in anyway.
        self.assertEqual(set_on(self.home, "p1", self.folders(), False, archived=True)["on"], False)

    def test_deleting_a_project_forgets_its_switch(self) -> None:
        self.stub_projects()
        (self.home / "projects.db").write_text("")
        set_on(self.home, "p1", self.folders(), True)
        projects.remove(self.home, "p1")
        self.assertFalse(is_on(self.home, "p1"))

    def test_a_project_that_was_not_deleted_keeps_its_switch(self) -> None:
        self.stub_projects(deleted=False)
        (self.home / "projects.db").write_text("")
        set_on(self.home, "p1", self.folders(), True)
        projects.remove(self.home, "p1")
        self.assertTrue(is_on(self.home, "p1"))

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
        self.read_error: Exception | None = None
        self.paths: List[str] = []
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

    def sweep(self) -> dict:
        return sweep(self.home, "p1", self.folders())

    def issue(
        self,
        number: int,
        *,
        created: str = "2026-10-01T00:00:00Z",
        labels: tuple = (READY_LABEL,),
        assignees: tuple = (),
    ) -> dict:
        """An open issue as GitHub's list answers it."""
        return {
            "number": number,
            "title": f"Task {number}",
            "html_url": f"https://github.com/mock-user/memento/issues/{number}",
            "state": "open",
            "created_at": created,
            "body": "",
            "labels": [{"name": name} for name in labels],
            "assignees": [{"login": login} for login in assignees],
            "issue_dependencies_summary": {"total_blocked_by": 0, "blocked_by": 0},
        }

    def answer_get(self, path: str, auth: Any) -> Any:
        self.paths.append(path)
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
        if self.write_error is not None:
            raise self.write_error
        return {}

    def test_the_oldest_ready_task_is_assigned_and_marked(self) -> None:
        self.on()
        self.issues = [
            self.issue(266, created="2026-10-02T00:00:00Z"),
            self.issue(265, created="2026-10-01T00:00:00Z"),
        ]
        self.sweep()
        self.assertEqual(held(self.home, "p1")["number"], 265, "the oldest is the one AFK takes")
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
        self.issues = [self.issue(265)]
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
            self.issue(265, labels=(READY_LABEL, CLAIM_LABEL)),
            self.issue(266, created="2026-10-02T00:00:00Z"),
        ]
        self.sweep()
        self.assertEqual(held(self.home, "p1")["number"], 266, "the next ready one is taken")

    def test_one_task_at_a_time_even_when_several_are_ready(self) -> None:
        self.on()
        self.issues = [
            self.issue(265),
            self.issue(266, created="2026-10-02T00:00:00Z"),
            self.issue(267, created="2026-10-03T00:00:00Z"),
        ]
        self.sweep()
        asked = len(self.writes)
        self.sweep()
        self.assertEqual(held(self.home, "p1")["number"], 265, "the task it holds is still its own")
        self.assertEqual(len(self.writes), asked, "the second sweep claims nothing while one is held")

    def test_nothing_is_claimed_before_the_switch_is_on(self) -> None:
        self.issues = [self.issue(265)]
        self.assertIsNone(self.sweep())
        self.assertEqual(self.writes, [], "a project that isn't left to work is never swept")

    def test_a_refusal_stops_the_sweep_with_the_switch_left_on_and_its_reason_kept(self) -> None:
        self.on()
        self.issues = [self.issue(265), self.issue(266, created="2026-10-02T00:00:00Z")]
        self.write_error = github.GitHubError("Resource not accessible by personal access token", 403)
        shown = self.sweep()
        self.assertIsNone(held(self.home, "p1"), "a task GitHub refused is not held")
        self.assertEqual(shown["refusal"], "Resource not accessible by personal access token")
        self.assertTrue(shown["on"], "a GitHub refusal doesn't turn the project off")
        self.assertTrue(is_on(self.home, "p1"), "the switch stays on")
        self.assertEqual(len(self.writes), 1, "and the sweep stops rather than working the rest")

    def test_a_read_github_refuses_is_recorded_too(self) -> None:
        self.on()
        self.read_error = github.GitHubError("API rate limit exceeded for 1.2.3.4.", 403)
        shown = self.sweep()
        self.assertEqual(shown["refusal"], "API rate limit exceeded for 1.2.3.4.")
        self.assertTrue(is_on(self.home, "p1"))
        self.assertEqual(self.writes, [])

    def test_a_successful_sweep_clears_the_last_refusal(self) -> None:
        self.on()
        self.issues = [self.issue(265)]
        self.write_error = github.GitHubError("GitHub answered 403.", 403)
        self.assertEqual(self.sweep()["refusal"], "GitHub answered 403.")
        self.write_error = None
        self.assertIsNone(self.sweep()["refusal"], "GitHub answered, so the reason is stale")
        self.assertEqual(held(self.home, "p1")["number"], 265)

    def test_an_empty_frontier_holds_nothing_and_clears_an_old_refusal(self) -> None:
        self.on()
        self.read_error = github.GitHubError("Couldn't reach GitHub from the server.")
        self.assertEqual(self.sweep()["refusal"], "Couldn't reach GitHub from the server.")
        self.read_error = None
        self.issues = []
        shown = self.sweep()
        self.assertIsNone(held(self.home, "p1"))
        self.assertIsNone(shown["refusal"])
        self.assertEqual(self.writes, [])

    def test_the_app_reads_the_task_held_and_the_last_refusal(self) -> None:
        self.on()
        self.issues = [self.issue(265)]
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

    def test_a_profiles_home_is_watched_once_and_swept_beside_the_loops_own(self) -> None:
        """A bot at /p/<profile> keeps its own store, added when its sheet is read or written."""
        with patch.object(afk, "_watched", set()):
            afk.watch(Path("/profiles/work"))
            afk.watch(Path("/profiles/work"))
            self.assertEqual(
                afk.homes(Path("/default")),
                [Path("/default"), Path("/profiles/work")],
            )


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
