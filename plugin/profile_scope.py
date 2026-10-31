"""This home's own secret scope, for a credential read made where no request's scope is set.

The plugin can run inside one Hermes process serving several profiles. A read made outside a request
— a project clone in a background thread, an AFK sweep on the gateway's loop — inherits no scope, so
``get_secret`` raises ``UnscopedSecretError`` under multiplexing, and a read that quietly succeeds
answers the launch profile's key for every home. Both callers build the scope from the home they are
working in and leave a scope that is already installed alone, because that one is the caller's.

One module rather than a copy in each caller: a fix to how a home's scope is built (a renamed core
helper, another part of the profile a scope carries) has to reach every read that depends on it.
"""

from __future__ import annotations

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
