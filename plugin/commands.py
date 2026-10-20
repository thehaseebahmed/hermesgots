"""Each shell command an AFK session's run executes, kept against the stage and round it ran in.

The details sheet says what a stage actually did, and most of that is the agent's own lint, typecheck
and tests rather than the gate the host runs at the end: a ``pre_tool_call`` hook keeps the command
line of every ``terminal`` call on the session's pipeline record — the line only, with no output and
no result — so a finished task can still say what it ran. Only an AFK session has a pipeline to write
to, so a chat or a plain code session records nothing, and the record is the session's own, so it
goes when the session does. The rule for what a stage keeps is ``pipeline.ran``; nothing is decided
here.
"""

from __future__ import annotations

import logging
from typing import Any

from . import pipeline, sessions

logger = logging.getLogger(__name__)

# The tool whose calls are shell commands, and the argument its command line arrives in. Gots's
# sessions run on the API server, so a command reaches the host as this tool call and no other.
TOOL = "terminal"
ARGUMENT = "command"


def before_tool(**kwargs: Any) -> None:
    """The ``pre_tool_call`` hook: records one command the run is about to execute.

    Never raises: it runs inside Hermes's own tool loop, where a hook's error would end the call it
    was watching.
    """
    try:
        _before_tool(kwargs)
    except Exception:
        logger.debug("memento: couldn't record a shell command", exc_info=True)


def _before_tool(kwargs: dict) -> None:
    if kwargs.get("tool_name") != TOOL:
        return
    args = kwargs.get("args")
    line = args.get(ARGUMENT) if isinstance(args, dict) else None
    if not isinstance(line, str) or not line.strip():
        return
    path, home = sessions._paths()
    record = sessions.record_for_call(
        path, home, kwargs.get("task_id") or "", kwargs.get("session_id") or ""
    )
    if not record:
        return
    staged = pipeline.read(record.get("pipeline"))
    if staged is None:
        # Not an AFK session: only a staged task has a stage to record a command against.
        return
    sessions.set_pipeline(path, record["session_id"], pipeline.ran(staged, line))
