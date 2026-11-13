"""Tests for the pull_request tool: its actions, always-draft pull requests, force pushes,
title/body updates, the ready and merge actions, and the refusal of close."""

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from plugin import github, ship
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
        self.db = Path(self.tmp) / "gots.db"
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

    def _ship(self, body=None, task=None, repo_root=None):
        """The payload a ship POSTs to GitHub, and the notify mock, from a fake host."""
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

    def _updated(self, title=None, body=None, record=None):
        """The body an update sends to GitHub."""
        pr = {"number": 7, "state": "open", "title": "old", "url": "u"}
        with (
            patch("plugin.github.token", return_value=("tok", "u")),
            patch("plugin.github.origin_repo", return_value="o/r"),
            patch("plugin.github.pull_request", return_value=pr),
            patch("plugin.github.update_pull_request", return_value=pr) as upd,
            patch("plugin.github.forget_pull_request"),
        ):
            ship.update(Path(self.tmp), record or _record(self.tmp), title, body)
        return upd.call_args.args[3]


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
    def _task_record(self, task=TASK):
        record = _record(self.tmp)
        record["task"] = task
        return record

    def test_updating_the_body_keeps_the_task_reference(self):
        self.assertIn("Closes #265", self._updated("new", "Body.", self._task_record()))

    def test_updating_a_body_that_already_names_the_task_does_not_say_it_twice(self):
        body = self._updated(None, "Body.\n\nCloses #265", self._task_record())
        self.assertEqual(body.count("Closes #265"), 1)

    def test_a_body_closing_a_longer_number_still_closes_this_task(self):
        record = self._task_record({**TASK, "number": 26})
        self.assertIn("Closes #26", self._updated(None, "Body.\n\nCloses #265", record).splitlines())


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
        self.assertEqual(upd.call_args.args[:3], ("o/r", 7, "new"))
        self.assertTrue(upd.call_args.args[3].endswith(ship.PR_MARK))
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


