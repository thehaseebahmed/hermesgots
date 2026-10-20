"""The gate a staged AFK task's build is checked at: the commands it names, run on the host.

The build can't be trusted to say it verified anything, so it names the commands it means to be
checked by and this tool runs them, in the session's worktree, under a timeout, answering with each
one's exit code. The answer is kept on the session's pipeline record, and it is what `afk.after_run`
judges the finished build by — with the worktree's own state, which no command can vouch for
(ADR 0018). A call naming no command is refused, and so is a second one: the gate is asked once,
while the build is building, and a run that tries again after a failure has already had its answer.

"""

from __future__ import annotations

import json
import logging
import os
import signal
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
        "lint, build), then end the run. A project of more than one repo names the repo each "
        "command runs in. The run stops at the first command that fails. Don't ship: the pull "
        "request is the critique stage's. A gate that fails stalls the task with the command "
        "named, and a call naming no command is refused."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "commands": {
                "type": "array",
                "items": {
                    "anyOf": [
                        {"type": "string"},
                        {
                            "type": "object",
                            "properties": {
                                "command": {"type": "string"},
                                "repo": {"type": "string"},
                            },
                            "required": ["command"],
                        },
                    ]
                },
                "description": (
                    "The commands to run, each as one shell line in the session's worktree — or, "
                    "for a project of more than one repo, as an object naming the command and the "
                    "repo it runs in. Required, and at least one."
                ),
            },
        },
        "required": ["commands"],
    },
}


def run(tree: str, command: str) -> int:
    """Runs one command in the worktree, answering its exit code (124 when it ran out of time).

    Its output is dropped rather than read: the answer is the exit code, and a command whose own
    children hold the pipe open would otherwise outlive the timeout meant to bound it. It runs in a
    session of its own for the same reason, so the timeout can end the whole tree.
    """
    try:
        process = subprocess.Popen(
            command,
            shell=True,
            cwd=tree,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except OSError:
        logger.warning("memento: the gate's command couldn't run: %s", command, exc_info=True)
        return 1
    try:
        return process.wait(timeout=GATE_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        logger.warning("memento: the gate's command timed out after %ss: %s", GATE_TIMEOUT_S, command)
        _end(process)
        return TIMED_OUT


def _end(process: "subprocess.Popen[bytes]") -> None:
    """Ends a command and everything it started, then reaps it."""
    try:
        os.killpg(os.getpgid(process.pid), signal.SIGKILL)
    except OSError:
        process.kill()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        logger.warning("memento: the gate's command won't die: %s", process.pid)


def _asked(commands: Any) -> Optional[List[Dict[str, str]]]:
    """The commands a call names, each with the repo it belongs to when it names one.

    None for anything that isn't at least one command, so a call with a typo in its shape is
    refused rather than half run.
    """
    if not isinstance(commands, list) or not commands:
        return None
    asked: List[Dict[str, str]] = []
    for one in commands:
        if isinstance(one, str):
            line, repo = one, None
        elif isinstance(one, dict):
            line, repo = one.get("command"), one.get("repo")
        else:
            return None
        if not isinstance(line, str) or not line.strip():
            return None
        if repo is not None and (not isinstance(repo, str) or not repo.strip()):
            return None
        asked.append({"command": line.strip(), **({"repo": repo.strip()} if repo else {})})
    return asked


def _past_gate(stage: str) -> str:
    """Why a session that isn't building has no gate to run."""
    if stage == pipeline.GATE:
        return (
            "This session has already run its gate, and the host has its answer: a second call "
            "would overwrite the failure this task is stalled on. End the run."
        )
    return "This session is past its gate: only a build that hasn't been gated has one to run."


def handle(args: Any, task_id: Optional[str] = None, session_id: Optional[str] = None, **_: Any) -> str:
    """The tool: runs the commands for the session this call belongs to, and keeps their codes."""
    from . import sessions

    args = args if isinstance(args, dict) else {}
    asked = _asked(args.get("commands"))
    if asked is None:
        return json.dumps(
            {"error": "commands is required: name the commands this build is checked by."}
        )
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
    if not pipeline.building(staged):
        return json.dumps({"error": _past_gate(staged["stage"])})
    tree = record.get("path")
    if not tree or not os.path.isdir(tree):
        return json.dumps({"error": "This session's worktree is gone."})
    # The repos this session works in, by the name its own instructions give them: a project of
    # more than one has a suite per repo, and a gate that ran one of them would pass work it never
    # saw. Refusing an unknown name before running anything keeps a typo from half-running a gate.
    trees = {str(repo.get("name")): repo.get("path") for repo in record.get("repos") or []}
    unknown = sorted({one["repo"] for one in asked if one.get("repo") and one["repo"] not in trees})
    if unknown:
        return json.dumps(
            {
                "error": (
                    f"This session has no repo named {', '.join(unknown)}. It works in "
                    f"{', '.join(sorted(trees)) or 'no repos'}."
                )
            }
        )
    results: List[Dict[str, Any]] = []
    for one in asked:
        where = trees[one["repo"]] if one.get("repo") else tree
        if not where or not os.path.isdir(where):
            return json.dumps({"error": f"The worktree of {one['repo']} is gone."})
        code = run(where, one["command"])
        results.append({**one, "code": code})
        # A failed command stalls the task whatever follows it, and the run is waiting on this
        # call: the rest would be minutes spent on an answer nobody reads.
        if code != 0:
            break
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
