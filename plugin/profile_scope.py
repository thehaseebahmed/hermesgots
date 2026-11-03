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
from typing import Iterator


@contextmanager
def profile_scope(hermes_home: Path) -> Iterator[None]:
    """Installs ``hermes_home``'s profile scope unless a scope is already active.

    A Hermes too old to offer ``agent.secret_scope`` reads as it always did: no scope, no failure.
    """
    try:
        from agent.secret_scope import (
            build_profile_secret_scope,
            current_secret_scope,
            reset_secret_scope,
            set_secret_scope,
        )
    except ImportError:
        yield
        return
    if current_secret_scope() is not None:
        yield
        return
    reset = set_secret_scope(
        build_profile_secret_scope(Path(hermes_home)), profile_home=str(hermes_home)
    )
    try:
        yield
    finally:
        reset_secret_scope(reset)


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