class WatermarkTests(_Base):
    """The mark a description ends with is the tool's to write, on both paths that write one."""

    def _created(self, body=None, task=None):
        return self._ship(body=body, task=task)[0]["body"]

    def _rules(self, body):
        return [line.strip() for line in body.splitlines() if line.strip() in ("---", "***", "___")]

    def test_every_description_ends_with_the_mark_under_its_own_rule(self):
        body = self._created("## Summary\n\nWork.")
        self.assertTrue(body.endswith(f"---\n\n{ship.PR_MARK}"))
        self.assertEqual(body.count(ship.PR_MARK), 1)

    def test_a_mark_the_run_wrote_is_replaced_not_kept_beside_the_tools(self):
        body = self._created("## Summary\n\nWork.\n\nGenerated by Gots <someone@example.com>")
        self.assertEqual(body.count(ship.PR_MARK), 1)
        self.assertNotIn("someone@example.com", body)
        self.assertTrue(body.endswith(ship.PR_MARK))

    def test_prose_that_names_the_product_is_left_alone(self):
        said = "Generated by Gots during the migration of the auth module."
        body = self._created(f"## Summary\n\n{said}\n\nWork.")
        self.assertIn(said, body)
        self.assertEqual(body.count(ship.PR_MARK), 1)

    def test_a_mark_the_body_bulleted_is_replaced(self):
        body = self._created(f"## Summary\n\nWork.\n\n- {ship.PR_MARK}")
        self.assertEqual(body.count(ship.PR_MARK), 1)
        self.assertTrue(body.endswith(ship.PR_MARK))

    def test_the_mark_lands_outside_an_unterminated_fence(self):
        body = self._created("## Summary\n\n```python\nx = 1")
        self.assertTrue(body.endswith(f"```\n\n---\n\n{ship.PR_MARK}"))

    def test_the_mark_lands_outside_an_unclosed_comment(self):
        body = self._created("## Summary\n\n<!-- a note for the reviewer")
        self.assertTrue(body.endswith(f"-->\n\n---\n\n{ship.PR_MARK}"))

    def test_a_fenced_example_of_the_mark_is_left_alone(self):
        body = self._created(f"## Summary\n\nWork.\n\n```\n{ship.PR_MARK}\n```")
        self.assertEqual(body.count(ship.PR_MARK), 2)
        self.assertTrue(body.endswith(ship.PR_MARK))

    def test_the_older_mark_is_replaced_rather_than_stacked(self):
        older = "Generated by [Gots Code](https://hermesgots.dev), a Hermes plugin."
        body = self._created(f"## Summary\n\nWork.\n\n---\n\n{older}")
        self.assertNotIn("Gots Code", body)
        self.assertEqual(body.count(ship.PR_MARK), 1)

    def test_a_description_that_already_carries_the_mark_keeps_only_one(self):
        body = self._created(f"## Summary\n\nWork.\n\n---\n\n{ship.PR_MARK}")
        self.assertEqual(body.count(ship.PR_MARK), 1)
        self.assertTrue(body.endswith(ship.PR_MARK))
        self.assertEqual(self._rules(body), ["---"])

    def test_the_closing_line_stands_above_the_mark(self):
        body = self._created("Work.", task=TASK)
        self.assertLess(body.index("Closes #265"), body.index(ship.PR_MARK))
        self.assertTrue(body.endswith(ship.PR_MARK))

    def test_the_closing_line_comes_under_no_second_rule(self):
        body = self._created("Work.\n\n---", task=TASK)
        self.assertEqual(self._rules(body), ["---"])
        self.assertLess(body.index("Closes #265"), body.index(ship.PR_MARK))

    def test_a_mark_the_run_wrote_without_brackets_is_taken_out(self):
        body = self._created("## Summary\n\nWork.\n\nGenerated by Gots someone@example.com")
        self.assertNotIn("someone@example.com", body)
        self.assertEqual(body.count(ship.PR_MARK), 1)

    def test_a_mark_buried_mid_paragraph_is_left_as_text(self):
        """The rule reads lines: a copy inside a sentence is prose, and the description then has two."""
        body = self._created(f"Work. {ship.PR_MARK} and more.")
        self.assertEqual(body.count(ship.PR_MARK), 2)

    def test_prose_that_mentions_a_fence_is_not_closed_for_it(self):
        body = self._created("## Summary\n\nUse ``` to open a fence in markdown.")
        self.assertEqual(body.count("```"), 1)
        self.assertTrue(body.endswith(ship.PR_MARK))

    def test_a_tilde_fence_is_a_fence_too(self):
        body = self._created(f"## Summary\n\n~~~\n{ship.PR_MARK}\n~~~")
        self.assertEqual(body.count(ship.PR_MARK), 2)

    def test_an_update_carries_the_mark_too(self):
        body = self._updated(body="Body.")
        self.assertTrue(body.endswith(ship.PR_MARK))
        self.assertEqual(body.count(ship.PR_MARK), 1)

    def test_a_title_only_update_leaves_the_body_alone(self):
        self.assertIsNone(self._updated(title="new"))

    def test_the_mark_carries_no_address(self):
        body = self._created("Work.")
        self.assertNotIn("@", body)
        self.assertNotIn("noreply", body)
        self.assertTrue(body.endswith(ship.PR_MARK))


class CoAuthorTests(_Base):
    """Gots is credited as a co-author on the commits it writes, beside the person who authors them."""

    def _message(self, config_email):
        sent = []

        def fake_run(tree, args, env=None):
            sent.append(args)
            return MagicMock(returncode=0, stdout="", stderr="")

        def fake_git(tree, *args):
            value = config_email if args[:2] == ("config", "user.email") else "Haseeb Ahmed"
            return MagicMock(returncode=0, stdout=f"{value}\n", stderr="")

        with (
            patch("plugin.ship._git", side_effect=fake_git),
            patch("plugin.ship._run", side_effect=fake_run),
        ):
            ship._commit(Path(self.tmp), self.tmp, "feat: a change")
        commit = [args for args in sent if args and args[0] == "commit"][0]
        return commit[commit.index("-m") + 1]

    def test_the_person_authors_and_gots_is_named_beside_them(self):
        message = self._message("haseeb@example.com")
        self.assertEqual(
            message,
            "feat: a change\n\nCo-authored-by: Gots <342030690+gotsfather@users.noreply.github.com>",
        )

    def test_the_trailer_does_not_depend_on_the_hosts_account(self):
        """No token, no API call: the credit is the plugin's own, so a server that can't read its
        account still writes it."""
        with patch("plugin.ship._account") as account:
            message = self._message("haseeb@example.com")
        account.assert_not_called()
        self.assertIn(ship.CO_AUTHOR_EMAIL, message)

    def test_a_commit_the_account_authors_itself_names_no_co_author(self):
        message = self._message(ship.CO_AUTHOR_EMAIL)
        self.assertEqual(message, "feat: a change")

    def test_a_second_credit_changes_nothing(self):
        once = ship._credit("feat: x", "someone@example.com")
        self.assertEqual(ship._credit(once, "someone@example.com").count("Co-authored-by"), 1)

    def test_a_stale_credit_is_replaced_rather_than_kept_beside_the_tools(self):
        message = ship._credit("feat: x\n\nCo-authored-by: Gots Code <old@example.com>", "someone@example.com")
        self.assertNotIn("old@example.com", message)
        self.assertEqual(message.count("Co-authored-by"), 1)

    def test_a_credit_naming_another_account_keeps_its_line(self):
        message = ship._credit("feat: x\n\nCo-authored-by: Gotsfather <o@example.com>", "someone@example.com")
        self.assertIn("Gotsfather", message)
        self.assertEqual(message.count("Co-authored-by"), 2)


