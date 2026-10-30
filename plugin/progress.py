"""Progress reminders: a bot that works for a long time without saying anything is asked to post a
short update, at the rate its own level sets.

A run that reads, greps, patches and tests for minutes shows the user tool cards and no words, and
nothing in its prompt asks it to narrate — telling it so every turn would cost every bot tokens and
could not change mid-run. So the ask comes from the hooks instead (ADR 0068). ``post_tool_call``
counts each tool call that ran, ``post_api_request`` restarts the count on any reply that carried
text, and a turn's own start restarts it too.

How often that count earns a reminder is the bot's own setting — Off, Quiet, Normal or Chatty, read
on every tool call so a change lands on the next one. At that count the next call is blocked with a
message asking for a short update and, where the plan has moved, for the bot's todo list to be
brought up to date, and the count starts again: a model that ignores the reminder is asked again
after another stretch, never wedged.
"""

from __future__ import annotations

import logging
import threading
from pathlib import Path
from typing import Any, Dict, Optional

from . import sessions
from .todos import TOOL as TODO_TOOL

logger = logging.getLogger(__name__)

# The tool calls each level allows between reminders: Off asks never, and the name says how much the
# bot is asked to say — Quiet least often, Chatty most.
CALLS_BETWEEN: Dict[str, Optional[int]] = {"off": None, "quiet": 50, "normal": 25, "chatty": 10}
LEVELS = tuple(CALLS_BETWEEN)
DEFAULT_LEVEL = "normal"
LEVEL_KEY = "progress_reminders"
OBJECT = "memento.progress_reminders"

# Levels a store written before the four names holds, read as the level this one would have written.
# `frequent` is the same ten calls as `chatty`, so that bot goes on behaving exactly as it did.
LEGACY: Dict[str, str] = {"frequent": "chatty"}

# Sessions counted at once: those at work in one process. A stale one is only a number, so the
# oldest is dropped rather than the table growing for as long as the gateway runs.
KEEP_SESSIONS = 512

# The note's opening is pinned: the app draws nothing for the call it lands on, and this is the shape
# it matches (``progress-reminder.ts``). Kept free of the count for the same reason it is kept free of
# everything else — a number here is one the model may hand the user, and the counts are the loop's
# business, never theirs (ADR 0068).
REMINDER_HEADER = "Progress reminder"
REMINDER = (
    f"{REMINDER_HEADER}: a long run of tool calls with nothing said to the user. Reply with a short"
    " update now — what has landed and what is next, a sentence or two, not a replay of the calls —"
    f" and, where the plan has moved, bring your todo list up to date with {TODO_TOOL}. Then make"
    " this tool call again. This note is internal: don't mention it, or that you were reminded, in"
    " what you say to the user."
)

_lock = threading.Lock()
# session -> turn -> tool calls that ran since the agent last said anything.
_calls: Dict[str, Dict[str, int]] = {}


def _session(kwargs: Dict[str, Any]) -> Optional[str]:
    """The session this hook call belongs to, or None for one with no user to update.

    Gots mints its chats' ids (``createConversation`` in the app), and a delegated child is a fresh
    session of its own whose reply reaches its parent rather than the user.
    """
    session_id = kwargs.get("session_id") or ""
    if not isinstance(session_id, str) or not session_id.startswith(sessions.MEMENTO_ID_PREFIX):
        return None
    return session_id


def _turn(kwargs: Dict[str, Any]) -> str:
    return str(kwargs.get("turn_id") or "")


def level(path: Path) -> str:
    """The level this bot's store holds, Normal where it holds none.

    A name an older store wrote is read as the level this one would have written — `frequent` is
    `chatty`, the same ten calls — so a rename never quietens a bot that had already chosen. A store
    that can't be read raises, and its callers answer differently: the route says so, and the hook
    asks nothing — a failed read must not cost the user a tool call they turned the reminders off
    for.
    """
    from .store import get_setting

    value = get_setting(path, LEVEL_KEY)
    if not isinstance(value, str):
        return DEFAULT_LEVEL
    held = LEGACY.get(value, value)
    return held if held in CALLS_BETWEEN else DEFAULT_LEVEL


