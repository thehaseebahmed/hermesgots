"""This home's own scope, for work a request did not scope: built from a home, or carried onto a thread.

The plugin can run inside one Hermes process serving several profiles. A read made outside a request
— a project clone in a background thread, an AFK sweep on the gateway's loop — inherits no scope, so
``get_secret`` raises ``UnscopedSecretError`` under multiplexing, and a read that quietly succeeds
answers the launch profile's key for every home.

One module rather than a copy in each caller: a fix to how a home's scope is built (a renamed core
helper, another part of the profile a scope carries) has to reach every read that depends on it.
"""

from __future__ import annotations

import contextvars
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, Optional


def same_home(first: Any, second: Any) -> bool:
    """Do both name the same directory? A host can hand one path written two ways."""
    try:
        return Path(first).resolve() == Path(second).resolve()
    except (OSError, TypeError, ValueError):
        return False


@contextmanager
def profile_scope(hermes_home: Path) -> Iterator[None]:
    """Installs ``hermes_home``'s profile scope unless one already names it.

    Two halves make a home's scope, and every read that depends on it needs both: the secret scope
    decides whose secrets ``get_secret`` answers, and the home override decides which ``.env`` and
    ``config.yaml`` a read that opens the files sees. ``get_env_prefer_dotenv`` prefers the dotenv,
    so a scope built without the override still answers the launch profile's ``.env`` — which is how
    a project clone for a secondary profile ran with the launch profile's GitHub token.

    A scope already bound to another home is replaced and put back afterwards: work that arrived
    carrying the launch profile's context (a resume on the gateway's thread) must not read that
    profile's credentials for this one. A host with no ``agent.secret_scope`` reads unscoped, as it
    always did; one without the override still gets the secret scope, which is what it used to do.
    """
    try:
        import agent.secret_scope as secrets
    except ImportError:
        yield
        return
    constants: Optional[Any]
    try:
        import hermes_constants as constants
    except ImportError:  # a Hermes old enough to have no home override at all
        constants = None

    home = Path(hermes_home)
    scope_token: Optional[Any] = None
    bound = getattr(secrets, "current_secret_scope_home", lambda: None)()
    if secrets.current_secret_scope() is None or (bound and not same_home(bound, home)):
        scope_token = secrets.set_secret_scope(
            secrets.build_profile_secret_scope(home), profile_home=str(home)
        )
    override_token: Optional[Any] = None
    set_override = getattr(constants, "set_hermes_home_override", None)
    reset_override = getattr(constants, "reset_hermes_home_override", None)
    if callable(set_override) and callable(reset_override):
        current = getattr(constants, "get_hermes_home_override", lambda: None)()
        if current is None or not same_home(current, home):
            override_token = set_override(str(home))
    try:
        yield
    finally:
        if override_token is not None:
            reset_override(override_token)
        if scope_token is not None:
            secrets.reset_secret_scope(scope_token)


def thread_scope() -> contextvars.Context:
    """This thread's context, for a thread of our own to run inside: ``scope.run(call)``.

    Hermes answers "which profile is this?" from context variables — ``_HERMES_HOME_OVERRIDE``, which
    decides the ``config.yaml`` a read sees, and ``_SECRET_SCOPE``, which decides whose ``.env`` a key
    comes from (ADR 0069 resolves a bot's speech provider per profile). A route runs inside
    ``asyncio.to_thread``, which copies them into its worker; a ``threading.Thread`` starts with none,
    so work launched there reads the launch profile's settings and credentials instead.

    Take the copy on the thread that HAS the scope — before starting the one that needs it — and
    enter it once at a time: ``Context.run`` refuses a context that is already running.
    """
    return contextvars.copy_context()

