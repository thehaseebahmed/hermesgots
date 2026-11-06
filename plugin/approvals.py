"""Approvals that stop waiting without an answer through Hermes's own route.

``POST /v1/runs/{id}/approval`` puts ``approval.responded`` on the run's stream and sets its status
back to ``running``. An approval that times out, is withdrawn (the turn was stopped, the notify
failed) or is answered by the plugin itself (a session switched to Auto) does neither: the run's
status keeps the old request until the run moves on, so every client still shows it waiting, and
answering it then is refused with ``approval_not_pending``. Hermes fires ``post_approval_response``
for every ending, so the hook does both for those, the way ``clarify.py`` ends a question.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Optional

from . import events

logger = logging.getLogger(__name__)

WAITING = "waiting_for_approval"
# What a client answered: Hermes's own route has already told the stream.
CHOICES = frozenset({"once", "session", "always", "deny"})

# The API server adapter and its event loop, kept by _wire_api_server: the hook runs on the agent's
# thread, and a run's stream is an asyncio queue on the loop.
adapter: Any = None
loop: Optional[asyncio.AbstractEventLoop] = None


def settled(**kwargs: Any) -> None:
    """The ``post_approval_response`` hook. Never raises: it runs inside Hermes's approval wait."""
    try:
        choice = kwargs.get("choice")
        if choice in CHOICES:
            return
        run_id = kwargs.get("session_key")
        if isinstance(run_id, str) and run_id and not _still_waiting(run_id):
            announce(run_id, str(choice or "timeout"))
    except Exception:
        logger.debug("gots: couldn't settle an approval", exc_info=True)


def announce(run_id: str, choice: str) -> bool:
    """Tells the run's clients its approval no longer waits: ``approval.responded`` on the stream,
    and the status back to running. Only for a run whose status still shows the approval."""
    statuses = getattr(adapter, "_run_statuses", None)
    status = statuses.get(run_id) if isinstance(statuses, dict) else None
    if not isinstance(status, dict) or status.get("status") != WAITING or not status.get("approval"):
        return False
    setter = getattr(adapter, "_set_run_status", None)
    if callable(setter):
        setter(run_id, "running", last_event="approval.responded")
    streams = getattr(adapter, "_run_streams", None)
    stream = streams.get(run_id) if isinstance(streams, dict) else None
    if stream is not None and loop is not None:
        event = {
            "event": "approval.responded",
            "run_id": run_id,
            "timestamp": time.time(),
            "choice": choice,
        }
        try:
            loop.call_soon_threadsafe(stream.put_nowait, event)
        except RuntimeError:
            # The loop has closed; nobody is listening.
            pass
    events.note("runs", status.get("session_id") or None, None, True)
    return True


def _still_waiting(run_id: str) -> bool:
    """Whether another request of the run (a parallel tool's) still waits on the user."""
    try:
        from tools.approval import list_gateway_approvals
    except ImportError:
        return False
    return bool(list_gateway_approvals(run_id))
