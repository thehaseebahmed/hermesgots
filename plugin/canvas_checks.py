"""The check runner's probe: whether this host can draw a canvas's page for a check.

A build is checked on the page it renders (ADR 0171): the harness page is opened in a browser on
the Hermes host, the plan's tests are run in it and the screenshots are taken, all through
Hermes's own browser layer rather than a browser the plugin installs. That a plugin can call into
that layer at all was unverified when the plan was written, so the runner starts with this probe:
it looks for the entry without starting a browser, and says why where there is none. ``info``
advertises ``canvas_checks`` only where the probe finds it, so an app knows a build on this host
would publish unchecked rather than fail to build.

The entry is ``tools.browser_use_cli.browser_exec`` — the tool Hermes's own ``browser_exec`` is
dispatched through, imported the way the plugin reaches every other Hermes module, lazily and
inside the function. It runs Python with the harness's helpers pre-imported, which is where the
four things a check needs come from: ``new_tab`` opens a page (the harness's ``file://`` page among
them), ``cdp`` sets the width (``Emulation.setDeviceMetricsOverride``) and the colour scheme
(``Emulation.setEmulatedMedia``'s ``prefers-color-scheme``), ``js`` evaluates a script and
``capture_screenshot`` takes the picture. ``browser_exec_available`` answers whether the engine
behind it is installed, and answers it without launching or opening a socket — which is what makes
this a probe rather than a check.
"""

from __future__ import annotations

import logging
from typing import Optional

logger = logging.getLogger(__name__)

# Why this host can't run a canvas's checks, in the words a reader is given. The missing engine's
# is Hermes's own sentence for it, since the fix is Hermes's own update.
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
    except Exception:  # the probe must never be what fails a build's start
        logger.debug("gots: couldn't read Hermes's browser layer", exc_info=True)
        return UNREADABLE
    return None if ready else NO_ENGINE
