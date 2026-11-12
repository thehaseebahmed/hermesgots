"""Regression tests for github.clone() auth-header construction.

Verifies that clone() builds a git command whose http.extraheader
carries a valid base64-encoded ``x-access-token:<token>`` value, not
the literal string ``***`` or any truncated form.
"""

import base64
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import patch

from plugin import github
from plugin.tests import GH_CLI_TOKEN
from plugin.tests._helpers import make_fake_agent


class CloneAuthTests(unittest.TestCase):
    def setUp(self):
        self.home = Path("/fake/hermes_home")

    def _run_clone(self, token_value, run_git_result=(0, "", "")):
        """Run clone() with a faked token and return the git command list."""
        lookup = lambda key: token_value if key == "GITHUB_TOKEN" else ""
        with make_fake_agent(lookup):
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
        with make_fake_agent(lambda key: ""):
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
        with make_fake_agent(lambda key: fake_token if key == "GITHUB_TOKEN" else ""):
            with patch.object(github, "_run_git") as mock_run:
                mock_run.return_value = (1, "", "Authentication failed")
                with self.assertRaises(github.GitHubError) as ctx:
                    github.clone(self.home, "owner/repo", "/tmp/fake-clone")
                self.assertEqual(ctx.exception.status, 403)


class GhFallbackTests(unittest.TestCase):
    """Which login `gh` is asked for when the home's own `.env` holds no token.

    `gh auth token` answers from its config's login, but ``GITHUB_TOKEN``/``GH_TOKEN`` in its
    environment shadow that login outright — and for a background thread the process's copy is the
    launch profile's value, a token the profile being read was never given.
    """

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="gots-gh-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        self.launch = self.root / "default"
        self.home = self.root / "lobsterink"
        for home in (self.launch, self.home):
            home.mkdir()

    def _ask(self, home=None):
        """Run _gh_cli_token over a faked `gh`, and hand back the environment it was given."""
        calls = []
        constants = ModuleType("hermes_constants")
        constants.get_routing_process_hermes_home = lambda: str(self.launch)

        def run(command, **kwargs):
            calls.append((command, kwargs))
            return SimpleNamespace(returncode=0, stdout="ghp_gh_login\n")

        with patch.object(github.shutil, "which", return_value="/usr/bin/gh"), patch.object(
            github.subprocess, "run", run
        ), patch.object(github, "_gh_cli_token", GH_CLI_TOKEN), patch.dict(
            "sys.modules", {"hermes_constants": constants}
        ):
            value = github._gh_cli_token(home or self.home)
        self.assertEqual(value, "ghp_gh_login")
        self.assertEqual(len(calls), 1)
        return calls[0][1]["env"]

    def test_another_homes_gh_is_not_handed_the_processes_token(self):
        with patch.dict(os.environ, {"GITHUB_TOKEN": "ghp_launch", "GH_TOKEN": "ghp_launch"}):
            env = self._ask()

        self.assertNotIn("GITHUB_TOKEN", env)
        self.assertNotIn("GH_TOKEN", env)

    def test_the_launch_homes_gh_keeps_the_token_it_exported(self):
        """A host that exports its token and keeps no `.env` copy leans on gh's own fallback."""
        with patch.dict(os.environ, {"GITHUB_TOKEN": "ghp_launch"}):
            env = self._ask(self.launch)

        self.assertEqual(env["GITHUB_TOKEN"], "ghp_launch")

    def test_gh_reads_the_homes_own_login_when_it_keeps_one(self):
        config = self.home / ".config" / "gh"
        config.mkdir(parents=True)

        env = self._ask()

        self.assertEqual(env["GH_CONFIG_DIR"], str(config))

    def test_gh_keeps_the_machines_login_when_the_home_has_none(self):
        with patch.dict(os.environ, {"GH_CONFIG_DIR": "/home/someone/.config/gh"}):
            env = self._ask()

        self.assertEqual(env["GH_CONFIG_DIR"], "/home/someone/.config/gh")


if __name__ == "__main__":
    unittest.main()
