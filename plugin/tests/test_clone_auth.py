"""Regression tests for github.clone() auth-header construction.

Verifies that clone() builds a git command whose http.extraheader
carries a valid base64-encoded ``x-access-token:<token>`` value, not
the literal string ``***`` or any truncated form.
"""

import base64
import unittest
from pathlib import Path
from types import ModuleType
from unittest.mock import MagicMock, patch

from plugin import github


def _inject_fake_agent(lookup_fn):
    """Inject fake agent.credential_pool and agent.secret_scope modules.

    token() defers imports from both packages; this helper provides
    fakes so tests don't need the real Hermes agent.
    """
    fake_agent = ModuleType("agent")

    fake_pool = ModuleType("agent.credential_pool")
    fake_pool.get_env_prefer_dotenv = lookup_fn
    fake_agent.credential_pool = fake_pool

    fake_scope = ModuleType("agent.secret_scope")
    fake_scope.current_secret_scope = MagicMock(return_value=None)
    fake_scope.build_profile_secret_scope = MagicMock(return_value={})
    fake_scope.set_secret_scope = MagicMock(return_value="tok")
    fake_scope.reset_secret_scope = MagicMock()
    fake_agent.secret_scope = fake_scope

    return patch.dict("sys.modules", {
        "agent": fake_agent,
        "agent.credential_pool": fake_pool,
        "agent.secret_scope": fake_scope,
    })


class CloneAuthTests(unittest.TestCase):
    def setUp(self):
        self.home = Path("/fake/hermes_home")

    def _run_clone(self, token_value, run_git_result=(0, "", "")):
        """Run clone() with a faked token and return the git command list."""
        lookup = lambda key: token_value if key == "GITHUB_TOKEN" else ""
        with _inject_fake_agent(lookup):
            with patch.object(github, "_run_git") as mock_run:
                mock_run.return_value = run_git_result
                github.clone(self.home, "owner/repo", "/tmp/fake-clone")
        mock_run.assert_called_once()
        return mock_run.call_args[0][0]

    def test_clone_with_token_builds_valid_auth_header(self):
        """clone() must set http.extraheader with base64 of x-access-token:<token>."""
        fake_token = "ghp_clone_tok"
        command = self._run_clone(fake_token)

        header = None
        for arg in command:
            if ".extraheader" in str(arg):
                header = arg
                break

        self.assertIsNotNone(header, "Command should include http.extraheader with a token")

        self.assertIn("basic ", header)
        parts = header.split("basic ")
        b64_value = parts[-1].strip()

        # Must NOT be the literal *** (the corruption pattern)
        self.assertNotEqual(b64_value, "***")

        # Must NOT be a truncated form like "...e()"
        self.assertNotIn("...", b64_value)
        self.assertNotIn("de()", b64_value)

        decoded = base64.b64decode(b64_value).decode()
        self.assertEqual(decoded, "x-access-token:" + fake_token)

    def test_clone_without_token_omits_header(self):
        """Without a token, clone() should not set the auth header."""
        with _inject_fake_agent(lambda key: ""):
            with patch.object(github, "_run_git") as mock_run, \
                 patch.object(github, "_gh_cli_token", return_value=None):
                mock_run.return_value = (0, "", "")
                github.clone(self.home, "owner/repo", "/tmp/fake-clone")

        command = mock_run.call_args[0][0]
        for arg in command:
            self.assertNotIn(".extraheader", str(arg))

    def test_clone_failure_on_bad_auth_raises_github_error(self):
        """clone() should raise GitHubError(403) on git auth failure."""
        fake_token = "ghp_bad_tok"
        with _inject_fake_agent(lambda key: fake_token if key == "GITHUB_TOKEN" else ""):
            with patch.object(github, "_run_git") as mock_run:
                mock_run.return_value = (1, "", "Authentication failed")
                with self.assertRaises(github.GitHubError) as ctx:
                    github.clone(self.home, "owner/repo", "/tmp/fake-clone")
                self.assertEqual(ctx.exception.status, 403)


if __name__ == "__main__":
    unittest.main()
