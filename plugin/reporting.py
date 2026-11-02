"""Error reporting to Sentry, off unless the host sets ``GOTS_SENTRY_DSN``.

The plugin runs beside someone else's agent on their own machine, so nothing is sent by default: the
DSN decides whose project the reports land in, and it is the host's to set. ``sentry-sdk`` is
imported only once there is somewhere to send, so a host that has not set a DSN needs nothing
installed, and one that has but cannot import the SDK is told so once and carries on.
"""

from __future__ import annotations

import logging
import os
from typing import Any

DSN_ENV = "GOTS_SENTRY_DSN"
ENVIRONMENT_ENV = "GOTS_SENTRY_ENV"

_started = False


def scrub(event: dict[str, Any], _hint: dict[str, Any]) -> dict[str, Any]:
    """A report keeps where a failure happened and drops what was being carried through it."""
    request = event.get("request")
    if isinstance(request, dict):
        request.pop("headers", None)
        request.pop("cookies", None)
        request.pop("data", None)
    event.pop("user", None)
    return event


def start(version: str) -> bool:
    """Starts reporting where the host set a DSN and the SDK is installed. Safe to call twice."""
    global _started
    if _started:
        return False
    dsn = os.environ.get(DSN_ENV, "").strip()
    if not dsn:
        return False
    try:
        import sentry_sdk
        from sentry_sdk.integrations.logging import LoggingIntegration
    except ImportError:
        logging.getLogger(__name__).info("%s is set but sentry-sdk is not installed", DSN_ENV)
        return False
    sentry_sdk.init(
        dsn=dsn,
        release=f"gots-plugin@{version}",
        environment=os.environ.get(ENVIRONMENT_ENV, "production").strip() or "production",
        # Crashes are the ask; traces would spend the plan's events on a request nobody asked about.
        traces_sample_rate=0.0,
        send_default_pii=False,
        # A chat's words and a bot's key travel through this process, and neither is a bug report.
        max_request_body_size="never",
        attach_stacktrace=False,
        include_local_variables=False,
        before_send=scrub,
        # A logged exception is how a hook's failure reaches anyone: Hermes catches it and logs it.
        integrations=[LoggingIntegration(level=None, event_level=logging.ERROR)],
    )
    _started = True
    return True
