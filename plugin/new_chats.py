"""A chat made on the Hermes server rather than on a device.

A canvas's first run is such a chat: one of the bot's own, carrying ``canvasId`` and titled with the
canvas's own name. The record is the one a device would write — the app's own kind of id, and
``gots-<id>`` for its session — so every device and the dashboard label treat it as any chat, and
the turn that opens it waits in the plugin's queue, so it starts with the app closed. A chat whose
first message never got queued is taken back rather than left as one nothing posts in.
"""

from __future__ import annotations

import logging
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from . import chats, outbox
from .sessions import GOTS_ID_PREFIX

logger = logging.getLogger(__name__)

MAX_TEXT = 2000


def one_line(text: Any, limit: int) -> str:
    """``text`` on one line and at most ``limit`` characters, which is how a title, a last line and a
    message are put to a model. Public because a canvas's title is read by the same rule."""
    if not isinstance(text, str):
        return ""
    flat = " ".join(text.split())
    return flat if len(flat) <= limit else flat[: limit - 1] + "…"


def open_thread(
    path: Path,
    profile_id: Optional[str],
    model_choice: Optional[Dict[str, str]] = None,
    *,
    opener: Optional[str] = None,
    opener_at: Optional[int] = None,
    title: Optional[str] = None,
    canvas_id: Optional[str] = None,
    chat_id: Optional[str] = None,
) -> Tuple[str, str]:
    """Makes the chat record a new chat on the bot would have, and returns its id and session id.

    The id is the app's own kind (a UUID) and the session is ``gots-<id>``, so every device and
    the dashboard label treat it as any chat. A caller that made the chat itself names it with
    ``chat_id`` — a canvas is started with files saved under the session that chat names, so only
    the caller could have saved them — and the session is derived from it the same way. The title
    is Hermes's to give once the first turn runs,
    unless one is given: a canvas's chat is named after the canvas and marked ``titleEdited``, so
    Hermes's auto-title never replaces it, and carries ``canvasId``, which is what keeps it out of
    every list. ``opener`` is the message that began the chat and ``opener_at`` when the reader sent
    it, so a device that never opens it still has the chat's own first line.
    """
    chat_id = chat_id or str(uuid.uuid4())
    session_id = f"{GOTS_ID_PREFIX}{chat_id}"
    now = int(time.time() * 1000)
    value = {
        "id": chat_id,
        "profileId": profile_id,
        "title": title or "New chat",
        "hermesSessionId": session_id,
        "createdAt": now,
        # Past createdAt, so the daily cleanup doesn't read a chat whose first message is still
        # waiting in the queue as one nothing happened in.
        "updatedAt": now + 1,
        "changedAt": now,
        **({"titleEdited": True} if title else {}),
        **({"canvasId": canvas_id} if canvas_id else {}),
        **(
            {"opener": one_line(opener, MAX_TEXT), **({"openerAt": opener_at} if opener_at else {})}
            if opener
            else {}
        ),
        **({"modelChoice": model_choice} if model_choice else {}),
    }
    chats.merge(path, {chat_id: {"at": now, "value": value}})
    return chat_id, session_id


def queue_first_turn(
    path: Path,
    profile: Optional[str],
    chat_id: str,
    session_id: str,
    text: str,
    files: List[Dict[str, Any]],
    body: Any,
) -> Dict[str, Any]:
    """Queues a new chat's first turn, and takes the chat back when the queue refuses the run.

    The run body is the app's own request, rebound to the chat's session, which is what lets the
    dispatcher start it with the app closed.
    """
    try:
        return outbox.add(path, session_id, profile, text, files, outbox.clean_body(session_id, body))
    except Exception:
        # Nothing was posted in it, so it goes rather than standing as an empty chat on every device.
        chats.tombstone(path, chat_id)
        raise


