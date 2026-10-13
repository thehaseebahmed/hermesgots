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


def _utc(value: datetime) -> datetime:
    """A naive stamp is UTC; core's fetchers always pass a datetime or None."""
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def serialize(snapshot: Any, now: Optional[datetime] = None) -> Optional[Dict[str, Any]]:
    """Turn an ``AccountUsageSnapshot`` into a JSON-ready dict, or None.

    Windows without a ``used_percent`` or whose ``reset_at`` has already passed
    are dropped; the rest keep their label, used percent, reset time (ISO or
    null) and detail line. ``plan`` passes through when the fetcher reports one.
    """
    if snapshot is None:
        return None
    now = _utc(now) if now else datetime.now(timezone.utc)
    windows: List[Dict[str, Any]] = []
    for w in snapshot.windows or ():
        if w.used_percent is None:
            continue
        reset = w.reset_at
        if reset is not None and _utc(reset) <= now:
            continue
        windows.append(
            {
                "label": w.label,
                "used_percent": float(w.used_percent),
                "resets_at": _utc(reset).isoformat() if reset is not None else None,
                "detail": w.detail,
            }
        )
    return {
        "provider": snapshot.provider,
        "plan": snapshot.plan if isinstance(snapshot.plan, str) and snapshot.plan else None,
        "windows": windows,
    }


def fetch(provider: str) -> Optional[Dict[str, Any]]:
    """Call Hermes core's ``fetch_account_usage`` and serialize the result.

    ``read_only=True`` so a display read never refreshes or rotates a credential.
    Any exception — including a provider plugin that returns a shape core doesn't
    promise — is treated as no data, so the route answers an empty windows list
    rather than a 500.
    """
    try:
        from agent.account_usage import fetch_account_usage

        snapshot = fetch_account_usage(provider, read_only=True)
        return serialize(snapshot)
    except Exception:
        return None
