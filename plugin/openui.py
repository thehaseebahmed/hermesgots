"""The interface library, told to the model as a system-prompt section.

``prompt.txt`` beside this module is generated from the app's own component library
(``app/scripts/build-openui-prompt.mjs``), and an app test fails when the two disagree: the words a
model is told and the components the app can draw are one fact on either side of a process boundary
(ADR 0032). Hermes renders a section once when a session starts and freezes it into the stored
prompt, so a library change reaches the next chat and costs nothing per turn.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any, Dict, Mapping, Optional

logger = logging.getLogger(__name__)

FEATURE = "openui"
SECTION = "openui"
POSITION = "after_memory"

# `plugin/openui.py` and the `plugin/openui/` folder coexist on purpose: the module wins the import
# and the artifact folder is its sibling. Never `importlib.resources`, which would look inside a
# package that isn't one.
ARTIFACT = Path(__file__).parent / "openui" / "prompt.txt"
# The artifact's first line: the library the words were generated from, and the version that parses
# them. Read from the text, so there is one version source and no sidecar file to fall behind.
_HEADER = re.compile(r"^# @openuidev/react-lang (\S+)\s*$", re.M)

# Hermes's DEFAULT_SYSTEM_PROMPT_SECTION_MAX_CHARS, and the cap the generator writes under. A
# section past it is dropped whole at render, so registering one would advertise a vocabulary the
# model is never told.
LIMIT = 4_000


def _read() -> str:
    """The artifact's words, or "" when it can't be read: a missing file must not break the plugin."""
    try:
        return ARTIFACT.read_text(encoding="utf-8")
    except OSError:
        logger.warning("memento: couldn't read the openui prompt artifact", exc_info=True)
        return ""


def _version(text: str) -> Optional[str]:
    match = _HEADER.search(text)
    return match.group(1) if match else None


TEXT = _read()
VERSION = _version(TEXT)

# Why the section isn't registered, while it isn't. `info` reads it (through `advertised`) so a host
# that can't be told the library doesn't claim it can: the client gates on a bare feature string, and
# one nothing honours would offer a control that can't work. Whether Hermes takes a section is a
# property of the process it runs on, so one answer serves every profile's `info`, the routes of a
# `/p/<profile>` bot included.
_refused: Optional[str] = "The openui section isn't registered."


def content(_session: Optional[Mapping[str, Any]] = None) -> str:
    """The section's text for a session, which Hermes renders once and freezes into its prompt.

    A stored switch will be read here and answered with "" while interfaces are off: an empty
    section is the only way to withhold one, and it is dropped silently.
    """
    return TEXT


def register(ctx: Any) -> bool:
    """Registers the section with this Hermes, or leaves the plugin running without it.

    This Hermes may predate `register_system_prompt_section` (the plugin ships ahead of the host it
    runs on), and the call raises for anything it doesn't like, so it is guarded: a raise here
    would take every route of the plugin down with it.
    """
    global _refused
    register_section = getattr(ctx, "register_system_prompt_section", None)
    if not callable(register_section):
        _refused = "This Hermes can't add a system-prompt section."
        return False
    if not TEXT or VERSION is None:
        _refused = "The openui prompt artifact didn't load."
        return False
    if len(TEXT) > LIMIT:
        _refused = "The openui prompt artifact is over the host's section limit."
        return False
    try:
        register_section(SECTION, content, position=POSITION)
    except Exception:
        logger.warning("memento: couldn't register the openui section", exc_info=True)
        _refused = "This Hermes refused the openui section."
        return False
    _refused = None
    logger.info("memento: telling the model the component library (%s)", VERSION)
    return True


def advertised() -> Optional[Dict[str, str]]:
    """The sibling object `info` carries beside the bare feature, or None where there is none.

    The version rides here rather than inside `features`: the client matches those with `includes`,
    so a versioned string would read as absent on every screen.
    """
    return None if _refused is not None else {"version": VERSION}
