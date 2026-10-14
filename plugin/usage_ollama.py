"""Ollama Cloud's account limits, for the app's Usage sheet.

Hermes core's ``agent.account_usage`` knows anthropic, openai-codex and openrouter;
Ollama Cloud publishes its limits on ``GET https://ollama.com/api/balance``, with the
profile's ``OLLAMA_API_KEY``. This reads that endpoint and maps both payload shapes the
account answers with — the legacy session/weekly remaining percentages and the current
monthly allowance — onto the window records ``usage.serialize`` already reads, so the
app renders them like any other provider's limits.

The plugin owns this because the key is server-side and no Hermes surface asks Ollama
for its balance; nothing here imports Hermes core.
"""

from __future__ import annotations

import json
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

BALANCE_URL = "https://ollama.com/api/balance"
TIMEOUT_S = 10.0


@dataclass(frozen=True)
class Window:
    """One usage window, in the shape ``usage.serialize`` reads."""

    label: str
    used_percent: Optional[float] = None
    reset_at: Optional[datetime] = None
    detail: Optional[str] = None


@dataclass(frozen=True)
class Snapshot:
    """The account's answer: ``serialize`` reads ``provider``, ``plan`` and ``windows``."""

    provider: str
    windows: Tuple[Window, ...] = ()
    plan: Optional[str] = None


def api_key() -> str:
    """The profile's Ollama key, or "".

    Never ``os.environ``: the plugin runs in a process that may serve several profiles,
    so a bare read would resolve the launch profile's key.
    """
    from agent.credential_pool import get_env_prefer_dotenv

    return str(get_env_prefer_dotenv("OLLAMA_API_KEY") or "").strip()


def _utc(raw: Any) -> Optional[datetime]:
    """An ISO stamp from the API; anything unreadable reads as no reset time."""
    if not isinstance(raw, str) or not raw.strip():
        return None
    try:
        parsed = datetime.fromisoformat(raw.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _num(value: Any) -> Optional[float]:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def _remaining_window(label: str, block: Any) -> Optional[Window]:
    """A legacy window: the API reports what is left, the sheet shows what is used."""
    if not isinstance(block, dict):
        return None
    remaining = _num(block.get("remaining_percent"))
    if remaining is None:
        return None
    return Window(
        label=label,
        used_percent=max(0.0, min(100.0, 100.0 - remaining)),
        reset_at=_utc(block.get("resets_at")),
    )


def _allowance_window(included: Dict[str, Any], purchased: Any) -> Optional[Window]:
    """The current plan's included credits, with any purchased ones as its detail."""
    allowance = _num(included.get("allowance_usd"))
    balance = _num(included.get("balance_usd"))
    if allowance is None or balance is None or allowance <= 0:
        return None
    period = included.get("period")
    bought = _num(purchased.get("balance_usd")) if isinstance(purchased, dict) else None
    return Window(
        label="Included credits",
        used_percent=max(0.0, min(100.0, (allowance - balance) / allowance * 100.0)),
        reset_at=_utc(period.get("until")) if isinstance(period, dict) else None,
        detail=f"Purchased credits: ${bought:.2f}" if bought else None,
    )


def windows_from_payload(payload: Any) -> Tuple[Window, ...]:
    """Both shapes the account answers with: a monthly allowance, or session/weekly."""
    if not isinstance(payload, dict):
        return ()
    included = payload.get("included")
    if not isinstance(included, dict):
        return ()
    current = _allowance_window(included, payload.get("purchased"))
    if current is not None:
        return (current,)
    found: List[Optional[Window]] = [
        _remaining_window("Session", included.get("session")),
        _remaining_window("Weekly", included.get("weekly")),
    ]
    return tuple(w for w in found if w is not None)


def fetch_windows() -> Optional[Snapshot]:
    """The account's windows, or None.

    None means the sheet shows nothing for this provider: no key, a refusal, a timeout,
    an unreadable body or a shape neither mapping knows. A 429 is expected — the endpoint
    allows roughly ten reads a minute — and reading again later is the whole recovery.
    """
    key = api_key()
    if not key:
        return None
    request = urllib.request.Request(BALANCE_URL, headers={"Authorization": f"Bearer {key}"})
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_S) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except Exception:
        return None
    windows = windows_from_payload(payload)
    if not windows:
        return None
    plan = payload.get("plan") if isinstance(payload, dict) else None
    return Snapshot(
        provider="ollama-cloud",
        windows=windows,
        plan=plan if isinstance(plan, str) and plan else None,
    )
