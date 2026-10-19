"""The community leaderboard: this profile's token counts per day, model and mode.

``post_api_request`` sees every model call with its own usage, so the hook adds it to a counter
for the call's UTC day, model and the mode of the session it belongs to (a project session's Accept
edits, Auto or Plan, else ``chat``), and its tokens to a counter for the day, provider and
model. Only the numbers are kept: no prompt, text,
session id or path. They stay on the host until the account joins the leaderboard in the app,
which the registry answers on each check-in; then the last 35 days are sent to Gots, which adds
them to the account's GitHub username.
"""

from __future__ import annotations

import hashlib
import json
import logging
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Optional

from .store import connect, db_path

logger = logging.getLogger(__name__)

KEEP_DAYS = 35
KINDS = ("input", "output", "cache_write", "cache_read")
# What the site names them: camel case, as its JSON does elsewhere.
WIRE = {"input": "input", "output": "output", "cache_write": "cacheWrite", "cache_read": "cacheRead"}


def _provider(value: Any) -> str:
    """The provider as the board names it: Hermes's slug, without a custom endpoint's own name
    (``custom:acme`` is ``custom``), so nothing a person named reaches the board."""
    if not isinstance(value, str):
        return "unknown"
    name = value.strip().lower().split(":", 1)[0]
    return name[:48] or "unknown"


def _count(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0:
        return 0
    return int(value)


def _day(at: Optional[float] = None) -> str:
    return datetime.fromtimestamp(time.time() if at is None else at, timezone.utc).strftime("%Y-%m-%d")


def record(**kwargs: Any) -> None:
    """The ``post_api_request`` hook. Runs on every model call, so it never raises."""
    try:
        _record(kwargs)
    except Exception:
        logger.debug("memento: couldn't count community usage", exc_info=True)


def _record(kwargs: Dict[str, Any]) -> None:
    # Gots only talks to the API server; other surfaces' sessions are none of its business.
    if kwargs.get("platform") != "api_server":
        return
    model = kwargs.get("model")
    usage = kwargs.get("usage")
    session_id = kwargs.get("session_id")
    if not isinstance(model, str) or not model or not isinstance(usage, dict):
        return
    counts = (
        _count(usage.get("input_tokens")),
        _count(usage.get("output_tokens")),
        _count(usage.get("cache_write_tokens")),
        _count(usage.get("cache_read_tokens")),
    )
    if not any(counts):
        return
    from hermes_constants import get_hermes_home

    from . import sessions

    home = Path(get_hermes_home())
    path = db_path(home)
    mode = "chat"
    if isinstance(session_id, str) and session_id:
        found = sessions.record_for(path, home, session_id)
        if found and found.get("mode") in sessions.MODES:
            mode = found["mode"]
    conn = connect(path)
    try:
        conn.execute(
            """INSERT INTO community_usage
                   (day, model, mode, input, output, cache_write, cache_read, calls)
               VALUES (?, ?, ?, ?, ?, ?, ?, 1)
               ON CONFLICT(day, model, mode) DO UPDATE SET
                   input = input + excluded.input,
                   output = output + excluded.output,
                   cache_write = cache_write + excluded.cache_write,
                   cache_read = cache_read + excluded.cache_read,
                   calls = calls + 1""",
            (_day(), model.strip().lower()[:96], mode, *counts),
        )
        conn.execute(
            """INSERT INTO community_providers (day, provider, model, tokens) VALUES (?, ?, ?, ?)
               ON CONFLICT(day, provider, model) DO UPDATE SET tokens = tokens + excluded.tokens""",
            (_day(), _provider(kwargs.get("provider")), model.strip().lower()[:96], sum(counts)),
        )
        oldest = _day(time.time() - KEEP_DAYS * 86400)
        conn.execute("DELETE FROM community_usage WHERE day < ?", (oldest,))
        conn.execute("DELETE FROM community_providers WHERE day < ?", (oldest,))
    finally:
        conn.close()


def payload(home: Path) -> Dict[str, Any]:
    """``{ days: { "2026-10-15": { model: { mode: { input, output, cacheWrite, cacheRead, calls } } } },
    providers: { "2026-10-15": { provider: { model: tokens } } } }``"""
    path = db_path(home)
    if not path.exists():
        return {"days": {}, "providers": {}}
    oldest = _day(time.time() - (KEEP_DAYS - 1) * 86400)
    conn = connect(path)
    try:
        rows = conn.execute(
            """SELECT day, model, mode, input, output, cache_write, cache_read, calls
               FROM community_usage WHERE day >= ? ORDER BY day, model, mode""",
            (oldest,),
        ).fetchall()
        provider_rows = conn.execute(
            """SELECT day, provider, model, tokens FROM community_providers
               WHERE day >= ? AND tokens > 0 ORDER BY day, provider, model""",
            (oldest,),
        ).fetchall()
    finally:
        conn.close()
    days: Dict[str, Any] = {}
    for day, model, mode, *numbers in rows:
        entry = dict(zip((WIRE[k] for k in KINDS), numbers[:4]))
        entry["calls"] = numbers[4]
        days.setdefault(day, {}).setdefault(model, {})[mode] = entry
    providers: Dict[str, Any] = {}
    for day, provider, model, tokens in provider_rows:
        providers.setdefault(day, {}).setdefault(provider, {})[model] = tokens
    return {"days": days, "providers": providers}


def sync(home: Path, state: Dict[str, Any], call: Any) -> None:
    """Part of a check-in: if the account joined the leaderboard, send the counts when they changed.

    ``call`` is ``link.call``; a failure is only logged, the next check-in tries again."""
    try:
        token = state["token"]
        site = state["site"]
        answer = call(site, "GET", "community", token=token, function="community")
        if not (answer or {}).get("enabled"):
            return
        body = payload(home)
        digest = hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()
        if (state.get("community") or {}).get("hash") == digest:
            return
        call(site, "POST", "report", token=token, body=body, function="community")
        state["community"] = {"hash": digest, "at": int(time.time())}
    except Exception:
        logger.debug("memento: community report failed", exc_info=True)

