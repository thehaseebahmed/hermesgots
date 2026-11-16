"""What a session's last run failed of, kept where every device can read it.

Hermes closes a turn it gave up on with one notice in the transcript for every failure — a provider's
refusal, a usage window spent, a stream that died — and keeps the provider's own words out of it. The
words ride the run's ending instead, which only a device watching the run sees. So the turn's own end
keeps them here, under the chat that failed, and a second device, or one opened the next morning,
reads the reason rather than the notice.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from .store import connect

logger = logging.getLogger(__name__)

# What Hermes calls a failure it has no words for: the notice says more than these do, so they are
# left behind and the app draws the notice (app/src/chat-next/state.ts guards them the same way).
WORDLESS = frozenset({"agent run failed", "run failed"})
# A provider's own answer, not a transcript: the app draws this on one line under the failed reply.
MAX_TEXT = 2000


def reason_of(adapter: Any, session_id: str) -> Optional[Tuple[str, int]]:
    """The newest run of the session, and the words it ended with where it failed, or None.

    Hermes keeps every run's pollable status on the adapter the API server serves, terminal ones
    kept for a while after they end — which is where a run's own `error` lives. Read at the turn's
    end, so the run it names is the one the turn was.
    """
    statuses = getattr(adapter, "_run_statuses", None)
    if not isinstance(statuses, dict) or not session_id:
        return None
    mine = [
        status
        for status in list(statuses.values())
        if isinstance(status, dict) and status.get("session_id") == session_id
    ]
    if not mine:
        return None
    latest = max(mine, key=lambda run: float(run.get("updated_at") or 0))
    if str(latest.get("status") or "") != "failed":
        return None
    said = latest.get("error")
    text = said.strip() if isinstance(said, str) else ""
    if not text or text.lower() in WORDLESS:
        return None
    return text[:MAX_TEXT], int(float(latest.get("updated_at") or 0))


def write(path: Path, session_id: str, text: str, at: int) -> None:
    """Keeps the session's newest failure, replacing an older one: a chat shows its last one."""
    conn = connect(path)
    try:
        conn.execute(
            "INSERT OR REPLACE INTO session_failures (session_id, text, at) VALUES (?, ?, ?)",
            (session_id, text, at),
        )
    finally:
        conn.close()


def read(path: Path, session_id: str) -> Optional[Dict[str, Any]]:
    """What the session's last failed run ended with, or None where nothing is kept."""
    if not session_id or not path.exists():
        return None
    conn = connect(path)
    try:
        row = conn.execute(
            "SELECT text, at FROM session_failures WHERE session_id = ?", (session_id,)
        ).fetchone()
    finally:
        conn.close()
    return {"text": row[0], "at": row[1]} if row else None


def clear(path: Path, session_id: str) -> None:
    """Forgets a session's failure: nothing reads a chat that is gone."""
    if not path.exists():
        return
    conn = connect(path)
    try:
        conn.execute("DELETE FROM session_failures WHERE session_id = ?", (session_id,))
    finally:
        conn.close()


def after_run(**kwargs: Any) -> None:
    """The ``on_session_end`` hook: a turn that failed keeps what its run ended with."""
    try:
        if not kwargs.get("failed") or kwargs.get("interrupted"):
            return
        session_id = kwargs.get("session_id") or ""
        if not session_id:
            return
        from . import sessions

        path, home = sessions._paths()
        # Only one of the app's chats: another surface's session has no chat to draw it in, and its
        # store is not this one's to grow.
        if not path.exists() or not sessions.record_for(path, home, session_id):
            return
        found = reason_of(sessions.adapter, session_id)
        if found is not None:
            write(path, session_id, *found)
    except Exception:
        logger.debug("gots: couldn't keep what a turn failed of", exc_info=True)
