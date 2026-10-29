"""A check-in for a long tool loop: after many tool calls with nothing said, the agent is told to
update the user before it goes on.

A run that reads, greps, patches and tests for minutes shows the user tool cards and no words, and
the prompt's own "post a short update between checkpoints" is the only thing asking for them — a
model deep in a loop skips it. Hermes hands the plugin two hooks that make the count honest:
``pre_tool_call`` before every tool call, and ``post_api_request`` after every model call, carrying
``assistant_content_chars``. So the count of *continuous* calls is the number since the model last
said something: a model call that produced text resets it, one that produced only tool calls does
not. The turn's own start resets it too, so a new turn never inherits yesterday's count.

When the count passes :data:`CHECK_IN_AFTER`, the next call is blocked with a message telling the
agent to post a short update and then make the call again — the same directive plan mode uses, so
the tool result carries the ask and the loop goes on. The count resets on the block itself: a model
that ignores the ask gets its tool back and is asked again after another :data:`CHECK_IN_AFTER`
calls, never stuck at a wall.
"""

from __future__ import annotations

import logging
import threading
from typing import Any, Dict, Optional, Tuple

from . import sessions

logger = logging.getLogger(__name__)

# Calls between check-ins, counted since the agent last wrote something the user sees.
CHECK_IN_AFTER = 20
# Counts kept at once: the sessions at work in one process. A stale one is only a number, so the
# oldest is dropped rather than the table growing for as long as the gateway runs.
KEEP_SESSIONS = 512

CHECK_IN = (
    "Progress check-in: {count} tool calls in this turn with nothing said to the user. Reply with a"
    " short update now — what has landed and what is next, a sentence or two, not a replay of the"
    " calls — then make this tool call again."
)

_lock = threading.Lock()
_calls: Dict[Tuple[str, str], int] = {}


def _session(kwargs: Dict[str, Any]) -> Optional[str]:
    """The session this hook call belongs to, or None for one that isn't Gots's.

    Gots mints its chats' ids (``createConversation`` in the app), and a delegated child is a fresh
    session of its own — its reply reaches its parent, not the user — so the prefix gates both.
    """
    session_id = kwargs.get("session_id") or ""
    if isinstance(session_id, str) and session_id.startswith(sessions.MEMENTO_ID_PREFIX):
        return session_id
    return None


def _key(kwargs: Dict[str, Any]) -> Optional[Tuple[str, str]]:
    """What one continuous stretch of tool calls is counted under: a turn of a Gots session."""
    session_id = _session(kwargs)
    if session_id is None:
        return None
    return session_id, str(kwargs.get("turn_id") or "")


def _forget(session_id: str) -> None:
    """Drops every turn of one session: its turn is over, or its agent has just spoken."""
    with _lock:
        for key in list(_calls):
            if key[0] == session_id:
                del _calls[key]


def _room() -> None:
    """Drops the oldest count, so the table stays as small as the sessions at work. Called with the
    lock held."""
    if len(_calls) > KEEP_SESSIONS:
        del _calls[next(iter(_calls))]


def before_tool(**kwargs: Any) -> Optional[Dict[str, str]]:
    """The ``pre_tool_call`` hook: counts the call, and after :data:`CHECK_IN_AFTER` of them with no
    update in between, blocks it with the ask.

    Never raises: it runs inside Hermes's tool loop, and a policy hook that raises blocks the call.
    """
    try:
        return _before_tool(kwargs)
    except Exception:
        logger.debug("memento: progress check-in failed", exc_info=True)
        return None


def _before_tool(kwargs: Dict[str, Any]) -> Optional[Dict[str, str]]:
    key = _key(kwargs)
    if key is None:
        return None
    with _lock:
        count = _calls.get(key, 0) + 1
        if count <= CHECK_IN_AFTER:
            _calls[key] = count
            _room()
            return None
        # The ask is what starts a new stretch: the model that ignores it still gets its tool back.
        del _calls[key]
    return {"action": "block", "message": CHECK_IN.format(count=CHECK_IN_AFTER)}


def after_model_call(**kwargs: Any) -> None:
    """The ``post_api_request`` hook: a model call that produced text has spoken to the user, so the
    stretch of silent calls starts again.

    Never raises: it runs on every model call.
    """
    try:
        key = _key(kwargs)
        if key is not None and _spoke(kwargs):
            with _lock:
                _calls.pop(key, None)
    except Exception:
        logger.debug("memento: progress check-in reset failed", exc_info=True)


def _spoke(kwargs: Dict[str, Any]) -> bool:
    """Whether the model's reply carried text the app draws. Reasoning is not text the user reads,
    and a host that doesn't count the characters is read from the message it sent instead."""
    chars = kwargs.get("assistant_content_chars")
    if isinstance(chars, (int, float)):
        return chars > 0
    message = kwargs.get("assistant_message")
    content = message.get("content") if isinstance(message, dict) else None
    return isinstance(content, str) and bool(content.strip())


def turn_started(**kwargs: Any) -> None:
    """The ``pre_llm_call`` hook: a new turn starts its stretch of calls at zero, whatever the turn
    before it ended on."""
    try:
        session_id = _session(kwargs)
        if session_id is not None:
            _forget(session_id)
    except Exception:
        logger.debug("memento: progress check-in turn reset failed", exc_info=True)
