"""Each Gots chat's context use: the prompt of its session's latest model call.

The API server reports a turn's usage summed over every model call in it, so a turn that ran tools
counts the prompt once per call, and it never reports the context window. ``post_api_request`` sees
each call's own usage and the window Hermes compresses against, so the plugin keeps the latest of
both per session, and every device reads the same figure.
"""

from __future__ import annotations

import logging
import time
from pathlib import Path
from typing import Any, Dict, Optional

from .store import connect, current_path

logger = logging.getLogger(__name__)

KEEP_MS = 90 * 24 * 60 * 60 * 1000
FIELDS = ("prompt_tokens", "output_tokens", "context_length", "model", "provider", "at")


def _count(value: Any) -> Optional[int]:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0:
        return None
    return int(value)


def _text(value: Any) -> Optional[str]:
    return value if isinstance(value, str) and value else None


def record(**kwargs: Any) -> None:
    """The ``post_api_request`` hook. Runs on every model call, so it never raises."""
    try:
        _record(kwargs)
    except Exception:
        logger.debug("memento: couldn't record context use", exc_info=True)


def _record(kwargs: Dict[str, Any]) -> None:
    # Gots only talks to the API server; other surfaces' sessions are none of its business.
    if kwargs.get("platform") != "api_server":
        return
    session_id = _text(kwargs.get("session_id"))
    usage = kwargs.get("usage")
    if not session_id or not isinstance(usage, dict):
        return
    prompt_tokens = _count(usage.get("prompt_tokens"))
    if not prompt_tokens:
        return
    # Hermes runs the hook inside the request's profile scope, so this is that profile's store.
    now = int(time.time() * 1000)
    conn = connect(current_path())
    try:
        conn.execute(
            """INSERT INTO context
                   (session_id, prompt_tokens, output_tokens, context_length, model, provider, at)
               VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(session_id) DO UPDATE SET
                   prompt_tokens = excluded.prompt_tokens,
                   output_tokens = excluded.output_tokens,
                   context_length = CASE
                       WHEN excluded.context_length IS NOT NULL THEN excluded.context_length
                       WHEN excluded.model IS context.model THEN context.context_length
                   END,
                   model = excluded.model,
                   provider = excluded.provider,
                   at = excluded.at""",
            (
                session_id,
                prompt_tokens,
                _count(usage.get("output_tokens")),
                _count(kwargs.get("context_length")) or None,
                _text(kwargs.get("model")),
                _text(kwargs.get("provider")),
                now,
            ),
        )
        conn.execute("DELETE FROM context WHERE at < ?", (now - KEEP_MS,))
    finally:
        conn.close()


def read(path: Path, session_id: str) -> Optional[Dict[str, Any]]:
    if not path.exists():
        return None
    conn = connect(path)
    try:
        row = conn.execute(
            f"SELECT {', '.join(FIELDS)} FROM context WHERE session_id = ?", (session_id,)
        ).fetchone()
    finally:
        conn.close()
    return dict(zip(FIELDS, row)) if row else None
