"""Regression tests for ship._push() auth-header construction.

Verifies that _push() builds a git push command whose http.extraheader
carries a valid base64-encoded ``x-access-token:<token>`` value.
"""

import base64
import unittest
from pathlib import Path
from subprocess import CompletedProcess
from types import ModuleType
from unittest.mock import MagicMock, patch

from plugin import ship


def _inject_fake_agent(lookup_fn):
    """Inject fake agent.credential_pool and agent.secret_scope modules."""
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


class PushAuthTests(unittest.TestCase):
    def setUp(self):
        self.home = Path("/fake/hermes_home")

    def test_push_with_token_builds_valid_auth_header(self):
        """_push() must set http.extraheader with base64 of x-access-token:<token>."""
        fake_token = "ghp_push_token"
        with _inject_fake_agent(lambda key: fake_token if key == "GITHUB_TOKEN" else ""):
            with patch.object(ship, "_run") as mock_run:
                mock_run.return_value = CompletedProcess(
                    args=[], returncode=0, stdout="", stderr=""
                )
                ship._push(self.home, "fake-tree-sha", "main")

        mock_run.assert_called_once()
        # _run(tree, args, env=None) — args[1] is the command list
        args = mock_run.call_args[0][1]

        header = None
        for arg in args:
            if ".extraheader" in str(arg):
                header = arg
                break

        self.assertIsNotNone(header, "Push command should include http.extraheader")

        self.assertIn("basic ", header)
        parts = header.split("basic ")
        b64_value = parts[-1].strip()

        # Must NOT be the literal *** (corruption pattern)
        self.assertNotEqual(b64_value, "***")
        self.assertNotIn("...", b64_value)

        decoded = base64.b64decode(b64_value).decode()
        self.assertEqual(decoded, "x-access-token:" + fake_token)

    def test_push_without_token_omits_header(self):
        """Without a token, _push() should not set the auth header."""
        with _inject_fake_agent(lambda key: ""):
            with patch.object(ship, "_run") as mock_run, \
                 patch.object(ship.github, "token", return_value=(None, None)):
                mock_run.return_value = CompletedProcess(
                    args=[], returncode=0, stdout="", stderr=""
                )
                ship._push(self.home, "fake-tree", "main")

        args = mock_run.call_args[0][1]
        for arg in args:
            self.assertNotIn(".extraheader", str(arg))

    def test_push_failure_raises_ship_error(self):
        """_push() should raise ShipError when git push returns non-zero."""
        from plugin.ship import ShipError

        fake_token = "ghp_push_token"
        with _inject_fake_agent(lambda key: fake_token if key == "GITHUB_TOKEN" else ""):
            with patch.object(ship, "_run") as mock_run:
                mock_run.return_value = CompletedProcess(
                    args=[], returncode=1, stdout="", stderr="Authentication failed"
                )
                with self.assertRaises(ShipError):
                    ship._push(self.home, "fake-tree-sha", "main")


if __name__ == "__main__":
    unittest.main()
