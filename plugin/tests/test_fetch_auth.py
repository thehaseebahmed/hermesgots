"""Regression tests for sessions._fetch_origin auth-header construction.

Verifies that _fetch_origin() builds a git command whose http.extraheader
carries a valid base64-encoded x-access-token:*** when a token is available,
and omits the header when no token is resolved (public repos).

Run: python3 -m unittest plugin.tests.test_fetch_auth -v
"""

import base64
import unittest
from subprocess import CompletedProcess
from unittest.mock import patch

from plugin import sessions


class FetchAuthTests(unittest.TestCase):
    def setUp(self):
        self.repo_root = "/fake/repo"

    def test_fetch_with_token_includes_auth_header(self):
        """_fetch_origin must set http.extraheader with base64 of x-access-token:***."""
        fake_token = "ghp_fetch_tok"
        fake_result = CompletedProcess(args=[], returncode=0, stdout="", stderr="")

        with patch.object(sessions, "_git", return_value=fake_result) as mock_git:
            sessions._fetch_origin(self.repo_root, auth=fake_token)

        mock_git.assert_called_once()
        args = mock_git.call_args[0]
        cmd = list(args[1:])

        header_idx = next(
            (i for i, arg in enumerate(cmd) if ".extraheader" in str(arg)), None
        )
        self.assertIsNotNone(header_idx, "Command should include http.extraheader with a token")
        assert header_idx is not None
        self.assertEqual(cmd[header_idx - 1], "-c")

        header = cmd[header_idx]
        self.assertIn("basic ", header)

        b64_value = header.split("basic ", 1)[-1].strip()
        decoded = base64.b64decode(b64_value).decode()
        self.assertEqual(decoded, f"x-access-token:{fake_token}")

    def test_fetch_without_token_omits_auth_header(self):
        """Without a token, _fetch_origin should not set the auth header."""
        fake_result = CompletedProcess(args=[], returncode=0, stdout="", stderr="")

        with patch.object(sessions, "_git", return_value=fake_result) as mock_git:
            sessions._fetch_origin(self.repo_root, auth=None)

        mock_git.assert_called_once()
        cmd = list(mock_git.call_args[0][1:])

        for arg in cmd:
            self.assertNotIn(".extraheader", str(arg))

    def test_fetch_failure_does_not_raise(self):
        """A failed fetch must not raise — it falls through to _setup_worktree's fallback."""
        from plugin.sessions import WorkspaceError

        with patch.object(sessions, "_git", side_effect=WorkspaceError("timeout")):
            sessions._fetch_origin(self.repo_root, auth="ghp_tok")


if __name__ == "__main__":
    unittest.main()
