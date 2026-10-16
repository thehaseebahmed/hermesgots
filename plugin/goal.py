"""A chat's goal: Hermes's own ``/goal``, set from the app's wizard and kept going between runs.

The wizard writes the goal text and this module hands it to
``hermes_cli.goal_command.dispatch_goal_command``, so a goal set from Gots is set exactly as the CLI
sets one — headline, completion contract and quality gates — and Hermes's own judge is what decides
when it is done. The goal itself lives in the session database (``state_meta``), which is why every
read and write here happens inside the request's or session's profile scope.

The loop at the bottom is ours: the API server has no goal dispatch and no continuation engine, so
the plugin judges each finished turn of a session that has a goal and starts the next run itself.
Every other surface has an engine of its own (the CLI's turn loop, the gateway's for platform
sessions), which is why the loop only takes the API server's turns.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import threading
from collections import OrderedDict
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from . import events, outbox, sessions

logger = logging.getLogger(__name__)

# What the wizard may ask for: one turn at least, and a budget that can't be a typo for "forever".
MIN_TURNS = 1
MAX_TURNS = 500
# The user's own actions (``/goal pause`` and the rest), which control a goal instead of replacing it.
ACTIONS = ("pause", "resume", "clear")
CONTRACT_FIELDS = ("outcome", "verification", "constraints", "boundaries", "stop_when")
# How many sessions' turn ends the loop remembers. Enough for the chats that can be in flight at once,
# and a bound on a plugin that runs for weeks.
KEPT = 64
# Hermes stores a session's goal in the session database under this key.
META_PREFIX = "goal:"


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


# ── the loop ──────────────────────────────────────────────────────────────
#
# The API server starts a run, the agent works, the turn ends — and nothing continues a goal, because
# the loop that does lives in the CLI. So the plugin runs it: the turn that just ended is judged
# through ``GoalManager.evaluate_after_turn``, and a ``continue`` verdict posts the next run itself.
#
# Both hooks run on the turn's thread and neither may block it, so the judgment goes to a thread of
# its own: the judge is a model call. The turn's profile scope is captured there (a fresh thread sees
# no contextvars) and re-entered on the thread, so the goal, its state and the judge's credentials
# are all this profile's.

adapter: Any = None
_scope_of: Optional[Callable[[], Any]] = None
_profile_of: Optional[Callable[[], Optional[str]]] = None

_lock = threading.Lock()
# What each session's last finished turn said, for the judge.
_responses: "OrderedDict[str, str]" = OrderedDict()
# The turn end already judged for each session, so a duplicate one posts nothing.
_marks: "OrderedDict[str, str]" = OrderedDict()
# Sessions with a judgment in flight, so one session is never judged twice at once.
_running: set = set()


def wire(api_adapter: Any, scope: Any = None, profile: Any = None) -> None:
    """Keeps the adapter and the API server's own scope readers.

    They are the server's closures, so they are handed in rather than guessed at: ``scope()`` returns
    the context manager that re-enters the current profile, and ``profile()`` its name (which picks
    the bot's own loopback URL and key when the loop posts a run).
    """
    global adapter, _scope_of, _profile_of
    adapter, _scope_of, _profile_of = api_adapter, scope, profile


def waiting(home: Path) -> Dict[str, Dict[str, Any]]:
    """Every goal in this profile that waits on the user, by session id.

    A goal is waiting when only a person can move it: paused (the budget spent, a gate out of retries,
    a judge this host can't reach) or blocked by the judge's last verdict. A goal parked on a process
    or a deadline is waiting on the machine, and a done one is finished, so neither is here.
    """
    found: Dict[str, Dict[str, Any]] = {}
    for session_id, state in _goals(home):
        if state.status == "paused":
            reason = state.paused_reason or "paused"
        elif state.status == "active" and state.last_verdict == "blocked":
            reason = state.last_reason or "blocked"
        else:
            continue
        found[session_id] = {"kind": "goal", "reason": str(reason)}
    return found


def _goals(home: Path) -> List[Any]:
    """``[(session_id, GoalState), ...]`` for this profile's sessions that have a goal.

    Read through the registry's shared handle for ``home``, the way Hermes's own loop feature reads
    its own: one writer per profile, and nothing here holds the handle after it.
    """
    try:
        from hermes_state_registry import acquire, release_or_close
    except ImportError:
        return []
    try:
        from hermes_cli import goals
    except ImportError:
        return []
    rows: List[Any] = []
    db = None
    try:
        db = acquire(home / "state.db")
        rows = db.list_meta_prefix(META_PREFIX)
    except Exception:
        logger.debug("memento: couldn't list this profile's goals", exc_info=True)
        return []
    finally:
        if db is not None:
            with contextlib.suppress(Exception):
                release_or_close(db)
    found = []
    for key, raw in rows:
        session_id = key[len(META_PREFIX):]
        if not session_id or not raw:
            continue
        try:
            found.append((session_id, goals.GoalState.from_json(raw)))
        except Exception:
            logger.warning("memento: couldn't read the stored goal of %s", session_id, exc_info=True)
    return found


def remember(**kwargs: Any) -> None:
    """``post_llm_call``: keeps what the turn said, for the judge that runs when it ends."""
    session_id = kwargs.get("session_id")
    response = kwargs.get("assistant_response")
    if not isinstance(session_id, str) or not isinstance(response, str) or not response.strip():
        return
    with _lock:
        _keep(_responses, session_id, response)


def turn_finished(**kwargs: Any) -> None:
    """``on_session_end``: judges the finished turn and starts the next run when it isn't done.

    Only the API server's turns: the CLI and the gateway continue their own sessions, and judging
    theirs here would spend their budget twice. Never raises — it runs inside Hermes's hooks.
    """
    try:
        session_id = kwargs.get("session_id")
        if not isinstance(session_id, str) or not session_id:
            return
        if kwargs.get("platform") not in (None, "api_server"):
            return
        if not kwargs.get("completed") or kwargs.get("failed") or kwargs.get("interrupted"):
            return
        mark = kwargs.get("turn_id")
        mark = mark if isinstance(mark, str) and mark else None
        with _lock:
            if mark is not None and _marks.get(session_id) == mark:
                return
            if session_id in _running:
                return
            if mark is not None:
                _keep(_marks, session_id, mark)
            response = _responses.pop(session_id, "")
            _running.add(session_id)
        # The turn's own profile: the hook runs inside it, a fresh thread would not.
        path, home = sessions._paths()
        scope = _scope_of() if callable(_scope_of) else contextlib.nullcontext
        profile = _profile_of() if callable(_profile_of) else None
        model = kwargs.get("model")
        _start(session_id, (session_id, response, model, path, home, scope, profile))
    except Exception:
        logger.debug("memento: couldn't look at a finished turn", exc_info=True)


def _start(session_id: str, args: tuple) -> None:
    """Runs one judgment on a thread of its own. Patched in the tests, which run it inline."""
    threading.Thread(
        target=_judge, args=args, name=f"memento-goal-{session_id}", daemon=True
    ).start()


def _judge(
    session_id: str,
    response: str,
    model: Any,
    path: Path,
    home: Path,
    scope: Any,
    profile: Optional[str],
) -> None:
    """The loop's thread: judge the turn, then start the next run if the goal goes on."""
    try:
        with scope():
            prompt = judge(session_id, response)
            events.note("session", session_id, path, True)
            events.note("runs", session_id, path, True)
            if not prompt:
                return
            _continue(session_id, prompt, model, profile, path)
    except Exception as error:
        logger.warning("memento: the goal of %s couldn't be judged: %s", session_id, error)
    finally:
        with _lock:
            _running.discard(session_id)


def judge(session_id: str, response: str) -> Optional[str]:
    """Judges one finished turn; the prompt to continue with, or None to stop.

    Nothing to judge is not a failure: a goal paused, done or cleared while the thread waited (or
    never set at all) leaves the turn alone, and so does a verdict of done, blocked or wait — a goal
    parked on a process or a deadline wakes on its own.
    """
    goal_manager = manager(session_id)
    if not goal_manager.is_active():
        return None
    with _session_cwd(session_id):
        decision = goal_manager.evaluate_after_turn(response, user_initiated=False)
    if not decision.get("should_continue"):
        return None
    prompt = decision.get("continuation_prompt") or goal_manager.next_continuation_prompt()
    if not prompt:
        return None
    turns = getattr(goal_manager.state, "turns_used", 0) or 0
    logger.info("memento: continuing the goal of %s (%s turns used)", session_id, turns)
    return str(prompt)


@contextlib.contextmanager
def _session_cwd(session_id: str):
    """Runs this judgment's quality gates in the session's own folder.

    Hermes reads the workspace for a gate from a contextvar that only its own turn loops set, and the
    API server isn't one of them, so without this a gate would run wherever the plugin happens to be
    — checking a different project, which is exactly what has to not happen. Best effort: a Hermes
    without the contextvar keeps its own resolution.
    """
    cwd = sessions._cwd(session_id)
    if not cwd:
        yield
        return
    try:
        from agent.runtime_cwd import reset_session_cwd, set_session_cwd
    except ImportError:
        yield
        return
    token = set_session_cwd(cwd)
    try:
        yield
    finally:
        reset_session_cwd(token)


def _continue(
    session_id: str, prompt: str, model: Any, profile: Optional[str], path: Path
) -> None:
    """Starts the goal's next turn as a run of this session, the way the app starts one.

    Keyed by the session, so a judgment that somehow runs twice can't start the same continuation
    twice: the API server answers a repeated key with the run it already started.
    """
    body: Dict[str, Any] = {"session_id": session_id, "input": prompt}
    if isinstance(model, str) and model:
        body["model"] = model
    try:
        asyncio.run(
            outbox.post(adapter, profile, "/v1/runs", body, idempotency_key=f"goal:{session_id}")
        )
    except Exception as error:
        logger.warning("memento: couldn't continue the goal of %s: %s", session_id, error)
        return
    logger.info("memento: continued the goal of %s", session_id)
    events.note("runs", session_id, path, True)


def _keep(store: "OrderedDict[str, Any]", key: str, value: Any) -> None:
    """Keeps the newest ``KEPT`` entries, so a plugin that runs for weeks doesn't grow one per
    session it ever saw."""
    store[key] = value
    store.move_to_end(key)
    while len(store) > KEPT:
        store.popitem(last=False)

