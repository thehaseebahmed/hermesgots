"""The gate a staged AFK task's build is checked at: the commands it names, run on the host.

The build can't be trusted to say it verified anything, so it names the commands it means to be
checked by and this tool runs them, in the session's worktree, under a timeout, answering with each
one's exit code. The answer is kept on the session's pipeline record, and it is what `afk.after_run`
judges the finished build by — with the worktree's own state, which no command can vouch for
(ADR 0018). A call naming no command is refused, and so is one from a session that isn't building:
there is no gate in front of a critique, or behind it.

"""

from __future__ import annotations

import json
import logging
import os
import subprocess
from typing import Any, Dict, List, Optional

from . import pipeline, tools_common

logger = logging.getLogger(__name__)

TOOL = "afk_gate"
# What one gate command may take: a repo's own suite can be slow, and a command that hangs must
# still answer, since the run is waiting on it.
GATE_TIMEOUT_S = 600
# What `timeout(1)` answers with, so a hung command reads as a failure like any other.
TIMED_OUT = 124


SCHEMA = {
    "name": TOOL,
    "description": (
        "Runs the commands this build is checked by, on the host, in the session's worktree, and "
        "answers with each one's exit code — the gate of a staged AFK task. Commit the work first, "
        "then call this once with everything the repo checks itself with (its tests, typecheck, "
        "lint, build), then end the run. Don't ship: the pull request is the critique stage's. A "
        "gate that fails stalls the task with the command named, and a call naming no command is "
        "refused."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "commands": {
                "type": "array",
                "items": {"type": "string"},
                "description": (
                    "The commands to run, each as one shell line, in the session's worktree. "
                    "Required, and at least one."
                ),
            },
        },
        "required": ["commands"],
    },
}


def run(tree: str, command: str) -> int:
    """Runs one command in the worktree, answering its exit code (124 when it ran out of time)."""
    try:
        finished = subprocess.run(
            command,
            shell=True,
            cwd=tree,
            capture_output=True,
            text=True,
            timeout=GATE_TIMEOUT_S,
            stdin=subprocess.DEVNULL,
        )
    except subprocess.TimeoutExpired:
        logger.warning("memento: the gate's command timed out after %ss: %s", GATE_TIMEOUT_S, command)
        return TIMED_OUT
    except OSError:
        logger.warning("memento: the gate's command couldn't run: %s", command, exc_info=True)
        return 1
    return finished.returncode


def handle(args: Any, task_id: Optional[str] = None, session_id: Optional[str] = None, **_: Any) -> str:
    """The tool: runs the commands for the session this call belongs to, and keeps their codes."""
    from . import sessions

    args = args if isinstance(args, dict) else {}
    commands = args.get("commands")
    if not isinstance(commands, list) or not commands:
        return json.dumps(
            {"error": "commands is required: name the commands this build is checked by."}
        )
    if not all(isinstance(one, str) and one.strip() for one in commands):
        return json.dumps({"error": "Every command is one non-empty line."})
    path, home = sessions._paths()
    record = sessions.record_for_call(path, home, task_id, session_id)
    if not record:
        return json.dumps({"error": "This session has no worktree to gate."})
    staged = pipeline.read(record.get("pipeline"))
    if staged is None:
        return json.dumps(
            {
                "error": (
                    "This session isn't a staged task, so it has no gate: its work ships with the "
                    "pull_request tool, action 'ship'."
                )
            }
        )
    if staged["stage"] not in (pipeline.BUILD, pipeline.GATE):
        return json.dumps(
            {
                "error": (
                    f"This session is in its {staged['stage'].capitalize()} stage, so its gate is "
                    "behind it. Don't call afk_gate again."
                )
            }
        )
    tree = record.get("path")
    if not tree or not os.path.isdir(tree):
        return json.dumps({"error": "This session's worktree is gone."})
    results: List[Dict[str, Any]] = [
        {"command": one.strip(), "code": run(tree, one.strip())} for one in commands
    ]
    sessions.set_pipeline(path, record["session_id"], pipeline.gated(staged, results))
    logger.info(
        "memento: %s ran its gate: %s",
        record["session_id"],
        ", ".join(f"{one['command']} → {one['code']}" for one in results),
    )
    return json.dumps({"results": results, "passed": all(one["code"] == 0 for one in results)})


def register(ctx: Any) -> bool:
    """Registers the tool with Hermes, for every surface's agents of this profile."""
    register_tool = getattr(ctx, "register_tool", None)
    if not callable(register_tool):
        return False
    try:
        return register_tool(
            name=TOOL, toolset="memento", schema=SCHEMA, handler=handle, emoji="🚧"
        ) is not False
    except Exception:
        logger.warning("memento: couldn't register the afk_gate tool", exc_info=True)
        return False


def wire(adapter: Any) -> bool:
    """Wires the tool into every agent the API server builds."""
    return tools_common.wire_tool(adapter, TOOL, SCHEMA, "afk_gate")


def equip(agent: Any) -> None:
    tools_common.equip_tool(agent, TOOL, SCHEMA)
