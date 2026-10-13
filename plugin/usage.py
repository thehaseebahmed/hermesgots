"""Per-provider account usage windows, served to the app.

Hermes core's ``agent.account_usage.fetch_account_usage`` knows how to query
anthropic, openai-codex, openrouter and the opencode-go plugin hook. This
module wraps it so the plugin route stays thin: it calls the fetcher under the
request's profile scope (credentials stay server-side), drops windows without a
``used_percent`` or whose ``reset_at`` has already passed, and serializes the
rest for the app.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional


def _parse_dt(value: Any) -> Optional[datetime]:
    if value in {None, ""}:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(float(value), tz=timezone.utc)
    if not isinstance(value, str) or not (text := value.strip()):
        return None
    text = text[:-1] + "+00:00" if text.endswith("Z") else text
    try:
        dt = datetime.fromisoformat(text)
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def serialize(snapshot: Any, now: Optional[datetime] = None) -> Optional[Dict[str, Any]]:
    """Turn an ``AccountUsageSnapshot`` into a JSON-ready dict, or None.

    Windows without a ``used_percent`` or whose ``reset_at`` has already passed
    are dropped; the rest keep their label, used percent, reset time (ISO or
    null) and detail line. ``plan`` passes through when the fetcher reports one.
    """
    if snapshot is None:
        return None
    now = now or datetime.now(timezone.utc)
    windows: List[Dict[str, Any]] = []
    for w in getattr(snapshot, "windows", ()) or ():
        pct = getattr(w, "used_percent", None)
        if pct is None or not isinstance(pct, (int, float)):
            continue
        reset_dt = _parse_dt(getattr(w, "reset_at", None))
        if reset_dt is not None and reset_dt <= now:
            continue
        windows.append(
            {
                "label": getattr(w, "label", ""),
                "used_percent": float(pct),
                "resets_at": reset_dt.isoformat() if reset_dt else None,
                "detail": getattr(w, "detail", None),
            }
        )
    plan = getattr(snapshot, "plan", None)
    return {
        "provider": getattr(snapshot, "provider", ""),
        "plan": plan if isinstance(plan, str) and plan else None,
        "windows": windows,
    }


def fetch(provider: str) -> Optional[Dict[str, Any]]:
    """Call Hermes core's ``fetch_account_usage`` and serialize the result.

    ``read_only=True`` so a display read never refreshes or rotates a credential.
    Any exception is treated as no data (the route answers an empty windows list).
    """
    try:
        from agent.account_usage import fetch_account_usage

        snapshot = fetch_account_usage(provider, read_only=True)
    except Exception:
        return None
    return serialize(snapshot)