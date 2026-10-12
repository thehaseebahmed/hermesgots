"""Resolves a project session once its pull request is merged on GitHub, with the app closed too.

Every few minutes the plugin looks up the pull requests of the open project sessions in its chat
list. When every repo's newest one is settled and at least one was merged, it sets the chat's
``resolvedAt`` with a newer change clock, so every device picks it up on its next sync. A merged
pull request resolves its session once: a session the user reopens stays open until another merges, and
says so with a push.
"""

from __future__ import annotations

import asyncio
import logging
import time
from pathlib import Path
from typing import Any, Dict, Iterable, Iterator, Optional, Set, Tuple

from . import chats, github, push, servers, sessions
from .store import connect, db_path

logger = logging.getLogger(__name__)

INTERVAL_S = 300
# Sessions untouched for longer aren't looked up anymore.
ACTIVE_MS = 30 * 24 * 3600 * 1000


def _seen(path: Path, session_id: str) -> Set[Tuple[str, int]]:
    conn = connect(path)
    try:
        rows = conn.execute(
            "SELECT repo, number FROM merged_prs WHERE session_id = ?", (session_id,)
        ).fetchall()
    finally:
        conn.close()
    return {(repo, number) for repo, number in rows}


def _mark(path: Path, session_id: str, merged: Iterable[Tuple[str, int]]) -> None:
    conn = connect(path)
    try:
        conn.executemany(
            "INSERT OR IGNORE INTO merged_prs (session_id, repo, number) VALUES (?, ?, ?)",
            [(session_id, repo, number) for repo, number in merged],
        )
    finally:
        conn.close()


def open_sessions(
    path: Path, hermes_home: Path, now: int, only: Optional[Set[str]] = None, window: int = ACTIVE_MS
) -> Iterator[Tuple[str, Dict[str, Any], Dict[str, Any], str, Dict[str, Any]]]:
    """The open project sessions in the chat list that have a workspace, as ``(chat id, entry, value,
    Hermes session id, workspace record)``. Sessions untouched for ``window`` are left out, unless
    ``only`` names the ones to look at."""
    for chat_id, entry in chats.read(path).items():
        value = entry.get("value")
        if entry.get("deleted") or not isinstance(value, dict) or not value.get("projectId"):
            continue
        if value.get("resolvedAt") or value.get("discardedAt"):
            continue
        session_id = value.get("hermesSessionId")
        if not isinstance(session_id, str) or (only is not None and session_id not in only):
            continue
        updated = value.get("updatedAt")
        if only is None and isinstance(updated, (int, float)) and now - updated > window:
            continue
        record = sessions.record_for(path, hermes_home, session_id)
        if record:
            yield chat_id, entry, value, session_id, record


def check(hermes_home: Path, only: Optional[Set[str]] = None, now: Optional[int] = None) -> int:
    """One pass over the open project sessions (or the Hermes session ids in ``only``). Returns how
    many it resolved."""
    now = int(time.time() * 1000) if now is None else now
    path = db_path(hermes_home)
    if not path.exists():
        return 0
    resolved: Dict[str, Dict[str, Any]] = {}
    for chat_id, entry, value, session_id, record in open_sessions(path, hermes_home, now, only):
        prs = [
            github.pull_request(hermes_home, repo["repo_root"], repo["branch"], checks=False)
            for repo in record["repos"]
            if repo.get("branch") and repo.get("repo_root")
        ]
        prs = [pr for pr in prs if pr]
        if not prs or any(pr["state"] in ("open", "draft") for pr in prs):
            continue
        merged = {(pr["repo"], pr["number"]) for pr in prs if pr["state"] == "merged"}
        new = merged - _seen(path, session_id)
        if not new:
            continue
        _mark(path, session_id, new)
        # A resolved session's dev servers are done with; the sweep would take them too, but
        # resolution is the moment the user sees.
        servers.stop_all(path, session_id)
        resolved[chat_id] = {"at": max(now, entry["at"] + 1), "value": {**value, "resolvedAt": now}}
        push.notify("pr_merged", session_id, path)
    if resolved:
        chats.merge(path, resolved)
    return len(resolved)


async def run(hermes_home: Path) -> None:
    """Every few minutes, for this profile's home."""
    while True:
        await asyncio.sleep(INTERVAL_S)
        try:
            done = await asyncio.to_thread(check, hermes_home)
            if done:
                logger.info("memento: resolved %d merged session(s)", done)
        except Exception:
            logger.warning("memento: checking merged pull requests failed", exc_info=True)
