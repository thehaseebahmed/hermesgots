"""Tests for github.token() credential resolution via get_env_prefer_dotenv."""

import sys
import unittest
from pathlib import Path
from types import ModuleType
from unittest.mock import MagicMock, patch

from plugin import github


def _inject_fake_credential_pool(lookup_fn):
    """Inject a fake agent.credential_pool module so the deferred import resolves."""
    fake_agent = ModuleType("agent")
    fake_pool = ModuleType("agent.credential_pool")
    fake_pool.get_env_prefer_dotenv = lookup_fn
    fake_agent.credential_pool = fake_pool
    return patch.dict("sys.modules", {"agent": fake_agent, "agent.credential_pool": fake_pool})


class TokenResolutionTests(unittest.TestCase):
    def setUp(self):
        self.home = Path("/fake/hermes_home")

    def test_github_token_resolves(self):
        with _inject_fake_credential_pool(lambda key: "ghp_abc123" if key == "GITHUB_TOKEN" else ""):
            token, source = github.token(self.home)
        self.assertEqual(token, "ghp_abc123")
        self.assertEqual(source, "env")

    def test_gh_token_fallback_when_github_token_empty(self):
        def lookup(key):
            return "ghp_from_gh_var" if key == "GH_TOKEN" else ""

        with _inject_fake_credential_pool(lookup):
            token, source = github.token(self.home)
        self.assertEqual(token, "ghp_from_gh_var")
        self.assertEqual(source, "env")

    def test_github_token_takes_precedence_over_gh_token(self):
        def lookup(key):
            return {"GITHUB_TOKEN": "ghp_primary", "GH_TOKEN": "ghp_secondary"}.get(key, "")

        with _inject_fake_credential_pool(lookup):
            token, _ = github.token(self.home)
        self.assertEqual(token, "ghp_primary")

    def test_whitespace_is_trimmed(self):
        with _inject_fake_credential_pool(lambda key: "  ghp_padded  \n"):
            token, _ = github.token(self.home)
        self.assertEqual(token, "ghp_padded")

    def test_whitespace_only_value_is_treated_as_empty(self):
        def lookup(key):
            return "   \n" if key == "GITHUB_TOKEN" else ""

        with (
            _inject_fake_credential_pool(lookup),
            patch.object(github, "_gh_cli_token", return_value="gho_cli_token"),
        ):
            token, source = github.token(self.home)
        self.assertEqual(token, "gho_cli_token")
        self.assertEqual(source, "gh")

    def test_falls_back_to_gh_cli_when_no_env_var(self):
        with (
            _inject_fake_credential_pool(lambda key: ""),
            patch.object(github, "_gh_cli_token", return_value="gho_cli_token"),
        ):
            token, source = github.token(self.home)
        self.assertEqual(token, "gho_cli_token")
        self.assertEqual(source, "gh")

    def test_returns_none_when_nothing_available(self):
        with (
            _inject_fake_credential_pool(lambda key: ""),
            patch.object(github, "_gh_cli_token", return_value=None),
        ):
            token, source = github.token(self.home)
        self.assertIsNone(token)
        self.assertIsNone(source)

    def test_does_not_read_os_environ_directly(self):
        """A token in os.environ must not leak if get_env_prefer_dotenv returns empty.

        This is the profile-isolation guard: os.environ holds the launch profile's
        values, so a bare os.environ read would silently use the wrong profile's token.
        """
        with (
            _inject_fake_credential_pool(lambda key: ""),
            patch.object(github, "_gh_cli_token", return_value=None),
            patch.dict("os.environ", {"GITHUB_TOKEN": "ghp_leaked_from_launch_profile"}),
        ):
            token, _ = github.token(self.home)
        self.assertIsNone(token, "token() must not fall back to os.environ")

    def test_import_is_deferred(self):
        """The agent.credential_pool import must be inside token(), not module-level."""
        import inspect

        source = inspect.getsource(github.token)
        self.assertIn("from agent.credential_pool import", source)


if __name__ == "__main__":
    unittest.main()
