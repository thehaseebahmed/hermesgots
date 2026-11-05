"""The messages a session is holding, and the turn a restart lost out from under them.

Hermes admits every prompt to a session's own FIFO (``session_admissions``) rather than refusing it
while a turn runs. A turn whose owner restarted mid-execution cannot be known to have finished, so
it is fenced ``unknown`` and everything queued behind it waits — a state only a client of the
gateway can clear, with ``prompt.resolve_unknown`` (the TUI's ``/discard`` and ``hermes sessions
discard``). The app reaches neither, so a session stuck this way shows a queue that never moves and
no way to move it: this module is the app's door to the same ledger.

It reads the rows the ledger itself keeps (``list_session_admissions``) and acknowledges a lost turn
through the authority that owns them (``resolve_unknown_as_owner``), which is the same resolution the
gateway makes when the last viewer leaves a session whose turn recovered ``unknown``. Nothing here
requeues or replays the lost input: it stays in the transcript to be sent again, as Hermes's own
discard leaves it.
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import nullcontext
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

# The rows a client is shown: one still in line, and one the host cannot say finished. A ``started``
# row is the turn actually running, not something waiting behind anything.
SHOWN = ("queued", "unknown")
LOST = "unknown"
# What the app reads a lost row as saying; Hermes words its own notice the same way (its canonical
# ``lostRow``), and a client that predates the wording still reads the status this names.
MAX_TEXT = 8_000


class PendingError(Exception):
    """Something the app asked for can't be done here, said in words it can show."""

    def __init__(self, message: str, status: int = 502) -> None:
        super().__init__(message)
        self.status = status


def owner_scope(owner: Any) -> Any:
    """``owner``'s own profile scope, for work done for the home it serves.

    A gateway hosting several profiles reads config and credentials per profile; owner-side work
    belongs in the owning profile's scope. A single-profile gateway and a Hermes without the helper
    both read in the ambient one, which is the same thing there.
    """
    try:
        from gateway.session_authorities import owner_scope as scope
    except ImportError:
        return nullcontext()
    try:
        return scope(owner)
    except Exception:
        return nullcontext()


def authority(adapter: Any, home: Path) -> Any:
    """The session authority serving ``home``, or ``None`` on a Hermes that has none.

    A gateway without one keeps no FIFO, so a session there can never be fenced ``unknown`` and
    nothing is waiting behind anything: the read answers empty rather than failing.
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
        logger.debug("memento: couldn't resolve the session authority for %s", home, exc_info=True)
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
    return text[:MAX_TEXT] if isinstance(text, str) else ""


def view(rows: Any) -> Dict[str, Any]:
    """What the app reads of a session's pending rows: what waits, in line, and what was lost.

    ``lost`` names the row the host cannot say finished — the FIFO's first ``unknown``, which is the
    one that holds everything behind it. More than one is listed as it comes: each is its own
    acknowledgement, and the TUI asks for each in turn the same way.
    """
    items: List[Dict[str, Any]] = []
    lost: Optional[str] = None
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict) or row.get("status") not in SHOWN:
            continue
        admission_id = row.get("admission_id")
        if not isinstance(admission_id, str) or not admission_id:
            continue
        status = str(row.get("status"))
        items.append({"id": admission_id, "text": public_text(row.get("payload")), "status": status})
        if status == LOST and lost is None:
            lost = admission_id
    return {"items": items, "lost": lost, "paused": lost is not None}


def read(owner: Any, session_id: str) -> Dict[str, Any]:
    """A session's pending rows, read from the ledger through the authority that owns them."""
    if owner is None:
        return view([])
    try:
        from hermes_state_runtime import list_session_admissions
    except ImportError:
        return view([])
    try:
        rows = list_session_admissions(owner.db, session_id=session_id)
    except Exception:
        logger.warning("memento: couldn't read the pending rows for %s", session_id, exc_info=True)
        raise PendingError("The host couldn't read this session's queue.", 502)
    return view(rows)


def read_for(adapter: Any, home: Path, session_id: str) -> Dict[str, Any]:
    """``read`` for a request: resolves the profile's authority first, on whatever thread it runs."""
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
    try:
        from gateway.session_contract import SessionRef
        from hermes_state_runtime import get_session_admission
    except ImportError:
        raise PendingError("This Hermes can't discard a lost turn.", 501)
    resolve = getattr(owner, "resolve_unknown_as_owner", None)
    if not callable(resolve):
        raise PendingError("This Hermes can't discard a lost turn.", 501)
    try:
        row = get_session_admission(owner.db, admission_id=admission_id)
    except Exception:
        row = None
    if (
        not isinstance(row, dict)
        or row.get("target_session_id") != session_id
        or row.get("status") != LOST
    ):
        raise PendingError("That turn isn't waiting to be discarded any more.", 409)
    generation = row.get("generation")
    with owner_scope(owner):
        try:
            await asyncio.to_thread(ensure_live, owner, session_id)
            ref = SessionRef(owner.profile_id, session_id)
            await resolve(ref, admission_id, generation)
        except Exception as error:
            reason = getattr(error, "reason", "")
            if reason in ("stale_generation", "not_found"):
                raise PendingError("That turn isn't waiting to be discarded any more.", 409)
            logger.warning("memento: couldn't discard a lost turn on %s", session_id, exc_info=True)
            raise PendingError("The host couldn't discard that turn.", 502)
    return read(owner, session_id)


async def discard_for(adapter: Any, home: Path, session_id: str, admission_id: str) -> Dict[str, Any]:
    """``discard`` for a request; the read after it costs one indexed select."""
    return await discard(authority(adapter, home), session_id, admission_id)
