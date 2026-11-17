"""News worth a push while the app is closed, beyond a session that waits on the user (``push.py``).

A run that finished or failed, and a routine that failed come from here (a merged pull request is
resolved by ``merges.py``, a project that couldn't be set up by ``clones.py`` and ``repos.py``). Each
is its own kind of push, so a device picks which it wants. Most come from hooks; the routines are
looked up every few minutes, because nothing in Hermes tells the plugin when the scheduler moves.
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Optional

from . import failures, notice, push, sessions
from .store import db_path

logger = logging.getLogger(__name__)

INTERVAL_S = 300
# A run shorter than this finished while the user was most likely still looking.
RUN_DONE_MIN_S = 60
# A routine run that failed longer ago than this is history, not news (the first pass after an
# update would otherwise push every old failure).
ROUTINE_FRESH_S = 30 * 60

_lock = threading.Lock()
_started: Dict[str, float] = {}
# The reply each session's run last gave, kept from `post_llm_call` until the run's news is told or
# held: the words a finished run's notification carries. Like `_started`, in memory and bounded.
_replies: Dict[str, str] = {}
# A finished run whose session still had subagents at work, kept until they are gone: session id ->
# the words its turn ended on, or None for a turn that ended without any. In memory, like
# `_started`: a restart loses this and the turn clock the same turn was judged against, so neither
# half outlives the process alone.
_held: Dict[str, Optional[str]] = {}


def _text(value: Any) -> Optional[str]:
    return value if isinstance(value, str) and value else None


def turn_started(**kwargs: Any) -> None:
    """``pre_llm_call``: when a session's turn began (the hook fires per model call, so the first).

    A turn that starts on a session whose news is still held is that run going on, not ending: a
    subagent's wake resumes the conversation, and a user who writes again is looking at the chat.
    The hold is dropped rather than told — the run that is now running will say what it did when it
    ends — so nothing announces a run that is working again.
    """
    session_id = _text(kwargs.get("session_id"))
    if not session_id or kwargs.get("platform") != "api_server":
        return
    with _lock:
        if len(_started) > 512:
            _started.clear()
        _started.setdefault(session_id, time.monotonic())
        dropped = _held.pop(session_id, None)
    if dropped is not None:
        logger.debug("gots: %s started again, so its held news is the turn before's", session_id)


def after_llm(**kwargs: Any) -> None:
    """``post_llm_call``: keeps the paragraph the run's notice will say, so its end has it.

    The words are the answer the user was shown, overwritten by each model call of the turn, so the
    run's own end reads the last one. They are kept as the notice carries them — the reply's last
    paragraph, on one line, cut at the body's bound — so a host that has run hundreds of turns holds
    a few kilobytes rather than every reply it ever gave. ``turn_finished`` takes them: a run told at
    once carries them into the notice, a run held over its subagents carries them with the hold.
    Nothing is read back from the transcript afterwards, which a compressed or restarted session
    would have moved on from.
    """
    try:
        session_id = _text(kwargs.get("session_id"))
        said = kwargs.get("assistant_response")
        if not session_id or not isinstance(said, str) or not said.strip():
            return
        words = notice.paragraph_of(said)
        if not words:
            return
        with _lock:
            if len(_replies) > 512:
                _replies.clear()
            _replies[session_id] = words
    except Exception:
        logger.debug("gots: couldn't keep a reply", exc_info=True)


def _busy(home: Path) -> Dict[str, int]:
    """Every session on this host that still has work, read once.

    ``delegation.live_sessions`` is what ``runs/live`` reports to the app, and
    ``delegation.waking_sessions`` is the map beside it: a finished subagent whose wake run is still
    owed. Between the one ending and its wake turn starting there is a moment with no live run and
    no running subagent, and that moment is not the conversation at rest — a notification then would
    say the run was over just as the bot resumes it. Both maps are keyed by the chat's root session
    and one read each answers every session the app draws, so a pass that asks about several holds
    reads them once. A read that fails says nothing, and holds nothing back.
    """
    from . import delegation

    busy: Dict[str, int] = {}
    try:
        busy.update(delegation.live_sessions(home))
    except Exception:
        logger.debug("gots: couldn't read the subagents still at work", exc_info=True)
    try:
        for root, count in delegation.waking_sessions(home).items():
            busy[root] = busy.get(root, 0) + count
    except Exception:
        logger.debug("gots: couldn't read the wake runs still owed", exc_info=True)
    return busy


def _working(home: Path, session_id: str, busy: Optional[Dict[str, int]] = None) -> bool:
    """Whether the session still has work of its own — the other half of a finished run."""
    try:
        root = sessions.chat_session(home, session_id)
    except Exception:
        logger.debug("gots: couldn't tell whether %s still works", session_id, exc_info=True)
        return False
    return (busy if busy is not None else _busy(home)).get(root, 0) > 0


def _hold(session_id: str, body: Optional[str]) -> None:
    """Keeps a finished run's news — and its words — until its subagents are gone, bounded."""
    with _lock:
        if len(_held) > 512:
            _held.clear()
        _held[session_id] = body


