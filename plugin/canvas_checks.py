from __future__ import annotations

import logging
from typing import Optional

logger = logging.getLogger(__name__)

NO_ENTRY = "This Hermes has no browser layer a plugin can call. Update Hermes."
NO_ENGINE = "Hermes's browser engine is missing from its Python environment. Run `hermes update`."
UNREADABLE = "This Hermes's browser layer couldn't be read. Update Hermes."


def available() -> Optional[str]:
    """Why this host can't run a canvas's checks, or None when it can.

    The import is inside the function, like every other Hermes module the plugin reaches: the
    module only exists on a Hermes host, and a test plants its own in ``sys.modules``.
    """
    try:
        from tools import browser_use_cli
    except ImportError:
        return NO_ENTRY
    except Exception:
        logger.debug("gots: couldn't import Hermes's browser layer", exc_info=True)
        return UNREADABLE
    if not callable(getattr(browser_use_cli, "browser_exec", None)):
        return NO_ENTRY
    check = getattr(browser_use_cli, "browser_exec_available", None)
    if not callable(check):
        return NO_ENTRY
    try:
        ready = check()
    except Exception:
        logger.debug("gots: couldn't read Hermes's browser layer", exc_info=True)
        return UNREADABLE
    return None if ready else NO_ENGINE
