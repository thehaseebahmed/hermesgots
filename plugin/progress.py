"""Progress reminders: a bot that works for a long time without saying anything is asked to post a
short update, at the rate its own level sets.

A run that reads, greps, patches and tests for minutes shows the user tool cards and no words, and
nothing in its prompt asks it to narrate — telling it so on every turn would cost every bot tokens
and could not change mid-run. So the ask comes from the hooks instead. ``post_tool_call`` counts
each tool call that ran (a call a policy blocked never became work the user waited on),
``post_api_request`` restarts the count on any reply that carried text, and a turn's own start
restarts it too.

How often that count earns a reminder is the bot's own setting — Off, Normal or Frequent, read on
every tool call so a change lands on the next one. At that count the next call is blocked with a
message asking for a short update, the same directive plan mode uses, and the call is then made
again: a model that ignores the reminder is asked again after another stretch, never wedged.
"""

from __future__ import annotations

import logging
import threading
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from . import sessions

logger = logging.getLogger(__name__)

# The bot's reminders, kept per bot in its profile's own settings store: Off asks never, Normal is
# what every bot did before the level existed, and Frequent asks twice as often.
LEVEL_KEY = "progress_reminders"
AFTER: Dict[str, Optional[int]] = {"off": None, "normal": 20, "frequent": 10}
DEFAULT_LEVEL = "normal"
OBJECT = "memento.progress_reminders"

# Counts kept at once: the sessions at work in one process. A stale one is only a number, so the
# oldest is dropped rather than the table growing for as long as the gateway runs.
KEEP_SESSIONS = 512

REMINDER = (
    "Progress reminder: {count} tool calls in this turn with nothing said to the user. Reply with a"
    " short update now — what has landed and what is next, a sentence or two, not a replay of the"
    " calls — then make this tool call again."
)

_lock = threading.Lock()
_calls: Dict[Tuple[str, str], int] = {}


def _session(kwargs: Dict[str, Any]) -> Optional[str]:
    """The session this hook call belongs to, or None for one with no user to update.

    Gots mints its chats' ids (``createConversation`` in the app), and a delegated child is a fresh
    session of its own whose reply reaches its parent rather than the user — so the prefix separates
    the chats a reader waits on from everything else.
    """
    session_id = kwargs.get("session_id") or ""
    if not isinstance(session_id, str) or not session_id.startswith(sessions.MEMENTO_ID_PREFIX):
        return None
    return session_id


def level(path: Optional[Path]) -> str:
    """The bot's reminder level as its host holds it: Normal unless a stored value says otherwise.

    A store that can't be read answers Normal, the way a failed read fails open everywhere else
    here: a host that can't answer must not take the reminders away from every bot.
    """
    if path is None:
        return DEFAULT_LEVEL
    try:
        from .store import get_setting

        value = get_setting(path, LEVEL_KEY)
    except Exception:
        logger.debug("memento: couldn't read the reminders level", exc_info=True)
        return DEFAULT_LEVEL
    return value if isinstance(value, str) and value in AFTER else DEFAULT_LEVEL


def set_level(path: Path, value: Any) -> str:
    """Stores the bot's level and answers what the store now holds.

    A value the host doesn't know is refused rather than written: a row every read would then ignore
    reads back as Normal while claiming to hold something else.
    """
    if not isinstance(value, str) or value not in AFTER:
        raise ValueError(f"level must be one of {', '.join(AFTER)}")
    from .store import put_setting

    put_setting(path, LEVEL_KEY, value)
    return level(path)


def record(value: str) -> Dict[str, Any]:
    """The route pair's answer: the level, and the levels a client may send."""
    return {"object": OBJECT, "level": value, "levels": list(AFTER)}


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
    """The ``pre_tool_call`` hook: once the bot's level's worth of calls have run with no update in
    between, blocks this one with the reminder.

    The counting is ``after_tool``'s, so a call another hook blocked before it ran is never counted.
    Never raises: it runs inside Hermes's tool loop, and a policy hook that raises blocks the call.
    """
    try:
        return _before_tool(kwargs)
    except Exception:
        logger.debug("memento: progress reminder failed", exc_info=True)
        return None


def _before_tool(kwargs: Dict[str, Any]) -> Optional[Dict[str, str]]:
    key = _key(kwargs)
    if key is None:
        return None
    after = _threshold()
    if after is None:
        return None
    with _lock:
        count = _calls.get(key, 0)
        if count < after:
            return None
        # The reminder is what starts a new stretch: the model that ignores it still gets its tool
        # back.
        del _calls[key]
    return {"action": "block", "message": REMINDER.format(count=count)}


def _threshold() -> Optional[int]:
    """How many calls this bot allows before a reminder, or None when it asked for none.

    Read on every tool call, from the level its host holds: a bot switched to Off mid-run stops
    being asked on the next call, which is what the user meant by switching it.
    """
    path, _ = sessions._paths()
    return AFTER[level(path)]


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
        logger.debug("memento: progress reminder count failed", exc_info=True)


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
        logger.debug("memento: progress reminder reset failed", exc_info=True)


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
        logger.debug("memento: progress reminder turn reset failed", exc_info=True)
