"""Tests for token()'s profile scope in background threads.

Project clones run in a background thread (clones.spawn creates threading.Thread), where Python
contextvars do not propagate: the thread starts with no home override and no secret scope. token()
must install the scope of the home it was given, so a bot that isn't the host's launch profile
clones with its own GitHub token and not the launch profile's.

`HomeScopeTests` fakes the host the way it behaves: `get_env_prefer_dotenv` prefers the `.env` its
home override names and only then falls to the secret scope, so a scope alone answers the launch
profile's token.
"""

import shutil
import sys
import tempfile
import threading
import unittest
from contextvars import ContextVar
from pathlib import Path
from types import ModuleType
from typing import Dict, Optional
from unittest.mock import patch

from plugin import github
from plugin.tests._helpers import make_fake_agent


def _env_of(home: Path) -> Dict[str, str]:
    """One home's `.env`, as the host's own tokenizer reads it."""
    values: Dict[str, str] = {}
    path = Path(home) / ".env"
    if not path.exists():
        return values
    for line in path.read_text().splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        values[key.strip()] = value.strip()
    return values


class HomeScopeTests(unittest.TestCase):
    """A bare thread — the one clones.spawn starts — reads the home it was given."""

    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="gots-profile-scope-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        self.launch = self.root / "default"
        self.second = self.root / "lobsterink"
        for home in (self.launch, self.second):
            home.mkdir(parents=True)
        (self.launch / ".env").write_text("GITHUB_TOKEN=ghp_launch_profile\n")
        (self.second / ".env").write_text("GITHUB_TOKEN=ghp_lobsterink_profile\n")

        # The host's two seams: which profile's .env a read sees, and whose secrets it holds.
        self.override: ContextVar[Optional[str]] = ContextVar("test-home-override", default=None)
        self.scope: ContextVar[Optional[tuple]] = ContextVar("test-secret-scope", default=None)

        constants = ModuleType("hermes_constants")
        constants.get_hermes_home = lambda: str(self.launch)  # type: ignore[attr-defined]
        constants.get_hermes_home_override = self.override.get  # type: ignore[attr-defined]
        constants.set_hermes_home_override = lambda path: self.override.set(str(path))  # type: ignore[attr-defined]
        constants.reset_hermes_home_override = self.override.reset  # type: ignore[attr-defined]

        agent = ModuleType("agent")
        pool = ModuleType("agent.credential_pool")
        secrets = ModuleType("agent.secret_scope")

        def prefer_dotenv(key: str) -> str:
            """The host's own order: the override's `.env` first, then the installed scope."""
            home = Path(self.override.get() or self.launch)
            held = self.scope.get()
            return _env_of(home).get(key, "") or (held[1].get(key, "") if held else "")

        def set_secret_scope(mapping, *, profile_home=None):  # type: ignore[no-untyped-def]
            return self.scope.set((str(profile_home or ""), dict(mapping)))

        pool.get_env_prefer_dotenv = prefer_dotenv  # type: ignore[attr-defined]
        secrets.build_profile_secret_scope = _env_of  # type: ignore[attr-defined]
        secrets.current_secret_scope = lambda: (self.scope.get() or (None, None))[1]  # type: ignore[attr-defined]
        secrets.current_secret_scope_home = lambda: (self.scope.get() or (None, None))[0]  # type: ignore[attr-defined]
        secrets.set_secret_scope = set_secret_scope  # type: ignore[attr-defined]
        secrets.reset_secret_scope = self.scope.reset  # type: ignore[attr-defined]
        agent.credential_pool = pool  # type: ignore[attr-defined]
        agent.secret_scope = secrets  # type: ignore[attr-defined]

        patcher = patch.dict(
            "sys.modules",
            {
                "agent": agent,
                "agent.credential_pool": pool,
                "agent.secret_scope": secrets,
                "hermes_constants": constants,
            },
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    def _in_bare_thread(self, home: Path) -> dict:
        """token() as a clone thread calls it: nothing carried in."""
        box: dict = {}

        def work() -> None:
            try:
                box["value"] = github.token(home)
            except BaseException as error:  # noqa: BLE001 - the test wants the whole failure
                box["error"] = f"{type(error).__name__}: {error}"

        thread = threading.Thread(target=work)
        thread.start()
        thread.join()
        return box

    def test_a_clone_thread_reads_its_own_homes_token(self) -> None:
        """The launch profile's token must not stand in for another profile's."""
        box = self._in_bare_thread(self.second)

        self.assertNotIn("error", box)
        self.assertEqual(box["value"], ("ghp_lobsterink_profile", "env"))

    def test_the_launch_homes_token_is_unchanged(self) -> None:
        box = self._in_bare_thread(self.launch)

        self.assertEqual(box["value"], ("ghp_launch_profile", "env"))

    def test_a_scope_for_another_home_is_replaced(self) -> None:
        """Work that arrives carrying the launch profile's scope, as a resume on its thread does."""
        self.scope.set((str(self.launch), {"GITHUB_TOKEN": "ghp_launch_profile"}))
        self.addCleanup(self.scope.set, None)

        box = self._in_bare_thread(self.second)

        self.assertEqual(box["value"], ("ghp_lobsterink_profile", "env"))
        self.assertEqual(
            self.scope.get(), (str(self.launch), {"GITHUB_TOKEN": "ghp_launch_profile"})
        )


class TokenScopeTests(unittest.TestCase):
    def setUp(self):
        self.home = Path("/fake/hermes_home")

    def test_sets_up_scope_when_none_active(self):
        """token() builds a scope from hermes_home when none is active."""
        with make_fake_agent(lambda key: "ghp_tok_1" if key == "GITHUB_TOKEN" else "") as cm:
            token, source = github.token(self.home)
            fake_scope = sys.modules["agent.secret_scope"]

        self.assertEqual(token, "ghp_tok_1")
        self.assertEqual(source, "env")
        self.assertTrue(fake_scope.current_secret_scope.called)
        self.assertTrue(fake_scope.set_secret_scope.called)

    def test_resets_scope_after_use(self):
        """token() must reset the scope it installed (finally block)."""
        with make_fake_agent(lambda key: "ghp_tok_1" if key == "GITHUB_TOKEN" else "") as cm:
            github.token(self.home)
            fake_scope = sys.modules["agent.secret_scope"]

        self.assertTrue(fake_scope.set_secret_scope.called)
        self.assertTrue(fake_scope.reset_secret_scope.called)

    def test_does_not_override_existing_scope(self):
        """When a scope is already active, token() should not set a new one."""
        existing = {"GITHUB_TOKEN": "ghp_existing"}
        with make_fake_agent(
            lambda key: "ghp_tok_1" if key == "GITHUB_TOKEN" else "",
            scope_already=existing,
        ) as cm:
            token, source = github.token(self.home)
            fake_scope = sys.modules["agent.secret_scope"]

        self.assertEqual(token, "ghp_tok_1")
        self.assertFalse(fake_scope.set_secret_scope.called)

    def test_falls_through_to_gh_cli(self):
        """With no env token, fall to gh CLI token."""
        with make_fake_agent(lambda key: "", scope_already=None):
            with patch.object(github, "_gh_cli_token", return_value="ghp_gh_cli"):
                token, source = github.token(self.home)

        self.assertEqual(token, "ghp_gh_cli")
        self.assertEqual(source, "gh")

    def test_returns_none_when_nothing_available(self):
        """token() returns (None, None) when no credential is found."""
        with make_fake_agent(lambda key: "", scope_already=None):
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