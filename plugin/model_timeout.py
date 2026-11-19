"""How long a Research or Meetings model call may take, held per bot on its host.

Hermes bounds a plugin's model call at its own 30 s side-call default unless the call names a
timeout, and a judge reading a long ledger, or notes for a long meeting, can take longer. The
plugin names one: this setting, 120 s until a bot's owner changes it from the app's Developer
section. It lives in the profile's ``host_settings`` so it holds with the app closed, and it is read
on every call, so a change lands on the next one.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

FEATURE = "model_timeout"
SETTING = "model_timeout_s"
OBJECT = "gots.model_timeout"

DEFAULT_S = 120
# Under the floor a call is back at Hermes's own default; over the ceiling a hung provider holds a
# mission for hours (Hermes tries a timed-out request three times).
MIN_S = 30
MAX_S = 1800


def _valid(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and MIN_S <= value <= MAX_S


def seconds(path: Optional[Path] = None) -> int:
    """The timeout this bot's store holds, ``DEFAULT_S`` where it holds none or can't be read.

    With no ``path`` it is the profile in scope, which is where a mission's or a meeting's thread
    runs. A model call must never fail over its own setting, so every failure reads as the default.
    """
    try:
        from .store import current_path, get_setting

        held = get_setting(path if path is not None else current_path(), SETTING)
    except Exception:
        logger.debug("gots: couldn't read the model timeout", exc_info=True)
        return DEFAULT_S
    return held if _valid(held) else DEFAULT_S


def set_seconds(path: Path, value: Any) -> int:
    """Stores the bot's timeout and answers what the store now holds.

    A value outside the range, or one that isn't a whole number of seconds, is refused rather than
    written, so no row reads back as the default while claiming to hold something else.
    """
    if not _valid(value):
        raise ValueError(f"seconds must be a whole number from {MIN_S} to {MAX_S}")
    from .store import put_setting

    put_setting(path, SETTING, value)
    return seconds(path)


def record(value: int) -> Dict[str, Any]:
    """The route pair's answer."""
    return {"object": OBJECT, "seconds": value, "default": DEFAULT_S, "min": MIN_S, "max": MAX_S}
