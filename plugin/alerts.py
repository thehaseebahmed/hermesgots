"""News worth a push while the app is closed, beyond a session that waits on the user (``push.py``).

A run that finished or failed, a pull request whose checks fail, and a routine that failed come from
here (a merged pull request is told by ``merges.py``, a project that couldn't be set up by
``clones.py`` and ``repos.py``). Each is its own kind of push, so a device picks which it wants. Most
come from hooks; the pull requests and routines are looked up every few minutes, because nothing in
Hermes tells the plugin when GitHub or the scheduler moves.
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Optional

from . import github, merges, push, sessions
from .store import db_path

logger = logging.getLogger(__name__)

INTERVAL_S = 300
# A run shorter than this finished while the user was most likely still looking.
RUN_DONE_MIN_S = 60
# A pull request's checks are watched while its session was touched this recently.
PR_WINDOW_MS = 7 * 24 * 3600 * 1000
# A routine run that failed longer ago than this is history, not news (the first pass after an
# update would otherwise push every old failure).
ROUTINE_FRESH_S = 30 * 60

_lock = threading.Lock()
_started: Dict[str, float] = {}


def _text(value: Any) -> Optional[str]:
    return value if isinstance(value, str) and value else None


def turn_started(**kwargs: Any) -> None:
    """``pre_llm_call``: when a session's turn began (the hook fires per model call, so the first)."""
    session_id = _text(kwargs.get("session_id"))
    if not session_id or kwargs.get("platform") != "api_server":
        return
    with _lock:
        if len(_started) > 512:
            _started.clear()
        _started.setdefault(session_id, time.monotonic())


def turn_finished(**kwargs: Any) -> None:
    """``on_session_end``: a turn of one of Gots's chats ended. Never raises."""
    try:
        session_id = _text(kwargs.get("session_id"))
        if not session_id or kwargs.get("platform") not in (None, "api_server"):
            return
        with _lock:
            started = _started.pop(session_id, None)
        interrupted = bool(kwargs.get("interrupted"))
        failed = bool(kwargs.get("failed")) and not interrupted
        done = bool(kwargs.get("completed")) and not failed and not interrupted
        if not (failed or done):
            return
        path, home = sessions._paths()
        record = sessions.record_for(path, home, session_id) if path.exists() else None
        # Delegated children and other surfaces' sessions end turns too.
        if not record and not session_id.startswith("memento-"):
            return
        if failed:
            push.notify("run_failed", session_id, path)
        elif (
            started is not None
            and time.monotonic() - started >= RUN_DONE_MIN_S
            # A plan waiting for review is told as such.
            and not (record and record["mode"] == "plan")
        ):
            push.notify("run_done", session_id, path)
    except Exception:
        logger.debug("memento: couldn't tell a turn's end", exc_info=True)


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


def check_pull_requests(path: Path, home: Path, now: int) -> int:
    """Pushes the open pull requests of the open project sessions whose checks have started failing.
    A pull request that stops failing (a rerun, a fix) can fail, and be told, again. Returns how many."""
    told = 0
    for _chat, _entry, _value, session_id, record in merges.open_sessions(
        path, home, now, window=PR_WINDOW_MS
    ):
        for repo in record["repos"]:
            if not repo.get("branch") or not repo.get("repo_root"):
                continue
            pr = github.pull_request(home, repo["repo_root"], repo["branch"])
            if not pr:
                continue
            key = f"pr_checks:{session_id}:{pr['repo']}#{pr['number']}"
            if pr["state"] in ("open", "draft") and pr["checks"] == "failure":
                if push.once(path, key):
                    push.notify("pr_checks", session_id, path)
                    told += 1
            else:
                push.clear(path, key)
    return told


def check(hermes_home: Path, now: Optional[int] = None) -> None:
    """One pass: routines, then pull requests. Nothing is looked up when no device could be told."""
    path = db_path(hermes_home)
    if not path.exists() or not push.reachable(path):
        return
    now = int(time.time() * 1000) if now is None else now
    for look in (lambda: check_routines(path, now / 1000), lambda: check_pull_requests(path, hermes_home, now)):
        try:
            look()
        except Exception:
            logger.warning("memento: looking for news to push failed", exc_info=True)


async def run(hermes_home: Path) -> None:
    """Every few minutes, for this profile's home."""
    while True:
        await asyncio.sleep(INTERVAL_S)
        await asyncio.to_thread(check, hermes_home)
