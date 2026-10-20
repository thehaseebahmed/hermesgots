"""A staged AFK task's record: the workflow it runs, the stage it is in, and what each stage did.

A project picks a workflow and its tasks run it stage by stage (``workflows.py``). What this module
reads and writes is the task's own snapshot of that workflow: the workflow as it stood when the task
started, the stage it is in, the round, and one entry per stage holding its state and its rounds. So
editing or deleting a library entry cannot rewrite what a finished task says it ran — and a session's
own record, not the project's hold, which is released when a run ends, still says how the task got
there (ADR 0018).

Until the engine reads this shape itself, the step a task is in is read off the snapshot's position
(`kind`): a stage before the shipping one builds, one whose check is the gate and which names no
steps of its own is the gate step,
shipping stage is the review, and anything after it has shipped. That is what the gate tool, the
pull request tool and the prompts name it by, so a task's record can change shape without the tools
changing what they say.
"""

from __future__ import annotations

from typing import Any, Dict, List, NamedTuple, Optional, Sequence

from . import workflows
from .workflows import GATE, names, shipping, text

BUILD = "build"
# What a stage the host answers itself is called: the step a gate stage is known by.
GATE_CHECK = GATE
CRITIQUE = "critique"
DONE = "done"
STAGES = (BUILD, GATE_CHECK, CRITIQUE, DONE)

# The states one stage's entry can be in: the one the task is in, one that finished, one that
# stopped, and one it hasn't reached.
CURRENT = "current"
FINISHED = "done"
FAILED = "failed"
TODO = "todo"
STATES = (CURRENT, FINISHED, FAILED, TODO)

# Why a build that finished still can't be reviewed. The gate's own answer decides the first two;
# the rest is what a gate can't see from the commands alone.
NO_GATE = "The build ended without running the gate."
FAILED_GATE = "The gate failed: {command} exited {code}."
UNCOMMITTED = "The build left uncommitted changes in the worktree."
NO_COMMITS = "The build left no commits in the worktree."


class Step(NamedTuple):
    """Where a staged task goes when a run of it ends: the step it lands on, why it stalled instead
    (``None`` when it didn't) and which stage of the workflow that is.

    ``index`` is the stage the task moves to — the next one that runs, past the stages the host
    answers itself — so a workflow of any length hands over to its own next stage rather than to a
    step's name. It is ``None`` for a step that isn't a move (a stall, or a caller's own guess), and
    then the move is worked out from ``stage``.
    """

    stage: str
    stall: Optional[str]
    index: Optional[int] = None


def new_round() -> Dict[str, Any]:
    """One round of a stage as it starts: the run working it, what it ran, its gate and findings."""
    return {"run_id": None, "commands": [], "gate": None, "findings": [], "stop": None}


def start(workflow: Dict[str, Any]) -> Dict[str, Any]:
    """The snapshot a task starts with: the workflow as it stood, at its first stage, round one.

    Written before the task's first run is posted, so the instructions that run is given already
    know where it ends. After this the library is never consulted again: everything the task says
    about itself is in here.
    """
    stages: List[Dict[str, Any]] = []
    for index, stage in enumerate(workflow.get("stages") or []):
        stages.append(
            {
                **stage,
                # Copied, not shared: the snapshot is the task's own from here on, and the library's
                # body is someone else's to edit.
                "steps": list(stage.get("steps") or []),
                "loop": dict(stage["loop"]) if isinstance(stage.get("loop"), dict) else None,
                "state": CURRENT if index == 0 else TODO,
                "rounds": [new_round()] if index == 0 else [],
            }
        )
    return {
        "workflow": {"id": text(workflow.get("id")), "name": text(workflow.get("name")) or ""},
        "stage": 0,
        "round": 1,
        "stages": stages,
    }


