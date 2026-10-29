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

logger = logging.getLogger(__name__)

# Calls between check-ins, counted since the agent last wrote something the user sees.
CHECK_IN_AFTER = 20
# Sessions at work at once in one process; a stale entry is only a count, so it is dropped, not kept.
KEEP_SESSIONS = 512

# Gots's own chats mint this prefix (``createConversation`` in the app); a delegated child is a
# fresh session of its own, whose "reply" no user is reading, so the count is Gots's alone.
SESSION_PREFIX = "memento-"

CHECK_IN = (
    "Progress check-in: {count} tool calls in this turn with nothing said to the user. Reply with a"
    " short update now — what has landed and what is next, a sentence or two, not a replay of the"
    " calls — then make this tool call again."
)

_lock = threading.Lock()
_calls: Dict[Tuple[str, str], int] = {}


def _key(kwargs: Dict[str, Any]) -> Optional[Tuple[str, str]]:
    """What one continuous stretch of tool calls is counted under, or None for a session that isn't
    Gots's."""
    session_id = kwargs.get("session_id") or ""
    if not isinstance(session_id, str) or not session_id.startswith(SESSION_PREFIX):
        return None
    turn_id = kwargs.get("turn_id") or ""
    return session_id, turn_id if isinstance(turn_id, str) else ""


def _forget(session_id: str) -> None:
    """Drops every turn of one session: its turn is over, or its agent has just spoken."""
    with _lock:
        for key in [key for key in _calls if key[0] == session_id]:
            del _calls[key]


def _room() -> None:
    """Keeps the table small: the oldest count is the one least likely to be needed. Called with the
    lock held."""
    while len(_calls) > KEEP_SESSIONS:
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
        _calls[key] = 0
    return {"action": "block", "message": CHECK_IN.format(count=CHECK_IN_AFTER)}


def after_model_call(**kwargs: Any) -> None:
    """The ``post_api_request`` hook: a model call that produced text has spoken to the user, so the
    stretch of silent calls starts again.

    Never raises: it runs on every model call.
    """
    try:
        key = _key(kwargs)
        if key is None or not _spoke(kwargs):
            return
        with _lock:
            _calls.pop(key, None)
    except Exception:
        logger.debug("memento: progress check-in reset failed", exc_info=True)


def _spoke(kwargs: Dict[str, Any]) -> bool:
    """Whether the model's reply carried text the app draws — reasoning and tool calls alone are not
    words the user reads."""
    chars = kwargs.get("assistant_content_chars")
    if isinstance(chars, bool) or not isinstance(chars, (int, float)):
        return False
    if chars > 0:
        return True
    message = kwargs.get("assistant_message")
    content = message.get("content") if isinstance(message, dict) else None
    return isinstance(content, str) and bool(content.strip())


def turn_started(**kwargs: Any) -> None:
    """The ``pre_llm_call`` hook: a new turn starts its stretch of calls at zero, whatever the turn
    before it ended on."""
    try:
        session_id = kwargs.get("session_id") or ""
        if isinstance(session_id, str) and session_id.startswith(SESSION_PREFIX):
            _forget(session_id)
    except Exception:
        logger.debug("memento: progress check-in turn reset failed", exc_info=True)