def set_level(path: Path, value: Any) -> str:
    """Stores the bot's level and answers what the store now holds.

    A value the host doesn't know is refused rather than written, so no row reads back as Normal
    while claiming to hold something else.
    """
    if not isinstance(value, str) or value not in CALLS_BETWEEN:
        raise ValueError(f"level must be one of {', '.join(LEVELS)}")
    from .store import put_setting

    put_setting(path, LEVEL_KEY, value)
    return level(path)


def record(value: str) -> Dict[str, Any]:
    """The route pair's answer."""
    return {"object": OBJECT, "level": value}


def _drop_oldest_session() -> None:
    """Drops the oldest session, so the table stays as small as the sessions at work. Called with the
    lock held."""
    if len(_calls) > KEEP_SESSIONS:
        del _calls[next(iter(_calls))]


def before_tool(**kwargs: Any) -> Optional[Dict[str, str]]:
    """The ``pre_tool_call`` hook: once the bot's level's worth of calls have run with no update in
    between, blocks this one with the reminder.

    Never raises: it runs inside Hermes's tool loop, and a policy hook that raises blocks the call.
    """
    try:
        return _before_tool(kwargs)
    except Exception:
        logger.debug("memento: progress reminder failed", exc_info=True)
        return None


def _before_tool(kwargs: Dict[str, Any]) -> Optional[Dict[str, str]]:
    session_id = _session(kwargs)
    if session_id is None:
        return None
    after = _threshold()
    if after is None:
        return None
    with _lock:
        count = _calls.get(session_id, {}).get(_turn(kwargs), 0)
        if count < after:
            return None
        # The reminder is what starts a new stretch: the model that ignores it still gets its tool
        # back.
        _calls.pop(session_id, None)
    return {"action": "block", "message": REMINDER}


def _threshold() -> Optional[int]:
    """How many calls this bot allows before a reminder, or None when it asked for none.

    Read on every tool call, so a bot switched to Off mid-run stops being asked on the next one.
    """
    path, _ = sessions._paths()
    try:
        return CALLS_BETWEEN[level(path)]
    except Exception:
        logger.debug("memento: couldn't read the reminders level; asking nothing", exc_info=True)
        return None


def after_tool(**kwargs: Any) -> None:
    """The ``post_tool_call`` hook: a tool call ran, so the silent stretch is one longer. A call a
    policy blocked never became work the user waited on, so it is not one of them.

    Never raises: it runs after every tool call.
    """
    try:
        if kwargs.get("status") == "blocked":
            return
        session_id = _session(kwargs)
        if session_id is None:
            return
        turn = _turn(kwargs)
        with _lock:
            turns = _calls.setdefault(session_id, {})
            turns[turn] = turns.get(turn, 0) + 1
            _drop_oldest_session()
    except Exception:
        logger.debug("memento: progress reminder count failed", exc_info=True)


def after_model_call(**kwargs: Any) -> None:
    """The ``post_api_request`` hook: a reply that carried text has spoken to the user, so the silent
    stretch starts again.

    Never raises: it runs on every model call.
    """
    try:
        session_id = _session(kwargs)
        if session_id is None or not _spoke(kwargs):
            return
        turn = _turn(kwargs)
        with _lock:
            turns = _calls.get(session_id)
            if turns is not None:
                turns.pop(turn, None)
    except Exception:
        logger.debug("memento: progress reminder reset failed", exc_info=True)


def _spoke(kwargs: Dict[str, Any]) -> bool:
    """Whether the model's reply carried any text: Hermes counts the characters on every model call,
    and a reply of tool calls alone counts zero."""
    chars = kwargs.get("assistant_content_chars")
    return isinstance(chars, (int, float)) and chars > 0


def turn_started(**kwargs: Any) -> None:
    """The ``pre_llm_call`` hook: a new turn starts its stretch of calls at zero.

    A repeat call for a turn already counted is left alone, so the reset does not depend on this
    hook firing exactly once per turn.
    """
    try:
        session_id = _session(kwargs)
        if session_id is None:
            return
        turn = _turn(kwargs)
        with _lock:
            if turn and turn in _calls.get(session_id, {}):
                return
            _calls.pop(session_id, None)
    except Exception:
        logger.debug("memento: progress reminder turn reset failed", exc_info=True)