def read(value: Any) -> Optional[Dict[str, Any]]:
    """A session's record as the column holds it, or ``None`` for a session that isn't staged.

    A record written before this shape — the three stages as a stage name and two skill lists — is
    upgraded into the workflow it meant rather than dropped, so a task finished before the upgrade
    still draws its stages after it. Anything else reads as no pipeline, which is every session the
    app has had until now.
    """
    if not isinstance(value, dict):
        return None
    if isinstance(value.get("workflow"), dict) and isinstance(value.get("stages"), list):
        return _snapshot(value)
    if value.get("stage") in STAGES:
        return _upgrade(value)
    return None


def _snapshot(value: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """A stored snapshot, cleaned: a hand edit or a row from before a key reads without throwing."""
    stages = [one for one in (_entry(item) for item in value.get("stages") or []) if one]
    if not stages:
        return None
    current = value.get("round")
    workflow = value.get("workflow") or {}
    return {
        "workflow": {
            "id": text(workflow.get("id")),
            "name": text(workflow.get("name")) or "",
        },
        "stage": _index(value.get("stage"), len(stages)),
        "round": current if isinstance(current, int) and current >= 1 else 1,
        "stages": stages,
    }


def _index(value: Any, length: int) -> int:
    """The stage a record is in, held to the stages it actually has."""
    if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= length:
        return 0
    return value


def _entry(value: Any) -> Optional[Dict[str, Any]]:
    """One stage of a snapshot: what the workflow said about it, and how its run went.

    The workflow's own fields are read by ``workflows.stages``, the same tolerant read the library
    uses, so a stage means one thing whether it is read off a library row or off a task's record.
    """
    found = workflows.stages([value])
    if not found:
        return None
    state = value.get("state")
    return {
        **found[0],
        "state": state if state in STATES else TODO,
        "rounds": [one for one in (_round(item) for item in value.get("rounds") or []) if one],
    }


def _round(value: Any) -> Optional[Dict[str, Any]]:
    """One round of a stage: the run that worked it, what it ran, its gate, findings and stop."""
    if not isinstance(value, dict):
        return None
    return {
        "run_id": text(value.get("run_id")),
        "commands": [_command(one) for one in value.get("commands") or [] if isinstance(one, dict)],
        "gate": value.get("gate") if isinstance(value.get("gate"), dict) else None,
        "findings": [one for one in value.get("findings") or [] if isinstance(one, dict)],
        "stop": text(value.get("stop")),
    }


def _command(value: Dict[str, Any]) -> Dict[str, Any]:
    """One command a stage ran: the line, the repo it ran in and, for the gate's, its exit code."""
    code = value.get("code")
    return {
        "command": text(value.get("command")) or "",
        "repo": text(value.get("repo")),
        "code": code if isinstance(code, int) and not isinstance(code, bool) else None,
    }


def _upgrade(value: Dict[str, Any]) -> Dict[str, Any]:
    """A record from before the snapshot, read as the three-stage workflow it meant.

    Build with the skill it built by, Test, Review with the skills it reviewed by and shipping on
    Review: exactly the shape the old record described, so a task finished before the upgrade still
    draws its stages. The stage it was in is the only one with a round, carrying the gate and the
    reason that record kept.
    """
    build = text(value.get("build_skill"))
    stages: List[Dict[str, Any]] = [
        {
            "name": "Build",
            "steps": [build] if build else [],
            "check": None,
            "loop": None,
            "ships": False,
            "state": TODO,
            "rounds": [],
        },
        {
            "name": "Test",
            "steps": [],
            "check": GATE,
            "loop": None,
            "ships": False,
            "state": TODO,
            "rounds": [],
        },
        {
            "name": "Review",
            "steps": names(value.get("critique_skills")),
            "check": None,
            "loop": None,
            "ships": True,
            "state": TODO,
            "rounds": [],
        },
    ]
    step = value.get("stage")
    at = min(STAGES.index(step), len(stages)) if step in STAGES else 0
    reason = text(value.get("reason"))
    for index, stage in enumerate(stages):
        if at >= len(stages):
            stage["state"] = FINISHED
            stage["rounds"] = [new_round()]
        elif index < at:
            stage["state"] = FINISHED
            stage["rounds"] = [new_round()]
        elif index == at:
            stage["state"] = FAILED if reason else CURRENT
            stage["rounds"] = [
                {
                    **new_round(),
                    "gate": value.get("gate") if isinstance(value.get("gate"), dict) else None,
                    "stop": reason,
                }
            ]
    return {
        "workflow": {"id": None, "name": "Build · Test · Review · Summary"},
        "stage": at,
        "round": 1,
        "stages": stages,
    }


def stage(record: Optional[Dict[str, Any]]) -> Optional[str]:
    """The step a staged task is in, in the words the app names it by, or ``None`` when its session
    isn't staged."""
    return kind(record)


def kind(record: Optional[Dict[str, Any]]) -> Optional[str]:
    """Which step a task is at, read off the snapshot's position (see the module's own words)."""
    if not record:
        return None
    stages = record["stages"]
    index = record["stage"]
    if index >= len(stages):
        return DONE
    return _kinds(stages)[index]


def _kinds(stages: Sequence[Dict[str, Any]]) -> List[str]:
    """Every stage's step, in order: what each of them is judged as."""
    ship = shipping(list(stages))
    found: List[str] = []
    for index, stage in enumerate(stages):
        if ship is None:
            found.append(BUILD)
        elif index == ship:
            found.append(CRITIQUE)
        elif index > ship:
            found.append(DONE)
        elif stage.get("check") and not stage.get("steps"):
            found.append(GATE_CHECK)
        else:
            found.append(BUILD)
    return found


def ships(record: Optional[Dict[str, Any]]) -> bool:
    """Whether the stage the task is in is the one that may open the pull request."""
    if not record:
        return False
    return shipping(record["stages"]) == record["stage"]


def gating(record: Optional[Dict[str, Any]]) -> bool:
    """Whether a task may run its gate now.

    A stage before the shipping one may, whenever its run likes: the commands are part of its own
    work, and a build that fixes what the gate named is exactly what a failing gate is for. The
    shipping stage may too, until its gate has answered — One run is a single stage that implements,
    gates itself and ships. Any other stage is past its gate.
    """
    if not record:
        return False
    if kind(record) in (BUILD, GATE_CHECK):
        return True
    return _single_stage(record) and gate_of(record) is None


def measured(record: Optional[Dict[str, Any]]) -> bool:
    """Whether a run of this stage is judged at its end by its gate and the worktree.

    A build and the gate stage that follows it are; so is One run's single stage, which gates itself
    before it ships.
    A review is not: its run ended when it shipped, and the pull request is what judges it.
    """
    if not record:
        return False
    return kind(record) in (BUILD, GATE_CHECK) or _single_stage(record)


def _single_stage(record: Dict[str, Any]) -> bool:
    """Whether the task's whole workflow is the one stage it is in, and that stage ships.

    One run is that workflow: nothing before its stage to build and nothing after it to review, so
    its run is judged at its own end. It is read from the stages rather than from the workflow's
    name, since a workflow of one shipping stage is the same shape however it was made.
    """
    return ships(record) and record["stage"] == 0


def for_app(record: Any) -> Optional[Dict[str, Any]]:
    """A task's record as the app reads a session's pipeline, or ``None`` when it holds none.

    The app draws a session's pipeline pill and the sheet under it, and both read the step a task is
    in, the skills each run was told, the gate's answer and why it stopped (ADR 0018). A workflow's
    own stages are the task's to keep: this is the view the pill has always been given, whichever
    shape the snapshot behind it holds.
    """
    staged = read(record)
    if staged is None:
        return None
    return {
        "stage": kind(staged),
        "build_skill": build_skill(staged),
        "critique_skills": critique_skills(staged),
        "gate": gate_of(staged),
        "reason": reason(staged),
    }


def advance(
    record: Optional[Dict[str, Any]],
    stopped: Optional[str] = None,
    worktree: Sequence[Dict[str, Any]] = (),
) -> Step:
    """Where a staged task goes when a run of it ends.

    ``stopped`` is why the run didn't finish, in the words the app shows (the caller's own, the same
    ones a one-run AFK session uses); a stopped run keeps the stage it was in and starts nothing. A
    build that finished is judged by its gate: the call has to have happened, every command has to
    have exited zero, no worktree may hold uncommitted changes and at least one has to hold commits
    beyond its base — else the task stalls at the gate with the failure named, which is the whole
    point of the host running the commands rather than taking the run's word.
    """
    if record is None or kind(record) == DONE:
        return Step(DONE, None)
    if stopped:
        return Step(kind(record), stopped)
    if not measured(record):
        return Step(DONE, None)
    step = _after_build(record, list(worktree))
    if _single_stage(record):
        # One run: its only stage implements, gates itself and ships, so a run that gated and left
        # its commits behind is finished rather than waiting on a review of itself.
        return Step(DONE, step.stall)
    if step.stall:
        return step
    following = _next_stage(record)
    if following >= len(record["stages"]):
        return Step(DONE, None)
    return Step(kind({**record, "stage": following}), None, following)


def moved(record: Dict[str, Any], step: Step) -> Dict[str, Any]:
    """The record a step leaves behind: the stage it is in now, its rounds, and why it stalled."""
    stages = _copy(record["stages"])
    out = {**record, "stages": stages}
    index = record["stage"]
    if index < len(stages):
        entry = stages[index]
        entry["state"] = FAILED if step.stall else FINISHED
        current = _current(entry)
        if current is not None:
            current["stop"] = step.stall
    target = step.index if step.index is not None else _index_of_kind(stages, step.stage, index)
    if target == index:
        return out
    if target >= len(stages):
        return {**out, "stage": target}
    # Every stage the task passed over is done: a gate stage has no run of its own — the host's gate
    # answers it — so a task that moves from its build to its review leaves it finished, not to come.
    for passed in range(index + 1, min(target, len(stages))):
        stages[passed]["state"] = FINISHED
        stages[passed]["rounds"] = stages[passed]["rounds"] or [new_round()]
    following = stages[target]
    if following["rounds"]:
        # A loop's second pass: the stage keeps the round it ran before, and this one goes beside it.
        following["rounds"].append(new_round())
    else:
        following["rounds"] = [new_round()]
    following["state"] = CURRENT
    return {**out, "stage": target, "round": len(following["rounds"])}


def _copy(stages: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """The stages, and every round in them, copied: a write never edits the record it was given."""
    return [
        {
            **stage,
            "steps": list(stage.get("steps") or []),
            "rounds": [dict(one) for one in stage.get("rounds") or []],
        }
        for stage in stages
    ]


def _next_stage(record: Dict[str, Any]) -> Optional[int]:
    """The stage a finished run hands over to: the next one that runs.

    A stage whose check the host answers posts no run of its own — the run before it ends by calling
    the gate — so the task passes it and lands on the stage after it. A workflow whose stages have
    all run answers the stage past its last one, which is ``done``.
    """
    kinds = _kinds(record["stages"])
    for index in range(record["stage"] + 1, len(kinds)):
        if kinds[index] != GATE_CHECK:
            return index
    return len(kinds)


def _index_of_kind(stages: Sequence[Dict[str, Any]], wanted: str, start: int) -> int:
    """The first stage at or after ``start`` judged as ``wanted``, else past the last one."""
    if wanted == DONE:
        return len(stages)
    kinds = _kinds(stages)
    for index in range(max(start, 0), len(stages)):
        if kinds[index] == wanted:
            return index
    return len(stages)


def gated(record: Dict[str, Any], commands: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    """The record once the current stage's run has run its gate, keeping each command's exit code."""
    stages = _copy(record["stages"])
    index = record["stage"]
    if index < len(stages):
        current = _current(stages[index])
        if current is not None:
            current["gate"] = {"commands": [dict(one) for one in commands]}
    return {**record, "stages": stages}


def failed(record: Dict[str, Any], why: str) -> Dict[str, Any]:
    """The record of a shipping run that ended without a pull request: it stopped, and says why.

    The entry the run was in is the last one that has a round: a task already moved past its last
    stage still has to say which stage failed.
    """
    stages = _copy(record["stages"])
    index = record["stage"]
    if index >= len(stages):
        index = next(
            (one for one in range(len(stages) - 1, -1, -1) if stages[one]["rounds"]), index
        )
    if index < len(stages):
        entry = stages[index]
        entry["state"] = FAILED
        current = _current(entry)
        if current is not None:
            current["stop"] = why
    return {**record, "stages": stages}


def gate_verdict(record: Optional[Dict[str, Any]]) -> Optional[str]:
    """Why the current stage's gate doesn't pass, or ``None`` when it ran and every command exited
    zero.

    The one reading of the gate's answer, so the tool and the rule that ends a stage can't disagree
    about whether a task is clear to go on.
    """
    answer = gate_of(record) or {}
    commands = [one for one in answer.get("commands") or [] if isinstance(one, dict)]
    if not commands:
        return NO_GATE
    broken = next((one for one in commands if one.get("code") != 0), None)
    if broken is None:
        return None
    named = broken.get("command") or ""
    if broken.get("repo"):
        named = f"{broken['repo']}: {named}"
    return FAILED_GATE.format(command=named, code=broken.get("code"))


def reason(record: Optional[Dict[str, Any]]) -> Optional[str]:
    """Why the stage the task is in stopped, or ``None`` while it is going.

    A task past its last stage answers with the entry that ran last, which is where a stop is written
    once a shipping run has moved the task to its end.
    """
    return (_current(_judged(record)) or {}).get("stop") or None


def _judged(record: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """The entry a run of this task last worked: its stage, or the last one that ran."""
    if not record:
        return None
    stages = record["stages"]
    index = record["stage"]
    if index < len(stages):
        return stages[index]
    return next(
        (stages[one] for one in range(len(stages) - 1, -1, -1) if stages[one]["rounds"]), None
    )


def gate_of(record: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """The gate the current stage's current round answered, or ``None`` when it hasn't run yet."""
    current = _current(_entry_of(record))
    gate = (current or {}).get("gate")
    return gate if isinstance(gate, dict) else None


def build_skill(record: Optional[Dict[str, Any]]) -> Optional[str]:
    """The skill the task's first stage builds by, when its workflow names one."""
    stages = (record or {}).get("stages") or []
    if not stages or stages[0].get("ships"):
        return None
    steps = stages[0].get("steps") or []
    return steps[0] if steps else None


def critique_skills(record: Optional[Dict[str, Any]]) -> List[str]:
    """The skills the shipping stage reviews by, in the order the workflow applies them."""
    stages = (record or {}).get("stages") or []
    ship = shipping(list(stages))
    return list(stages[ship].get("steps") or []) if ship is not None else []


def steps_of(record: Optional[Dict[str, Any]]) -> List[str]:
    """Every skill a staged task applies, each once, in the order its workflow applies them."""
    return workflows.steps_of((record or {}).get("stages") or [])


def _entry_of(record: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not record:
        return None
    index = record["stage"]
    stages = record["stages"]
    return stages[index] if index < len(stages) else None


def _current(entry: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """The round a stage is on now: its last one, or ``None`` for a stage nothing has run."""
    rounds = (entry or {}).get("rounds") or []
    return rounds[-1] if rounds else None


def _after_build(record: Dict[str, Any], worktree: List[Dict[str, Any]]) -> Step:
    why = gate_verdict(record)
    if why is not None:
        return Step(GATE_CHECK, why)
    if any(one.get("changed") for one in worktree):
        return Step(GATE_CHECK, UNCOMMITTED)
    if not any(one.get("ahead") for one in worktree):
        return Step(GATE_CHECK, NO_COMMITS)
    return Step(CRITIQUE, None, _next_stage(record))
