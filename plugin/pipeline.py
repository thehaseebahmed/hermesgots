"""A staged AFK task's stages — Build, Gate, Critique — and the rule that says which comes next.

A project that has picked at least one critique skill works its tasks in stages: a build run that
cannot ship, a gate the host runs over what the build named, and a critique run that reviews the
work and opens the pull request last (ADR 0018). This module is that rule and nothing else: it
takes values — the session's record, whether the run ended, the gate's answer and the worktree's
state — and answers where the task goes, so it is tested with no host, no GitHub and no browser.

The record is the session's own, not the project's hold, because the hold is released when a run
ends: a finished task still has to say how it got there (`afk.read` names its stage under Working).

"""

from __future__ import annotations

from typing import Any, Dict, Iterable, List, NamedTuple, Optional, Sequence

BUILD = "build"
GATE = "gate"
CRITIQUE = "critique"
DONE = "done"
STAGES = (BUILD, GATE, CRITIQUE, DONE)

# Why a build that finished still can't be critiqued. The gate's own answer is what decides the
# first two; the rest is what a gate can't see from the commands alone.
NO_GATE = "The build ended without running the gate."
FAILED_GATE = "The gate failed: {command} exited {code}."
UNCOMMITTED = "The build left uncommitted changes in the worktree."
NO_COMMITS = "The build left no commits in the worktree."


class Step(NamedTuple):
    """Where a staged task goes when a run of it ends: the stage it is in now, the run to start
    next (``None`` when nothing more runs), and why it stalled instead (``None`` when it didn't)."""

    stage: str
    next: Optional[str]
    stall: Optional[str]


def start(build_skill: Any, critique_skills: Iterable[Any]) -> Optional[Dict[str, Any]]:
    """The record a staged task starts with, or ``None`` when no critique skill turns it on.

    A build skill alone doesn't: the pipeline exists to make a critique safe, so with nothing
    chosen to critique, AFK is one run that ships, exactly as it was before.
    """
    build = _text(build_skill)
    skills = [name for name in (_text(one) for one in _names(critique_skills)) if name]
    skills = list(dict.fromkeys(skills))
    if not skills:
        return None
    return {
        "stage": BUILD,
        "build_skill": build,
        "critique_skills": skills,
        "gate": None,
        "reason": None,
    }


def read(value: Any) -> Optional[Dict[str, Any]]:
    """A session's pipeline as the record holds it, or ``None`` when it holds no pipeline.

    A row written before the column, or one whose JSON a hand edit broke, reads as no pipeline:
    a session that is not staged is every session the app has had until now.
    """
    if not isinstance(value, dict) or value.get("stage") not in STAGES:
        return None
    gate = value.get("gate")
    return {
        "stage": value["stage"],
        "build_skill": _text(value.get("build_skill")),
        "critique_skills": [
            name
            for name in (_text(one) for one in _names(value.get("critique_skills")))
            if name
        ],
        "gate": gate if isinstance(gate, dict) else None,
        "reason": _text(value.get("reason")),
    }


def stage(record: Optional[Dict[str, Any]]) -> Optional[str]:
    """The stage a staged task is in, or ``None`` when its session isn't staged."""
    return record["stage"] if record else None


def blocks_ship(record: Optional[Dict[str, Any]]) -> bool:
    """Whether this session is still building, so nothing may ship from it yet.

    The gate is part of the build's own work — the commands run while the build run is going —
    so a task waiting at its gate can't ship either. Shipping is the critique's act, and the
    build's own only for a project that chose no critique skill at all (no pipeline, no block).
    """
    return stage(record) in (BUILD, GATE)


def advance(
    record: Optional[Dict[str, Any]],
    stopped: Optional[str] = None,
    worktree: Sequence[Dict[str, Any]] = (),
) -> Step:
    """Where a staged task goes when a run of it ends.

    ``stopped`` is why the run didn't finish, in the words the app shows (the caller's own, the
    same ones a one-run AFK session uses); a stopped run keeps the stage it was in and starts
    nothing. A build that finished is judged by its gate: the call has to have happened, every
    command has to have exited zero, no worktree may hold uncommitted changes and at least one
    has to hold commits beyond its base — else the task stalls at the gate with the failure named,
    which is the whole point of the host running the commands rather than taking the run's word.
    A critique that finished ships, so the pipeline is done.
    """
    if record is None or record["stage"] == DONE:
        return Step(DONE, None, None)
    if stopped:
        return Step(record["stage"], None, stopped)
    if record["stage"] in (BUILD, GATE):
        return _after_build(record, list(worktree))
    return Step(DONE, None, None)


def moved(record: Dict[str, Any], step: Step) -> Dict[str, Any]:
    """The record a step leaves behind: the stage it is in now, and why it stalled if it did."""
    return {**record, "stage": step.stage, "reason": step.stall}


def gated(record: Dict[str, Any], commands: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    """The record once the build has run its gate, keeping each command's exit code."""
    return {**record, "stage": GATE, "gate": {"commands": list(commands)}}


def _after_build(record: Dict[str, Any], worktree: List[Dict[str, Any]]) -> Step:
    answer = record.get("gate") or {}
    commands = [one for one in answer.get("commands") or [] if isinstance(one, dict)]
    if not commands:
        return Step(GATE, None, NO_GATE)
    failed = next((one for one in commands if one.get("code") != 0), None)
    if failed is not None:
        return Step(
            GATE,
            None,
            FAILED_GATE.format(command=failed.get("command") or "", code=failed.get("code")),
        )
    if any(one.get("changed") for one in worktree):
        return Step(GATE, None, UNCOMMITTED)
    if not any(one.get("ahead") for one in worktree):
        return Step(GATE, None, NO_COMMITS)
    return Step(CRITIQUE, CRITIQUE, None)


def _text(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    return value.strip() or None


def _names(value: Any) -> List[Any]:
    """The entries of a stored list or a caller's sequence, and none from anything else.

    A hand edit that leaves a bare string where the list goes would otherwise be read one character
    at a time — eleven skills named by ``code-review`` — so text is no names, and neither is a value
    that isn't a sequence at all.
    """
    if isinstance(value, (str, bytes)):
        return []
    try:
        return list(value)
    except TypeError:
        return []