def tell_finished(path: Path, home: Path) -> int:
    """Tells the runs held at their turn's end that have really finished; how many went.

    A run finishes when it has ended and no work it left still runs — no subagent, and no wake run
    still owed — so a turn that ended over live subagents parked its ``run_done`` here rather than
    telling the user the run was over while it still worked. The words the turn ended on were
    parked with it, since the reply is not read back later. Asked where a turn ends — a wake, or the
    user's own next turn — and from the every-few-minutes pass, which is the answer when nothing
    else ends a turn of that session: the conversation can be left waiting on the user with the
    subagents long since gone.
    """
    with _lock:
        held = list(_held)
    busy = _busy(home)
    told = 0
    for session_id in held:
        if _working(home, session_id, busy):
            continue
        with _lock:
            if session_id not in _held:
                # Another look told it between the two reads; one notice is the point.
                continue
            words = _held.pop(session_id)
        push.notify("run_done", session_id, path, body=words)
        told += 1
    return told


def turn_finished(**kwargs: Any) -> None:
    """``on_session_end``: a turn of one of Gots's chats ended. Never raises."""
    try:
        session_id = _text(kwargs.get("session_id"))
        if not session_id or kwargs.get("platform") not in (None, "api_server"):
            return
        with _lock:
            started = _started.pop(session_id, None)
            # Released here whichever way the turn went: a reply is only ever news of the run it
            # was said in, and one kept past its own end would be the next turn's lie.
            words = _replies.pop(session_id, None)
        stopped = sessions.outcome(**kwargs)
        path, home = sessions._paths()
        record = sessions.record_for(path, home, session_id) if path.exists() else None
        # A compressed child's turn and a subagent's end here too, and both are the chat's own
        # work: this is the chat's news, told for them (``sessions.is_chat`` follows the ancestry).
        if not sessions.is_chat(home, session_id):
            return
        # A turn's end is where an earlier held run can have finished: its subagents may be gone.
        tell_finished(path, home)
        if stopped.failed:
            push.notify("run_failed", session_id, path, body=_failed_body(path, session_id))
        elif (
            stopped.finished
            and started is not None
            and time.monotonic() - started >= RUN_DONE_MIN_S
            # A plan waiting for review is told as such.
            and not (record and record["mode"] == "plan")
        ):
            # The turn ended, but the run may not have: subagents this turn left at work carry it
            # on, and the run finishes only when they are gone. Their absence is what the news
            # waits for, so it goes then rather than now — with the words this turn ended on, kept
            # beside it, since nothing reads a reply back once the turn is over.
            if _working(home, session_id):
                _hold(session_id, words)
            else:
                push.notify("run_done", session_id, path, body=words)
    except Exception:
        logger.debug("gots: couldn't tell a turn's end", exc_info=True)


def _failed_body(path: Path, session_id: str) -> Optional[str]:
    """What a failed run ended with, as a notice says it: the error ``failures.after_run`` kept.

    That hook is registered before this one, so the row it wrote is this turn's failure. A run that
    failed with nothing worth saying — Hermes's own wordless notice — says None, and keeps the
    kind's line.
    """
    try:
        found = failures.read(path, session_id)
    except Exception:
        logger.debug("gots: couldn't read what %s failed of", session_id, exc_info=True)
        return None
    said = _text((found or {}).get("text"))
    if not said:
        return None
    return notice.flatten(said) or None


def _finished_recently(row: Dict[str, Any], now: float) -> bool:
    text = _text(row.get("finished_at"))
    if not text:
        return False
    try:
        # The ledger writes Hermes's clock; a time without an offset is the host's own.
        at = datetime.fromisoformat(text).astimezone().timestamp()
    except ValueError:
        return False
    return 0 <= now - at <= ROUTINE_FRESH_S


def check_routines(path: Path, now: Optional[float] = None) -> int:
    """Pushes the routine runs that failed since the last pass. Returns how many."""
    now = time.time() if now is None else now
    try:
        from cron.executions import list_executions
        from cron.jobs import list_jobs
    except ImportError:
        return 0
    told = 0
    for job in list_jobs(include_disabled=True):
        job_id = _text(job.get("id"))
        if not job_id:
            continue
        for row in list_executions(job_id=job_id, limit=3):
            # Like the Routines screen: a delivery that failed after a good run is a failure too.
            failed = row.get("status") == "failed" or row.get("delivery_outcome") == "failed"
            if not failed or not _finished_recently(row, now):
                continue
            if push.once(path, f"routine_failed:{job_id}:{row.get('id')}"):
                push.notify("routine_failed", job_id, path, title=_text(job.get("name")))
                told += 1
    return told


def check(hermes_home: Path, now: Optional[int] = None) -> None:
    """One pass: the runs that have finished with their subagents, then routines. Nothing is looked
    up when no device could be told."""
    path = db_path(hermes_home)
    if not path.exists() or not push.reachable(path):
        return
    now = int(time.time() * 1000) if now is None else now
    for look in (
        lambda: tell_finished(path, hermes_home),
        lambda: check_routines(path, now / 1000),
    ):
        try:
            look()
        except Exception:
            logger.warning("gots: looking for news to push failed", exc_info=True)


async def run(hermes_home: Path) -> None:
    """Every few minutes, for this profile's home."""
    while True:
        await asyncio.sleep(INTERVAL_S)
        await asyncio.to_thread(check, hermes_home)
