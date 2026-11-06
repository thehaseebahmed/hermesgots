"""The messages a session is holding, and the turn a restart lost out from under them.

Hermes admits every prompt to a session's own FIFO (``session_admissions``) rather than refusing it
while a turn runs. A turn whose owner restarted mid-execution cannot be known to have finished, so
it is fenced ``unknown`` and everything queued behind it waits — a state only a client of the
gateway can clear, with ``prompt.resolve_unknown`` (the TUI's ``/discard`` and ``hermes sessions
discard``). The app reaches neither, so a session stuck this way shows a queue that never moves and
no way to move it: this module is the app's door to the same ledger.

It reads the rows the ledger keeps (``list_session_admissions``) beside the authority serving the
profile, and acknowledges a lost turn through that authority (``resolve_unknown_as_owner``), which is
the same resolution the gateway makes when the last viewer leaves a session whose turn recovered
``unknown``. Nothing here requeues or replays the lost input: it stays in the transcript to be sent
again, as Hermes's own discard leaves it.
"""

from __future__ import annotations

import asyncio
import importlib
import logging
from contextlib import nullcontext
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

# The rows a client is shown: one still in line, and one the host cannot say finished. A ``started``
# row is the turn actually running, not something waiting behind anything — it crosses as `running`
# instead, so the app can tell a thread that is being filled from one it never got.
SHOWN = ("queued", "unknown")
RUNNING = "started"
LOST = "unknown"
# How much of each held message crosses to the app: a row draws one line of `ROW_TEXT_CHARS` (200,
# `app/src/lib/pending.ts`) and never reads past it, so the envelope is cut here.
WIRE_TEXT = 400
# What this route needs from Hermes, module by module — the read AND the restore. `available` reads
# the list, so a host missing one advertises no feature rather than answering an empty queue it
# never looked at.
BUILT_INS: Tuple[Tuple[str, Tuple[str, ...]], ...] = (
    ("hermes_state_runtime", ("get_session_admission", "list_session_admissions")),
    ("gateway.session_authorities", ("authority_for_home", "owner_scope")),
    ("gateway.session_contract", ("SessionRef",)),
    ("gateway.session_api", ("restore_api_session",)),
)
# The write is a method on the authority, not a module symbol, so the gate asks the class that
# defines it: a host that can read a queue but never clear one would hide the composer behind a card
# whose only control can't work.
OWNER_PATH = ("gateway.session_authority", "SessionAuthority", "resolve_unknown_as_owner")


class PendingError(Exception):
    """Something the app asked for can't be done here, said in words it can show."""

    def __init__(self, message: str, status: int = 502) -> None:
        super().__init__(message)
        self.status = status


def available() -> Optional[str]:
    """Why this Hermes can't be asked, or ``None`` where it can.

    A host missing any of these would either answer "nothing is waiting" about a session it never
    read — the claim the app draws a card from — or draw a card whose only control can never work.
    """
    for module, names in BUILT_INS:
        try:
            found = importlib.import_module(module)
        except ImportError as error:
            return f"This Hermes has no session admission ledger ({error})."
        for name in names:
            if not hasattr(found, name):
                return f"This Hermes's session ledger has moved ({module}.{name})."
    module, holder, method = OWNER_PATH
    try:
        defined = getattr(importlib.import_module(module), holder, None)
    except ImportError as error:
        return f"This Hermes has no session admission ledger ({error})."
    if not callable(getattr(defined, method, None)):
        return f"This Hermes's session ledger has moved ({module}.{holder}.{method})."
    return None


def _owner_scope(owner: Any) -> Any:
    """The owning profile's scope for work done for the home it serves.

    A gateway hosting several profiles reads config and credentials per profile, so owner-side work
    belongs in the owning profile's scope; a Hermes too old to offer the helper reads in the ambient
    one, which is the same thing on a single-profile host. A helper that is there and fails is not
    that case — running the resolution in the launch profile's scope would read another profile's
    config, so it is refused rather than guessed. Kept private: `plugin/profile_scope.py` exports a
    different `profile_scope`, which takes a home and installs a secret scope.
    """
    try:
        from gateway.session_authorities import owner_scope
    except ImportError:
        return nullcontext()
    try:
        return owner_scope(owner)
    except Exception as error:
        logger.warning("gots: couldn't scope this session to its own profile", exc_info=True)
        raise PendingError("The host couldn't work in that session's profile.", 502) from error


def authority(adapter: Any, home: Path) -> Any:
    """The session authority serving ``home``, or ``None`` on a Hermes or a home that has none.

    A gateway without one keeps no FIFO, so a session there can never be fenced ``unknown`` — but a
    home no authority serves also can't be read, which is why ``read`` refuses rather than calling
    that an empty queue.
    """
    runner = getattr(adapter, "gateway_runner", None)
    if runner is None:
        return None
    try:
        from gateway.session_authorities import authority_for_home
    except ImportError:
        return None
    try:
        return authority_for_home(runner, home)
    except Exception:
        logger.debug("gots: couldn't resolve the session authority for %s", home, exc_info=True)
        return None


def public_text(payload: Any) -> str:
    """The words a queued row carries, as its sender typed them.

    Hermes reads them the same way for a viewer (``_pending_receipt``): the plain ``text`` a local
    surface submits, else the native envelope's event text. Nothing else in the payload crosses —
    it holds the run's instructions and the sender's provenance, which are the host's.
    """
    if not isinstance(payload, dict):
        return ""
    text = payload.get("text")
    if text is None:
        native = payload.get("native_text_v1")
        event = native.get("event") if isinstance(native, dict) else None
        text = event.get("text") if isinstance(event, dict) else None
    return text[:WIRE_TEXT] if isinstance(text, str) else ""


