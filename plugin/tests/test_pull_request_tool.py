"""Tests for the pull_request tool: its actions, always-draft pull requests, force pushes,
title/body updates, and the refusal of merge and close."""

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from plugin import pipeline, ship
from plugin.store import db_path


def _record(tmp):
    return {
        "session_id": "s1",
        "repos": [
            {
                "name": "repo1",
                "path": tmp,
                "repo_root": tmp,
                "branch": "hermes/s1",
                "base": "main",
            }
        ],
    }


def _state(changed=False, unpushed=0, pushed=True, ahead=0):
    return {
        "name": "repo1",
        "base": "main",
        "changed": changed,
        "unpushed": unpushed,
        "pushed": pushed,
        "ahead": ahead,
    }


class _Base(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = self._tmp.name
        self.db = Path(self.tmp) / "memento.db"
        self.db.touch()

    def tearDown(self):
        self._tmp.cleanup()

    def _call(self, args, record=None):
        record = record or _record(self.tmp)
        with (
            patch("plugin.sessions._paths", return_value=(self.db, Path(self.tmp))),
            patch("plugin.sessions.record_for_call", return_value=record),
        ):
            return json.loads(ship.handle(args, task_id="s1", session_id="s1"))


class DraftTests(_Base):
    def test_open_pr_is_always_a_draft_even_if_asked_otherwise(self):
        """No draft parameter exists, so the PR is created as a draft regardless."""
        self.assertNotIn("draft", ship.SCHEMA["parameters"]["properties"])
        with (
            patch("plugin.ship.status", return_value=[_state(changed=True)]),
            patch("plugin.ship._commit", return_value="abc1234"),
            patch("plugin.ship._repo_status", return_value=_state(changed=True)),
            patch("plugin.ship._push"),
            patch("plugin.ship._lock") as lock,
            patch("plugin.github.pull_request", return_value=None),
            patch("plugin.github.token", return_value=("tok", "u")),
            patch("plugin.github.origin_repo", return_value="o/r"),
            patch("plugin.github.create_pull_request") as create,
        ):
            lock.return_value.acquire.return_value = True
            create.return_value = {"number": 1, "state": "draft", "title": "T", "url": "u"}
            ship.ship(Path(self.tmp), "s1", _record(self.tmp), "msg", "T", "B", True, False)
        self.assertTrue(create.called)
        self.assertIs(create.call_args.args[5], True)


class ForceTests(_Base):
    def _push_args(self, calls):
        return [call for call in calls if "push" in call][0]

    def test_force_leases_against_the_commit_we_last_knew(self):
        """--force-with-lease compares GitHub against a commit this tree knew before now; nothing
        refreshes that answer on the way, or the guard would always match."""
        calls = []

        def fake_run(tree, args, env=None):
            calls.append(args)
            return MagicMock(returncode=0, stderr="", stdout="")

        with (
            patch("plugin.ship._run", side_effect=fake_run),
            patch("plugin.ship._ref_sha", return_value="cafe1234"),
            patch("plugin.github.token", return_value=("tok", "u")),
            patch("plugin.github.git_auth_args", return_value=[]),
        ):
            ship._push(Path(self.tmp), self.tmp, "hermes/s1", force=True)
        push = self._push_args(calls)
        self.assertIn("--force-with-lease=refs/heads/hermes/s1:cafe1234", push)
        self.assertFalse(any("fetch" in call or "ls-remote" in call for call in calls), calls)

    def test_force_refuses_a_branch_this_tree_has_never_looked_at(self):
        """No commit to check against and a branch on GitHub: overwriting it would be blind."""
        calls = []

        def fake_run(tree, args, env=None):
            calls.append(args)
            return MagicMock(returncode=0, stderr="", stdout="")

        with (
            patch("plugin.ship._run", side_effect=fake_run),
            patch("plugin.ship._ref_sha", return_value=None),
            patch("plugin.ship._remote_sha", return_value="deadbeef"),
            patch("plugin.github.token", return_value=("tok", "u")),
            patch("plugin.github.git_auth_args", return_value=[]),
        ):
            with self.assertRaises(ship.ShipError) as ctx:
                ship._push(Path(self.tmp), self.tmp, "hermes/s1", force=True)
        self.assertEqual(ctx.exception.status, 409)
        self.assertIn("never fetched", str(ctx.exception))
        self.assertFalse([call for call in calls if "push" in call], calls)

    def test_force_on_a_branch_github_has_not_got_is_an_ordinary_push(self):
        """A branch that isn't on GitHub yet has nothing to overwrite, so it is simply created."""
        calls = []

        def fake_run(tree, args, env=None):
            calls.append(args)
            return MagicMock(returncode=0, stderr="", stdout="")

        with (
            patch("plugin.ship._run", side_effect=fake_run),
            patch("plugin.ship._ref_sha", return_value=None),
            patch("plugin.ship._remote_sha", return_value=None),
            patch("plugin.github.token", return_value=("tok", "u")),
            patch("plugin.github.git_auth_args", return_value=[]),
        ):
            ship._push(Path(self.tmp), self.tmp, "hermes/s1", force=True)
        self.assertNotIn("force", " ".join(self._push_args(calls)))

    def test_plain_push_has_no_force_flags(self):
        calls = []

        def fake_run(tree, args, env=None):
            calls.append(args)
            return MagicMock(returncode=0, stderr="", stdout="")

        with (
            patch("plugin.ship._run", side_effect=fake_run),
            patch("plugin.github.token", return_value=("tok", "u")),
            patch("plugin.github.git_auth_args", return_value=[]),
        ):
            ship._push(Path(self.tmp), self.tmp, "hermes/s1", force=False)
        flat = " ".join(" ".join(call) for call in calls)
        self.assertNotIn("force", flat)

    def test_stale_info_rejection_is_reported_not_retried(self):
        """A branch someone else moved is refused and surfaced, never forced again."""

        def fake_run(tree, args, env=None):
            if "push" in args:
                return MagicMock(returncode=1, stderr="! [rejected] (stale info)", stdout="")
            return MagicMock(returncode=0, stderr="", stdout="")

        with (
            patch("plugin.ship._run", side_effect=fake_run),
            patch("plugin.ship._ref_sha", return_value="cafe1234"),
            patch("plugin.github.token", return_value=("tok", "u")),
            patch("plugin.github.git_auth_args", return_value=[]),
        ):
            with self.assertRaises(ship.ShipError) as ctx:
                ship._push(Path(self.tmp), self.tmp, "hermes/s1", force=True)
        self.assertEqual(ctx.exception.status, 409)
        self.assertIn("moved", str(ctx.exception))


TASK = {
    "repo": "o/r",
    "number": 265,
    "title": "The work comes back as a draft pull request",
    "url": "https://github.com/o/r/issues/265",
    "created_at": "2026-10-01T00:00:00Z",
}


class AfkTaskTests(_Base):
    def _ship(self, task=None, repo_root=None, body=None):
        sent = []

        def request(path, auth, method="GET", data=None):
            sent.append((path, method, data))
            return {"number": 7, "html_url": "https://github.com/o/r/pull/7", "state": "open", "draft": True}

        record = _record(self.tmp)
        record["task"] = task
        if repo_root:
            record["repos"][0] = {**record["repos"][0], "repo_root": repo_root}
        with (
            patch("plugin.ship.status", return_value=[_state(changed=True)]),
            patch("plugin.ship._commit", return_value="abc1234"),
            patch("plugin.ship._repo_status", return_value=_state(changed=True)),
            patch("plugin.ship._push"),
            patch("plugin.ship._lock") as lock,
            patch("plugin.github.pull_request", return_value=None),
            patch("plugin.github.token", return_value=("tok", "u")),
            patch("plugin.github.origin_repo", return_value=repo_root or "o/r"),
            patch("plugin.github._request", side_effect=request),
            patch("plugin.push.notify") as notify,
        ):
            lock.return_value.acquire.return_value = True
            ship.ship(Path(self.tmp), "s1", record, "msg", "T", body, True, False)
        created = [call for call in sent if call[0].endswith("/pulls") and call[1] == "POST"]
        return (created[0][2] if created else None), notify

    def test_the_task_its_repository_works_is_closed_by_the_merge(self):
        data, _ = self._ship(task=TASK)
        self.assertIs(data["draft"], True, "the pull request stays a draft")
        self.assertIn("Closes #265", data["body"])

    def test_the_body_the_run_wrote_carries_the_closing_line(self):
        data, _ = self._ship(task=TASK, body="## Summary\n\nWork.\n\n## How to test\n\nRun it.")
        self.assertIn("Work.", data["body"])
        self.assertIn("Closes #265", data["body"].splitlines())

    def test_another_repository_does_not_close_the_task(self):
        data, _ = self._ship(task=TASK, repo_root="o/other")
        self.assertNotIn("Closes #265", data["body"])

    def test_a_session_the_afk_row_does_not_hold_gets_no_reference(self):
        data, _ = self._ship(task=None)
        self.assertNotIn("Closes #", data["body"])

    def test_opening_the_tasks_pull_request_says_it_is_ready_to_review(self):
        _, notify = self._ship(task=TASK)
        notify.assert_called_once()
        args, _ = notify.call_args
        self.assertEqual(args[:2], ("afk_pr", "s1"))
        self.assertEqual(args[2], db_path(Path(self.tmp)))

    def test_another_repositorys_pull_request_is_not_the_tasks_news(self):
        _, notify = self._ship(task=TASK, repo_root="o/other")
        notify.assert_not_called()

    def test_a_session_that_is_not_afks_says_nothing(self):
        _, notify = self._ship(task=None)
        notify.assert_not_called()


class AfkUpdateTests(_Base):
    def test_updating_the_body_keeps_the_task_reference(self):
        pr = {"number": 7, "state": "open", "title": "old", "url": "u"}
        record = _record(self.tmp)
        record["task"] = TASK
        with (
            patch("plugin.github.token", return_value=("tok", "u")),
            patch("plugin.github.origin_repo", return_value="o/r"),
            patch("plugin.github.pull_request", return_value=pr),
            patch("plugin.github.update_pull_request", return_value=pr) as upd,
            patch("plugin.github.forget_pull_request"),
        ):
            ship.update(Path(self.tmp), record, "new", "Body.")
        self.assertIn("Closes #265", upd.call_args.args[3])

    def test_updating_a_body_that_already_names_the_task_does_not_say_it_twice(self):
        pr = {"number": 7, "state": "open", "title": "old", "url": "u"}
        record = _record(self.tmp)
        record["task"] = TASK
        with (
            patch("plugin.github.token", return_value=("tok", "u")),
            patch("plugin.github.origin_repo", return_value="o/r"),
            patch("plugin.github.pull_request", return_value=pr),
            patch("plugin.github.update_pull_request", return_value=pr) as upd,
            patch("plugin.github.forget_pull_request"),
        ):
            ship.update(Path(self.tmp), record, None, "Body.\n\nCloses #265")
        self.assertEqual(upd.call_args.args[3].count("Closes #265"), 1)


    def test_a_body_closing_a_longer_number_still_closes_this_task(self):
        pr = {"number": 7, "state": "open", "title": "old", "url": "u"}
        record = _record(self.tmp)
        record["task"] = {**TASK, "number": 26}
        with (
            patch("plugin.github.token", return_value=("tok", "u")),
            patch("plugin.github.origin_repo", return_value="o/r"),
            patch("plugin.github.pull_request", return_value=pr),
            patch("plugin.github.update_pull_request", return_value=pr) as upd,
            patch("plugin.github.forget_pull_request"),
        ):
            ship.update(Path(self.tmp), record, None, "Body.\n\nCloses #265")
        self.assertIn("Closes #26", upd.call_args.args[3].splitlines())


class UpdateTests(_Base):
    def test_update_sets_title_and_body_on_open_pr(self):
        pr = {"number": 7, "state": "open", "title": "old", "url": "u"}
        with (
            patch("plugin.github.token", return_value=("tok", "u")),
            patch("plugin.github.origin_repo", return_value="o/r"),
            patch("plugin.github.pull_request", return_value=pr),
            patch("plugin.github.update_pull_request", return_value={**pr, "title": "new"}) as upd,
            patch("plugin.github.forget_pull_request"),
        ):
            results = ship.update(Path(self.tmp), _record(self.tmp), "new", "body")
        upd.assert_called_once_with("o/r", 7, "new", "body", "tok")
        self.assertEqual(results[0]["pr"]["title"], "new")

    def test_update_without_open_pr_says_so(self):
        with (
            patch("plugin.github.token", return_value=("tok", "u")),
            patch("plugin.github.origin_repo", return_value="o/r"),
            patch("plugin.github.pull_request", return_value=None),
        ):
            data = self._call({"action": "update", "title": "x"})
        self.assertIn("No open pull request", data["error"])

    def test_update_needs_title_or_body(self):
        data = self._call({"action": "update"})
        self.assertIn("needs a title or a body", data["error"])


class RefusalTests(_Base):
    def test_merge_and_close_are_refused_with_teaching_error(self):
        for action in ("merge", "close"):
            with self.subTest(action=action):
                data = json.loads(ship.handle({"action": action}))
                self.assertIn("user's decision", data["error"])
                self.assertIn("clarify", data["error"])
                self.assertIn(f"Don't call pull_request with '{action}' again", data["error"])

    def test_merge_and_close_are_in_enum_but_not_actions(self):
        enum = ship.SCHEMA["parameters"]["properties"]["action"]["enum"]
        self.assertIn("merge", enum)
        self.assertIn("close", enum)
        self.assertNotIn("merge", ship.ACTIONS)
        self.assertNotIn("close", ship.ACTIONS)

    def test_missing_or_unknown_action_is_rejected(self):
        self.assertIn("action is required", json.loads(ship.handle({}))["error"])
        self.assertIn("action is required", json.loads(ship.handle({"action": "bogus"}))["error"])

    def test_legacy_stub_redirects(self):
        data = json.loads(ship.handle_legacy({}))
        self.assertIn("pull_request", data["error"])
        self.assertIn("ship", data["error"])


class StageTests(_Base):
    """A staged task's build can't ship: the critique stage opens the pull request instead."""

    def staged(self, stage: str) -> dict:
        return {**_record(self.tmp), "pipeline": {**pipeline.start("plan", ["code-review"]), "stage": stage}}

    def test_a_build_cannot_ship(self) -> None:
        answer = self._call({"action": "ship", "commit_message": "m"}, record=self.staged(pipeline.BUILD))
        self.assertIn("Build stage", answer["error"], "the refusal names the stage")
        self.assertIn("afk_gate", answer["error"])
        self.assertIn("critique stage", answer["error"])

    def test_a_task_at_its_gate_cannot_ship_either(self) -> None:
        answer = self._call({"action": "ship", "commit_message": "m"}, record=self.staged(pipeline.GATE))
        self.assertIn("Gate stage", answer["error"])

    def test_a_critique_ships(self) -> None:
        with patch("plugin.ship.ship", return_value=[]) as shipped:
            answer = self._call(
                {"action": "ship", "commit_message": "m"}, record=self.staged(pipeline.CRITIQUE)
            )
        shipped.assert_called_once()
        self.assertNotIn("error", answer)

    def test_a_session_that_is_not_staged_ships_as_it_always_did(self) -> None:
        with patch("plugin.ship.ship", return_value=[]) as shipped:
            self._call({"action": "ship", "commit_message": "m"})
        shipped.assert_called_once()

    def test_the_build_can_still_ask_what_it_has(self) -> None:
        with patch("plugin.ship.status", return_value=[]):
            answer = self._call({"action": "status"}, record=self.staged(pipeline.BUILD))
        self.assertNotIn("error", answer, "status writes nothing, so a build may look")


if __name__ == "__main__":
    unittest.main()
