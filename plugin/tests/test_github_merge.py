"""The two states a run could not reach before: a draft marked ready for review, and a merge.

Both go through ``github._fetch``, the one HTTP seam: the mutation for readiness is GraphQL and the
merge is a ``PUT`` on the pull request's own route, so nothing here opens a second way out.
"""

import io
import unittest
import urllib.error
from unittest.mock import patch

from plugin import github


def pull_row(number=7, draft=True, sha="cafe1234"):
    """A single pull request as ``GET /repos/{repo}/pulls/{number}`` answers it."""
    return {
        "number": number,
        "node_id": f"PR_kw{number}",
        "title": "T",
        "html_url": f"https://github.com/o/r/pull/{number}",
        "state": "open",
        "draft": draft,
        "head": {"sha": sha},
    }


class ReadyTests(unittest.TestCase):
    def _serve(self, pull, answer=None):
        """A fake seam: the pull request for a GET, the mutation's answer for the GraphQL call."""
        sent = []

        def fetch(path, auth, method="GET", data=None, timeout=None):
            sent.append((path, method, data))
            return (answer if path == "/graphql" else pull), ""

        return sent, patch.object(github, "_fetch", fetch)

    def test_a_draft_is_marked_ready_through_the_one_mutation(self):
        """GitHub has no REST field for this, so the call is the mutation, on the same seam."""
        sent, serving = self._serve(
            pull_row(),
            {
                "data": {
                    "markPullRequestReadyForReview": {
                        "pullRequest": {"id": "PR_kw7", "isDraft": False}
                    }
                }
            },
        )
        with serving:
            row = github.mark_ready("o/r", 7, "tok")
        self.assertEqual(row["state"], "open", "ready is open, which is a state the app knows")
        self.assertIs(row["number"], 7)
        self.assertEqual(
            [(path, method) for path, method, _ in sent],
            [("/repos/o/r/pulls/7", "GET"), ("/graphql", "POST")],
            "the pull request is read for its node id, then the mutation is posted",
        )
        fields = sent[1][2]
        self.assertIn("markPullRequestReadyForReview", fields["query"])
        self.assertEqual(fields["variables"], {"id": "PR_kw7"})

    def test_a_pull_request_that_is_already_ready_is_left_alone(self):
        sent, serving = self._serve(pull_row(draft=False))
        with serving:
            row = github.mark_ready("o/r", 7, "tok")
        self.assertEqual(row["state"], "open")
        self.assertEqual(len(sent), 1, "no mutation for a pull request already out of draft")

    def test_a_refusal_by_the_mutation_is_raised_with_githubs_own_words(self):
        said = "Could not resolve to a node with the global id of 'PR_kw7'."
        _, serving = self._serve(pull_row(), {"errors": [{"message": said}]})
        with serving:
            with self.assertRaises(github.GitHubError) as raised:
                github.mark_ready("o/r", 7, "tok")
        self.assertEqual(str(raised.exception), said)

    def test_an_answer_that_still_says_draft_is_not_a_pull_request_made_ready(self):
        """A 200 that never says `isDraft: false` is no evidence the mutation landed."""
        for answer in (
            {"data": {"markPullRequestReadyForReview": {"pullRequest": {"isDraft": True}}}},
            {"data": {"markPullRequestReadyForReview": None}},
            None,
        ):
            with self.subTest(answer=answer):
                _, serving = self._serve(pull_row(), answer)
                with serving:
                    with self.assertRaises(github.GitHubError):
                        github.mark_ready("o/r", 7, "tok")


class CodeTests(unittest.TestCase):
    """A refusal keeps the status GitHub answered, so a caller can act on which one it was."""

    def test_a_refusal_carries_the_http_status_beside_githubs_words(self):
        refused = urllib.error.HTTPError(
            "https://api.github.com/x",
            405,
            "Method Not Allowed",
            {},
            io.BytesIO(b'{"message": "Pull Request is not mergeable"}'),
        )
        with patch.object(urllib.request, "urlopen", side_effect=refused):
            with self.assertRaises(github.GitHubError) as raised:
                github._request("/x", "tok", "PUT", {})
        self.assertEqual(raised.exception.code, 405, "the status, without changing what status means")
        self.assertEqual(raised.exception.status, 502, "the app's own answer is unchanged")
        self.assertEqual(str(raised.exception), "Pull Request is not mergeable")


class MergeCallTests(unittest.TestCase):
    def _serve(self, pull, answer=None, refusal=None):
        sent = []

        def fetch(path, auth, method="GET", data=None, timeout=None):
            sent.append((path, method, data))
            if method == "PUT" and refusal is not None:
                raise refusal
            return (pull if method == "GET" else answer), ""

        return sent, patch.object(github, "_fetch", fetch)

    def test_the_merge_names_the_method_and_the_head_it_read(self):
        """With no sha handed in, the guard is the head this call read."""
        sent, serving = self._serve(
            pull_row(draft=False), {"merged": True, "message": "Pull Request successfully merged"}
        )
        with serving:
            answer = github.merge_pull_request("o/r", 7, "squash", "tok")
        self.assertTrue(answer["merged"])
        self.assertEqual(answer["sha"], "cafe1234")
        self.assertEqual(sent[-1][:2], ("/repos/o/r/pulls/7/merge", "PUT"))
        self.assertEqual(sent[-1][2], {"merge_method": "squash", "sha": "cafe1234"})

    def test_the_merge_is_guarded_by_the_head_the_checks_were_gated_on(self):
        """The gate read one commit; this must not swap in a fresher one nobody's checks speak for."""
        sent, serving = self._serve(pull_row(draft=False, sha="moved456"), {"merged": True})
        with serving:
            answer = github.merge_pull_request("o/r", 7, "squash", "tok", "gated123")
        self.assertEqual(sent[-1][2]["sha"], "gated123")
        self.assertEqual(answer["sha"], "gated123")

    def test_a_draft_is_refused_before_git_hub_is_asked_to_merge_it(self):
        sent, serving = self._serve(pull_row(draft=True))
        with serving:
            with self.assertRaises(github.GitHubError) as raised:
                github.merge_pull_request("o/r", 7, "squash", "tok")
        self.assertIn("ready", str(raised.exception))
        self.assertEqual([method for _, method, _ in sent], ["GET"], "no merge call for a draft")

    def test_a_merge_github_will_not_make_says_what_to_do(self):
        cases = {
            405: ("fix what GitHub names", "Pull Request is not mergeable"),
            409: ("ship", "Head branch was modified. Review and try the merge again."),
            422: ("ask the user with clarify", "Merge commits are not allowed on this repository."),
        }
        for code, (wanted, said) in cases.items():
            with self.subTest(code=code):
                refusal = github.GitHubError(said, 502, code)
                _, serving = self._serve(pull_row(draft=False), refusal=refusal)
                with serving:
                    with self.assertRaises(github.GitHubError) as raised:
                        github.merge_pull_request("o/r", 7, "squash", "tok")
                self.assertIn(wanted, str(raised.exception))
                self.assertIn("o/r#7", str(raised.exception), "the pull request is named")


if __name__ == "__main__":
    unittest.main()