def view(rows: Any) -> Dict[str, Any]:
    """What the app reads of a session's pending rows: what waits, in order, and which row was lost.

    ``lost`` names the row the host cannot say finished — the FIFO's first ``unknown``, the one that
    holds everything behind it. The rest wait, queued or unknown alike, each let go in its turn.
    ``running`` says the host is executing a turn for this session: the queue has drained into one,
    and a thread that is still empty is being written rather than missing.
    """
    items: List[Dict[str, Any]] = []
    lost: Optional[str] = None
    running = False
    for row in rows:
        if not isinstance(row, dict):
            continue
        status = row.get("status")
        admission_id = row.get("admission_id")
        if status == RUNNING:
            running = True
        elif status in SHOWN and isinstance(admission_id, str) and admission_id:
            items.append({"id": admission_id, "text": public_text(row.get("payload"))})
            if status == LOST and lost is None:
                lost = admission_id
    return {"items": items, "lost": lost, "running": running}


def read(owner: Any, session_id: str) -> Dict[str, Any]:
    """A session's pending rows, read from the ledger beside the authority that owns them."""
    if owner is None:
        raise PendingError("This Hermes can't read a session's queue.", 501)
    from hermes_state_runtime import list_session_admissions

    try:
        rows = list_session_admissions(owner.db, session_id=session_id)
    except Exception:
        logger.warning("gots: couldn't read the pending rows for %s", session_id, exc_info=True)
        raise PendingError("The host couldn't read this session's queue.", 502)
    # A reader that answered something other than rows (a schema that moved, a stub) is a read that
    # failed, never an empty queue: "nothing is waiting" is the one answer this route must not guess.
    if not isinstance(rows, (list, tuple)):
        logger.warning("gots: %s answered %r, not rows", session_id, type(rows).__name__)
        raise PendingError("The host couldn't read this session's queue.", 502)
    return view(rows)


def read_for(adapter: Any, home: Path, session_id: str) -> Dict[str, Any]:
    return read(authority(adapter, home), session_id)


def ensure_live(owner: Any, session_id: str) -> None:
    """Puts a session the owner isn't holding yet back in front of it, as startup recovery does.

    A resolution publishes to the session's viewers and schedules its queue, so the owner has to know
    the session (``SessionAuthority.sessions``). A chat the app made is an API session with its
    binding kept on the profile, which is exactly what ``restore_api_session`` rebuilds; a row that
    is not one is nothing this route can speak for, and says so rather than guessing.
    """
    if session_id in owner.sessions:
        return
    from gateway.session_api import restore_api_session

    restore_api_session(owner, session_id)


async def discard(owner: Any, session_id: str, admission_id: str) -> Dict[str, Any]:
    """Acknowledges a lost turn so the queue behind it runs, and answers what is left waiting.

    Fenced exactly as Hermes's own resolution is: the row must still be ``unknown`` on this session,
    and its generation is the one the owner stamped. A row that moved on since the app read it is
    refused rather than acknowledged twice, which is what the app's stale card would otherwise do.
    """
    if owner is None:
        raise PendingError("This Hermes can't discard a lost turn.", 501)
    from gateway.session_contract import SessionRef
    from hermes_state_runtime import get_session_admission

    resolve = getattr(owner, "resolve_unknown_as_owner", None)
    if not callable(resolve):
        raise PendingError("This Hermes can't discard a lost turn.", 501)
    try:
        row = await asyncio.to_thread(get_session_admission, owner.db, admission_id=admission_id)
    except Exception:
        logger.warning("gots: couldn't read a lost turn on %s", session_id, exc_info=True)
        raise PendingError("The host couldn't read this session's queue.", 502)
    # A row of another session, or one that already settled, is the app's card gone stale: refused in
    # the same words, since the screen's only move either way is to read the queue again.
    if (
        not isinstance(row, dict)
        or row.get("target_session_id") != session_id
        or row.get("status") != LOST
    ):
        raise PendingError("That turn isn't waiting to be discarded any more.", 409)
    generation = row.get("generation")
    with _owner_scope(owner):
        # Restoring the session is the host putting its own house in order; a failure there is the
        # host's, never the card's (409 would tell the reader the turn moved on, which it hasn't).
        try:
            await asyncio.to_thread(ensure_live, owner, session_id)
        except Exception:
            logger.warning("gots: couldn't restore %s to discard", session_id, exc_info=True)
            raise PendingError("The host couldn't restore that session to discard the turn.", 502)
        try:
            await resolve(SessionRef(owner.profile_id, session_id), admission_id, generation)
        except Exception as error:
            reason = getattr(error, "reason", "")
            if reason in ("stale_generation", "not_found"):
                raise PendingError("That turn isn't waiting to be discarded any more.", 409)
            logger.warning("gots: couldn't discard a lost turn on %s", session_id, exc_info=True)
            raise PendingError("The host couldn't discard that turn.", 502)
    return await asyncio.to_thread(read, owner, session_id)


async def discard_for(adapter: Any, home: Path, session_id: str, admission_id: str) -> Dict[str, Any]:
    return await discard(authority(adapter, home), session_id, admission_id)


# The row `info` advertises, in the shape `mcp.FEATURES` and `skill_catalog.FEATURES` have: the gate
# is the family's own availability, so a host that can't serve it advertises nothing rather than a
# card drawn over a queue nothing read.
FEATURES: Tuple[Tuple[str, Callable[[], Optional[str]]], ...] = (("pending", available),)
