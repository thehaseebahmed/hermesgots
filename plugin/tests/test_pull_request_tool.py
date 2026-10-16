"""Tests for the pull_request tool: its actions, always-draft pull requests, force pushes,
title/body updates, and the refusal of merge and close."""

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from plugin import ship


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


if __name__ == "__main__":
    unittest.main()