class RefusalTests(_Base):
    def test_close_is_refused_with_teaching_error(self):
        data = json.loads(ship.handle({"action": "close"}))
        self.assertIn("Don't close pull requests yourself", data["error"])
        self.assertIn("clarify", data["error"])
        self.assertIn("'" + "close' again", data["error"])

    def test_close_is_in_enum_but_not_actions_and_merge_is_performed(self):
        """Closing throws work away, so it stays the user's; merging delivers it, so it is the tool's."""
        enum = ship.SCHEMA["parameters"]["properties"]["action"]["enum"]
        self.assertIn("close", enum)
        self.assertNotIn("close", ship.ACTIONS)
        self.assertIn("merge", enum)
        self.assertIn("merge", ship.ACTIONS)
        self.assertIn("ready", ship.ACTIONS)
        self.assertEqual(ship.REFUSED_ACTIONS, ("close",))

    def test_missing_or_unknown_action_is_rejected(self):
        self.assertIn("action is required", json.loads(ship.handle({}))["error"])
        self.assertIn("action is required", json.loads(ship.handle({"action": "bogus"}))["error"])

    def test_legacy_stub_redirects(self):
        data = json.loads(ship.handle_legacy({}))
        self.assertIn("pull_request", data["error"])
        self.assertIn("ship", data["error"])


class ReadyTests(_Base):
    """A draft is taken out of draft, so the pull request can be reviewed and then merged."""

    def _ready(self, state="draft", record=None):
        pr = None if state is None else {"number": 7, "state": state, "title": "T", "url": "u"}
        ready = {"number": 7, "state": "open", "title": "T", "url": "u"}
        with (
            patch("plugin.github.token", return_value=("tok", "u")),
            patch("plugin.github.origin_repo", return_value="o/r"),
            patch("plugin.github.pull_request", return_value=pr),
            patch("plugin.github.mark_ready", return_value=ready) as mark,
            patch("plugin.github.forget_pull_request") as forget,
        ):
            return self._call({"action": "ready"}, record or _record(self.tmp)), mark, forget

    def test_ready_marks_the_draft_and_forgets_the_cached_row(self):
        data, mark, forget = self._ready()
        mark.assert_called_once_with("o/r", 7, "tok")
        self.assertTrue(forget.called, "the app's next read must see it out of draft")
        self.assertEqual(data["results"][0]["pr"]["state"], "open")
        self.assertNotIn("error", data["results"][0])

    def test_ready_again_says_it_is_already_ready(self):
        """A dropped answer, retried, must not read as a failed step: the state is what it is."""
        data, mark, _ = self._ready(state="open")
        mark.assert_not_called()
        self.assertNotIn("error", data)
        self.assertTrue(data["results"][0]["already_ready"], "it says the state holds rather than failing")

    def test_ready_says_when_the_branch_has_no_pull_request(self):
        data, mark, _ = self._ready(state=None)
        mark.assert_not_called()
        self.assertIn("No pull request", data["error"])

    def test_a_read_that_could_not_reach_github_is_not_an_empty_branch(self):
        """An outage and "no pull request" are different facts, and the next call depends on which."""

        def read(*args, **kwargs):
            if not kwargs.get("strict"):
                return None
            raise github.GitHubError("Couldn't reach GitHub from the server.")

        with (
            patch("plugin.github.token", return_value=("tok", "u")),
            patch("plugin.github.origin_repo", return_value="o/r"),
            patch("plugin.github.pull_request", side_effect=read),
        ):
            data = self._call({"action": "ready"})
        self.assertIn("Couldn't reach GitHub", data["error"])
        self.assertNotIn("No pull request", data["error"])


