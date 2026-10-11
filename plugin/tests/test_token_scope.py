"""Tests for token() secret scope setup in background threads.

Project clones run in a background thread (clones.spawn creates
threading.Thread), where Python ContextVars do not propagate.  When no
secret scope is active, get_env_prefer_dotenv -> get_secret raises
UnscopedSecretError under multiplexing.  token() must build and install
a profile scope from hermes_home so the token resolves correctly.
"""

import sys
import unittest
from pathlib import Path
from types import ModuleType
from unittest.mock import MagicMock, patch

from plugin import github


def _inject_fake_agent(lookup_fn, scope_already=None):
    """Inject fake agent.credential_pool and agent.secret_scope modules.

    ``lookup_fn`` is the fake get_env_prefer_dotenv.
    ``scope_already`` — when not None — simulates an already-active scope
    by making current_secret_scope return it, so token() should NOT
    build a new one.
    """
    fake_agent = ModuleType("agent")

    fake_pool = ModuleType("agent.credential_pool")
    fake_pool.get_env_prefer_dotenv = lookup_fn
    fake_agent.credential_pool = fake_pool

    fake_scope = ModuleType("agent.secret_scope")
    fake_scope.current_secret_scope = MagicMock(return_value=scope_already)
    fake_scope.build_profile_secret_scope = MagicMock(return_value={})
    fake_scope.set_secret_scope = MagicMock(return_value="fake_scope_token")
    fake_scope.reset_secret_scope = MagicMock()
    fake_agent.secret_scope = fake_scope

    return patch.dict("sys.modules", {
        "agent": fake_agent,
        "agent.credential_pool": fake_pool,
        "agent.secret_scope": fake_scope,
    })


class TokenScopeTests(unittest.TestCase):
    def setUp(self):
        self.home = Path("/fake/hermes_home")

    def test_sets_up_scope_when_none_active(self):
        """token() builds a scope from hermes_home when none is active."""
        with _inject_fake_agent(lambda key: "ghp_tok_1" if key == "GITHUB_TOKEN" else "") as cm:
            token, source = github.token(self.home)
            fake_scope = sys.modules["agent.secret_scope"]

        self.assertEqual(token, "ghp_tok_1")
        self.assertEqual(source, "env")
        self.assertTrue(fake_scope.current_secret_scope.called)
        self.assertTrue(fake_scope.set_secret_scope.called)

    def test_resets_scope_after_use(self):
        """token() must reset the scope it installed (finally block)."""
        with _inject_fake_agent(lambda key: "ghp_tok_1" if key == "GITHUB_TOKEN" else "") as cm:
            github.token(self.home)
            fake_scope = sys.modules["agent.secret_scope"]

        self.assertTrue(fake_scope.set_secret_scope.called)
        self.assertTrue(fake_scope.reset_secret_scope.called)

    def test_does_not_override_existing_scope(self):
        """When a scope is already active, token() should not set a new one."""
        existing = {"GITHUB_TOKEN": "ghp_existing"}
        with _inject_fake_agent(
            lambda key: "ghp_tok_1" if key == "GITHUB_TOKEN" else "",
            scope_already=existing,
        ) as cm:
            token, source = github.token(self.home)
            fake_scope = sys.modules["agent.secret_scope"]

        self.assertEqual(token, "ghp_tok_1")
        self.assertFalse(fake_scope.set_secret_scope.called)

    def test_falls_through_to_gh_cli(self):
        """With no env token, fall to gh CLI token."""
        with _inject_fake_agent(lambda key: "", scope_already=None):
            with patch.object(github, "_gh_cli_token", return_value="ghp_gh_cli"):
                token, source = github.token(self.home)

        self.assertEqual(token, "ghp_gh_cli")
        self.assertEqual(source, "gh")

    def test_returns_none_when_nothing_available(self):
        """token() returns (None, None) when no credential is found."""
        with _inject_fake_agent(lambda key: "", scope_already=None):
            with patch.object(github, "_gh_cli_token", return_value=None):
                token, source = github.token(self.home)

        self.assertIsNone(token)
        self.assertIsNone(source)

    def test_import_error_falls_through(self):
        """If agent.secret_scope is unavailable, token() still works."""
        fake_agent = ModuleType("agent")
        fake_pool = ModuleType("agent.credential_pool")
        fake_pool.get_env_prefer_dotenv = lambda key: "ghp_fallback" if key == "GITHUB_TOKEN" else ""
        fake_agent.credential_pool = fake_pool

        with patch.dict("sys.modules", {"agent": fake_agent, "agent.credential_pool": fake_pool}):
            token, source = github.token(self.home)

        self.assertEqual(token, "ghp_fallback")
        self.assertEqual(source, "env")


if __name__ == "__main__":
    unittest.main()
