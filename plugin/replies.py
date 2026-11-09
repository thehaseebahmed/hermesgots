"""The rule a reply is written by, told to every session as a system-prompt section.

Hermes tells an ``api_server`` run that the rendering layer is unknown, so it should assume plain
text and use no markdown (``agent/prompt_builder.py``'s ``PLATFORM_HINTS["api_server"]``). Every
reply here is read in the Gots app, whose thread draws a message through ``react-markdown``
(``app/src/components/chat/markdown.tsx``), so that default is wrong on this surface: the section
says so in its own words, because a model told both needs to be told which one holds.

It is a section rather than a line in ``prompt_builder`` because a section reaches every session. A
plain chat has no worktree, so ``session_prompt`` is never built for it and its ``instructions``
carry only the app's own hint; a section is registered once with the host and rendered into each new
session's prompt, chat or coding alike, after the platform hint in the volatile tail — so the rule is
the last thing the run is told about formatting. ``openui`` and a routine's delivery are told the
same way.

Fixed text that names no path, branch or issue, so every session's prompt shares these bytes. Hermes
freezes a section into the prompt when the session starts and restores those bytes on resume, so a
chat already open keeps the words it was started with.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

SECTION = "gots_replies"

TEXT = """## How a reply is written

Every reply here is drawn as markdown by the app, so Hermes's "assume plain text" default for an API server does not hold in a Gots chat: write replies as markdown rather than one block of prose.

- Break a reply into paragraphs, one idea each, with a blank line between them.
- Use a list for three or more separate points, findings or options, and number it where the order is the steps to take.
- Put commands, file paths and identifiers in `code spans`, and a longer snippet in a fenced block that names its language.
- Give a long reply a heading or a bold lead-in to scan by; give a short one neither.
- Keep a short answer short. Markdown is how a reply is shaped, never a reason to make it longer."""


def content(_session: Any = None) -> str:
    """The section as a new session is told it; the session changes nothing in it."""
    return TEXT


def register_section(ctx: Any) -> bool:
    """Tells a new session's prompt how a reply is written, on a host that takes a section.

    Hermes may predate ``register_system_prompt_section``, or refuse this section, and neither may
    take a route down with it: a host without it answers False and runs as it did.
    """
    register = getattr(ctx, "register_system_prompt_section", None)
    if not callable(register):
        return False
    try:
        register(SECTION, content, position="after_memory")
    except Exception:
        logger.warning("gots: couldn't tell the model how a reply is written", exc_info=True)
        return False
    return True