class MergeTests(_Base):
    """The end of the road: the pull request is merged, and everything that cached it lets go."""

    def _pr(self, state="open", checks="success", sha="gated123"):
        return {"number": 7, "state": state, "checks": checks, "sha": sha, "title": "T", "url": "u"}

    def _merge(self, pr=None, merged=None, failure=None, method=None):
        """The merge action's answer, and what it did: the call, the forget and the resolution."""
        merged = merged or {"repo": "o/r", "number": 7, "sha": "cafe1234", "merged": True}
        args = {"action": "merge"}
        if method:
            args["merge_method"] = method
        with (
            patch("plugin.github.token", return_value=("tok", "u")),
            patch("plugin.github.origin_repo", return_value="o/r"),
            patch("plugin.github.pull_request", return_value=pr or self._pr()),
            patch("plugin.github.merge_pull_request", return_value=merged) as call,
            patch("plugin.github.forget_pull_request") as forget,
            patch("plugin.merges.check", return_value=1) as resolve,
        ):
            if failure:
                call.side_effect = failure
            return self._call(args), call, forget, resolve

    def test_merge_merges_the_live_pull_request_on_a_squash_by_default(self):
        data, call, forget, resolve = self._merge()
        call.assert_called_once_with("o/r", 7, "squash", "tok", "gated123")
        self.assertTrue(forget.called, "a merged row is not the row the app should list")
        self.assertTrue(data["results"][0]["merged"])

    def test_a_merge_read_that_could_not_reach_github_is_not_an_empty_branch(self):
        """Told there is nothing to merge, the obvious next move is `ship`, which opens a second one."""

        def read(*args, **kwargs):
            if not kwargs.get("strict"):
                return None
            raise github.GitHubError("Couldn't reach GitHub from the server.")

        with (
            patch("plugin.github.token", return_value=("tok", "u")),
            patch("plugin.github.origin_repo", return_value="o/r"),
            patch("plugin.github.pull_request", side_effect=read),
        ):
            data = self._call({"action": "merge"})
        self.assertIn("Couldn't reach GitHub", data["error"])
        self.assertNotIn("No open pull request", data["error"])

    def test_merge_names_another_method_when_asked_for_one(self):
        _, call, _, _ = self._merge(method="rebase")
        self.assertEqual(call.call_args.args[2], "rebase")

    def test_merge_refuses_a_method_it_does_not_know(self):
        data, call, _, _ = self._merge(method="fast-forward")
        call.assert_not_called()
        self.assertIn("merge_method", data["error"])

    def test_merging_resolves_the_session_once(self):
        """The app lists the state and the user hears it: both come from the merge's own pass."""
        _, _, _, resolve = self._merge()
        resolve.assert_called_once()
        self.assertEqual(resolve.call_args.kwargs.get("only") or resolve.call_args.args[1], {"s1"})

    def test_merge_refuses_a_draft_and_says_to_make_it_ready(self):
        data, call, _, _ = self._merge(pr=self._pr(state="draft"))
        call.assert_not_called()
        self.assertIn("ready", data["error"])

    def test_merge_refuses_a_pull_request_whose_checks_failed(self):
        data, call, _, _ = self._merge(pr=self._pr(checks="failure"))
        call.assert_not_called()
        self.assertIn("checks failed", data["error"])

    def test_merge_waits_for_checks_that_still_run(self):
        data, call, _, _ = self._merge(pr=self._pr(checks="pending"))
        call.assert_not_called()
        self.assertIn("still running", data["error"])

    def test_a_merge_github_refused_is_reported_and_nothing_is_resolved(self):
        refused = ship.ShipError("GitHub won't merge o/r#7: Pull Request is not mergeable.", 409)
        data, _, _, resolve = self._merge(failure=refused)
        resolve.assert_not_called()
        self.assertIn("o/r#7", data["error"])

    def test_merge_says_when_there_is_no_open_pull_request(self):
        data, call, _, _ = self._merge(pr={"number": 7, "state": "merged", "checks": None})
        call.assert_not_called()
        self.assertIn("No open pull request", data["error"])


class ShipTests(_Base):
    """A session that isn't AFK's ships as it always did, with no stage to answer to."""

    def test_a_session_that_is_not_staged_ships_as_it_always_did(self) -> None:
        with patch("plugin.ship.ship", return_value=[]) as shipped:
            self._call({"action": "ship", "commit_message": "m"})
        shipped.assert_called_once()

    def test_the_build_can_still_ask_what_it_has(self) -> None:
        with patch("plugin.ship.status", return_value=[]):
            answer = self._call({"action": "status"})
        self.assertNotIn("error", answer, "status writes nothing, so a session may look")


if __name__ == "__main__":
    unittest.main()
