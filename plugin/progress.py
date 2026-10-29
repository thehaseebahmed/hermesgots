"""A check-in for a long tool loop: after many tool calls with nothing said, the agent is told to
update the user before it goes on.

A run that reads, greps, patches and tests for minutes shows the user tool cards and no words, and
the prompt's own "post a short update between checkpoints" is the only thing asking for them — a
model deep in a loop skips it. Hermes hands the plugin the hooks that make the count honest:
``post_tool_call`` after every tool, carrying its status, and ``post_api_request`` after every model
call, carrying ``assistant_content_chars``. So the count is of calls that ran — a call plan mode or
a guardrail blocked never became work the user waited on and is not counted — and a model call that
produced text restarts it, since that text is words the user reads. A turn's own start restarts it
too, so a new turn never inherits yesterday's count.

When the count reaches :data:`CHECK_IN_AFTER`, the next call is blocked with a message telling the
agent to post a short update and then make the call again — the same directive plan mode uses, so
the tool result carries the ask and the loop goes on. The count restarts at the ask: a model that
ignores it gets its tool back and is asked again after another :data:`CHECK_IN_AFTER` calls, never
stuck at a wall.
"""

from __future__ import annotations

import logging
import threading
from typing import Any, Dict, Optional, Tuple

from . import sessions

logger = logging.getLogger(__name__)

# Tool calls allowed between check-ins, counted from the agent's last update or the last ask.
CHECK_IN_AFTER = 20
# Counts kept at once: the sessions at work in one process. A stale one is only a number, so the
# oldest is dropped rather than the table growing for as long as the gateway runs.
KEEP_SESSIONS = 512
# An AFK run works a task with nobody watching: its own prompt already asks for a checkpoint update
# between stages, and a blocked call there buys the user nothing. See afk.new_session_id.
AFK_PREFIX = f"{sessions.MEMENTO_ID_PREFIX}afk-"

CHECK_IN_BLOCK = (
    "Progress check-in: {count} tool calls in this turn with nothing said to the user. Reply with a"
    " short update now — what has landed and what is next, a sentence or two, not a replay of the"
    " calls — then make this tool call again."
)

_lock = threading.Lock()
_calls: Dict[Tuple[str, str], int] = {}


def _session(kwargs: Dict[str, Any]) -> Optional[str]:
    """The session this hook call belongs to, or None for one with no user to update.

    Gots mints its chats' ids (``createConversation`` in the app). A delegated child is a fresh
    session of its own, whose reply reaches its parent rather than the user, and an AFK run works
    unattended — neither has a reader waiting on this turn.
    """
    session_id = kwargs.get("session_id") or ""
    if not isinstance(session_id, str) or not session_id.startswith(sessions.MEMENTO_ID_PREFIX):
        return None
    if session_id.startswith(AFK_PREFIX):
        return None
    return session_id


def _key(kwargs: Dict[str, Any]) -> Optional[Tuple[str, str]]:
    """What one continuous stretch of tool calls is counted under: a turn of a Gots session."""
    session_id = _session(kwargs)
    if session_id is None:
        return None
    return session_id, str(kwargs.get("turn_id") or "")


def _forget(session_id: str) -> None:
    """Drops a session's counts: a new turn starts its own stretch."""
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
    """The ``pre_tool_call`` hook: after :data:`CHECK_IN_AFTER` calls with no update in between,
    blocks this one with the ask.

    The counting is ``after_tool``'s, so a call another hook blocked before it ran is never counted.
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
        count = _calls.get(key, 0)
        if count < CHECK_IN_AFTER:
            return None
        # The ask is what starts a new stretch: the model that ignores it still gets its tool back.
        del _calls[key]
    return {"action": "block", "message": CHECK_IN_BLOCK.format(count=count)}


def after_tool(**kwargs: Any) -> None:
    """The ``post_tool_call`` hook: a tool call ran, so the silent stretch is one longer. A call that
    was blocked — by this hook or any other policy — never became work the user waited on, so it is
    not one of them.

    Never raises: it runs after every tool call.
    """
    try:
        if kwargs.get("status") == "blocked":
            return
        key = _key(kwargs)
        if key is None:
            return
        with _lock:
            _calls[key] = _calls.get(key, 0) + 1
            _room()
    except Exception:
        logger.debug("memento: progress check-in count failed", exc_info=True)


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
    """Whether the model's reply carried any text: a reply of tool calls alone did not, and any
    reasoning a provider leaves inline counts, the same way the host counts it. A host that sends no
    count is read from the message it sent instead."""
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
