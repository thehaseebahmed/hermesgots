"""A chat's goal: Hermes's own ``/goal``, set from the app's wizard.

The wizard writes the goal text and this module hands it to
``hermes_cli.goal_command.dispatch_goal_command``, so a goal set from Gots is set exactly as the CLI
sets one — headline, completion contract and quality gates — and Hermes's own judge is what decides
when it is done. The goal itself lives in the session database (``state_meta``), which is why every
read and write here happens inside the request's profile scope.

The loop is ours (``loop.py``): the API server has no goal dispatch and no continuation engine, so
the plugin judges each finished turn of a session that has a goal and starts the next one itself.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

# What the wizard may ask for: one turn at least, and a budget that can't be a typo for "forever".
MIN_TURNS = 1
MAX_TURNS = 500
# The user's own actions (``/goal pause`` and the rest), which control a goal instead of replacing it.
ACTIONS = ("pause", "resume", "clear")
CONTRACT_FIELDS = ("outcome", "verification", "constraints", "boundaries", "stop_when")


class GoalError(Exception):
    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


def _hermes():
    """Hermes's own goal modules, imported at call time: a plugin loads before the CLI does."""
    try:
        from hermes_cli import goal_command, goals
    except ImportError as error:
        raise GoalError("This Hermes version has no /goal command to set one with.", 501) from error
    if not callable(getattr(goal_command, "dispatch_goal_command", None)):
        raise GoalError("This Hermes version has no /goal command to set one with.", 501)
    return goals, goal_command


def available() -> Optional[str]:
    """Why this host can't hold a goal, or None when it can."""
    try:
        _hermes()
    except GoalError as error:
        return str(error)
    return None


def clean_max_turns(value: Any) -> Optional[int]:
    """The wizard's turn budget: a whole number of turns, or None for the host's own default."""
    if value is None or value == "":
        return None
    if isinstance(value, bool) or not isinstance(value, (int, str)):
        raise ValueError("max_turns must be a whole number of turns.")
    try:
        turns = int(str(value).strip())
    except ValueError:
        raise ValueError("max_turns must be a whole number of turns.") from None
    if not MIN_TURNS <= turns <= MAX_TURNS:
        raise ValueError(f"max_turns must be between {MIN_TURNS} and {MAX_TURNS}.")
    return turns


def clean_gates(value: Any) -> List[str]:
    """The wizard's quality gates, in order: the shell commands that must pass before the judge may
    call the goal done."""
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValueError("gates must be a list of commands.")
    gates = []
    for entry in value:
        if not isinstance(entry, str) or not entry.strip():
            raise ValueError("A gate is a shell command.")
        gates.append(entry.strip())
    return gates[:10]


def manager(session_id: str, max_turns: Optional[int] = None):
    """Hermes's goal manager for one session, with the wizard's budget as its default.

    ``GoalManager`` reads the session's goal out of the state database on construction, so this
    must run in the profile that owns the session.
    """
    goals, _ = _hermes()
    default = max_turns or getattr(goals, "DEFAULT_MAX_TURNS", None)
    return goals.GoalManager(session_id, default_max_turns=default or 20)


def _dispatch(goal_manager: Any, arg: str, *, last_user_message: Optional[str] = None):
    _, command = _hermes()
    return command.dispatch_goal_command(
        goal_manager, arg, authorize_gate=_authorized, last_user_message=last_user_message
    )


def _authorized() -> Optional[str]:
    """Whether this goal may run a shell command as a quality gate: it may.

    Hermes asks an adapter to authorize gate creation, and the adapter here is the app, where the
    user typed the gate into the wizard and could see it in the preview. So the answer is always
    yes; the hardline command blocklist still runs.
    """
    return None


def view(state: Any) -> Optional[Dict[str, Any]]:
    """The goal as the app shows it, or None when the session hasn't one."""
    if state is None:
        return None
    contract = getattr(state, "contract", None)
    return {
        "goal": state.goal,
        "status": state.status,
        "turns_used": int(state.turns_used or 0),
        "max_turns": int(state.max_turns or 0),
        "subgoals": [str(item) for item in state.subgoals or []],
        "contract": {
            field: str(getattr(contract, field, "") or "") for field in CONTRACT_FIELDS
        },
        "gates": [
            {
                "command": gate.command,
                "passing": gate.last_exit_code == 0 if gate.last_exit_code is not None else None,
                "exit_code": gate.last_exit_code,
                "attempts": int(gate.attempts or 0),
                "max_retries": int(gate.max_retries or 0),
                "output": gate.last_output_tail,
            }
            for gate in state.gates or []
        ],
        "verdict": state.last_verdict,
        "reason": state.last_reason,
        "paused_reason": state.paused_reason,
        "waiting": state.waiting_reason,
    }


def read(session_id: str) -> Dict[str, Any]:
    """The session's goal, whether or not there is one."""
    return {"goal": view(manager(session_id).state)}


def apply(
    session_id: str, command: Any, gates: Any = None, max_turns: Any = None
) -> Dict[str, Any]:
    """Set the goal from the wizard's ``/goal`` text, then add its quality gates.

    The text goes through Hermes's own parser, so a field the wizard wrote is a field Hermes sees,
    and a refusal comes back as one. ``--`` marks the text verbatim: the headline is the user's
    words, even when it begins with a word ``/goal`` would otherwise read as an action.
    """
    text = command.strip() if isinstance(command, str) else ""
    if not text:
        raise GoalError("A goal needs something to work towards.", 400)
    budget = clean_max_turns(max_turns)
    wanted = clean_gates(gates)
    goal_manager = manager(session_id, budget)
    result = _dispatch(goal_manager, f"-- {text}")
    if result.error:
        raise GoalError(result.output, 400)
    for gate in wanted:
        added = _dispatch(goal_manager, f"gate add {gate}")
        if added.error:
            raise GoalError(added.output, 400)
    return {"goal": view(goal_manager.state), "kick": result.prompt, "output": result.output}


def control(session_id: str, action: Any) -> Dict[str, Any]:
    """Pause, resume or clear the session's goal, as the app's sheet does."""
    if action not in ACTIONS:
        raise GoalError(f"Unknown goal action {action!r}.", 400)
    goal_manager = manager(session_id)
    result = _dispatch(goal_manager, str(action))
    if result.error:
        raise GoalError(result.output, 409)
    return {
        "goal": view(goal_manager.state),
        "kick": result.prompt,
        "message": result.output,
    }
