"""A staged AFK task's record: the workflow it runs, the stage it is in, and what each stage did.

A project picks a workflow and its tasks run it stage by stage (``workflows.py``). What this module
reads and writes is the task's own snapshot of that workflow: the workflow as it stood when the task
started, the stage it is in, the round, and one entry per stage holding its state and its rounds. So
editing or deleting a library entry cannot rewrite what a finished task says it ran — and a session's
own record, not the project's hold, which is released when a run ends, still says how the task got
there (ADR 0018).

A round also keeps what its run did: the shell commands it executed and what each review skill
reported (``ran``, ``reported``), which ``stage_commands`` and ``stage_findings`` read back — with
the gate's own exit codes merged onto the commands the host checked — so one read draws the details
sheet.

The machine here is the host's, and it reads the snapshot rather than a fixed list of steps
(ADR 0020): a stage with steps posts one run of the task's session, a stage with a check and no steps
is a checkpoint the host answers from the run before it, and a stage with neither is passed over
without a run. A run's end is judged by its checkpoint and the worktree, a failed checkpoint inside a
loop sends the task back for another round up to the loop's cap, and only the shipping stage may open
the pull request. What the tools name a task by — ``build``, ``gate``, ``critique``, ``done`` — is
still read off a stage's position (``kind``), so a record can change shape without the tools changing
what they say.
"""

from __future__ import annotations

from typing import Any, Dict, List, NamedTuple, Optional, Sequence, Set

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
FAILED_GATE = "The gate failed: {failed}."
UNCOMMITTED = "The build left uncommitted changes in the worktree."
NO_COMMITS = "The build left no commits in the worktree."
# A loop whose rounds are spent: the checkpoint is still failing, so the task waits for the user with
# the command that failed named, rather than repeating itself for ever.
LOOP_EXHAUSTED = "The loop ran out of rounds ({cap}) and the gate still failed: {failed}."

# What a stage keeps of what its run did: the most recent commands it executed, each line truncated,
# and how many findings each review skill reported, each capped. A sheet lists them, so a run that
# went to the shell a hundred times still leaves a record that reads.
COMMAND_CAP = 50
COMMAND_CHARS = 300
FINDING_CAP = 50
TITLE_CHARS = 200
DETAIL_CHARS = 2000


class Step(NamedTuple):
    """Where a staged task goes when a run of it ends: the step it lands on, why it stalled instead
    (``None`` when it didn't) and which stage of the workflow that is.

    ``index`` is the stage the task moves to — the next one that runs, past the stages the host
    answers itself — so a workflow of any length hands over to its own next stage rather than to a
    step's name. It is ``None`` for a step that isn't a move (a stall, or a caller's own guess), and
    then the move is worked out from ``stage``.

    ``retry`` is a loop's next round: the failure the checkpoint gave, which that round's brief is
    told, so a build that repeats knows the command it has to fix.
    """

    stage: str
    stall: Optional[str]
    index: Optional[int] = None
    retry: Optional[str] = None


def new_round() -> Dict[str, Any]:
    """One round of a stage as it starts: the run working it, what it ran, its gate and findings."""
    return {"run_id": None, "commands": [], "gate": None, "findings": [], "stop": None, "retry": None}


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
        "commands": [
            one
            for one in (
                _command(item) for item in value.get("commands") or [] if isinstance(item, dict)
            )
            if one["command"]
        ],
        "gate": value.get("gate") if isinstance(value.get("gate"), dict) else None,
        "findings": [
            one for one in (_reported(item) for item in value.get("findings") or []) if one
        ],
        "stop": text(value.get("stop")),
        "retry": text(value.get("retry")),
    }


def _command(value: Dict[str, Any]) -> Dict[str, Any]:
    """One command a stage ran: the line, the repo it ran in and, for the gate's, its exit code."""
    code = value.get("code")
    return {
        "command": text(value.get("command")) or "",
        "repo": text(value.get("repo")),
        "code": code if isinstance(code, int) and not isinstance(code, bool) else None,
    }


def _reported(value: Any) -> Optional[Dict[str, Any]]:
    """What one review skill reported: its name and its findings, each a title and an optional detail.

    A skill that reported nothing is kept with an empty list, since a sheet drawing ``0`` beside it is
    a different thing from a skill it has never heard of.
    """
    if not isinstance(value, dict) or not text(value.get("skill")):
        return None
    return {
        "skill": text(value.get("skill")),
        "findings": [one for one in (_finding(item) for item in value.get("findings") or []) if one],
    }


def _finding(value: Any) -> Optional[Dict[str, Any]]:
    """One finding: a title, and the detail the review gave it where it gave one."""
    if isinstance(value, str):
        title, detail = value, None
    elif isinstance(value, dict):
        title, detail = value.get("title"), value.get("detail")
    else:
        return None
    title = text(title)
    if not title:
        return None
    return {"title": title[:TITLE_CHARS], "detail": (text(detail) or "")[:DETAIL_CHARS] or None}


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
    """Every stage's step, in order: what each of them is judged as.

    A stage before the shipping one builds, one whose check is the gate and which names no steps of
    its own is the gate step, the shipping stage is the review, and anything after it has shipped.
    """
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
    return single_stage(record) and gate_of(record) is None


def measured(record: Optional[Dict[str, Any]]) -> bool:
    """Whether a run of this stage is judged at its end by its gate and the worktree.

    Every stage before the shipping one is — that is where the build is checked — and so is One
    run's single stage, which gates itself before it ships. The shipping stage's own run is not, nor
    is any stage after it: a review ended when it shipped, and the pull request is what judges it, and
    a wrap-up has nothing to be gated for.
    """
    if not record:
        return False
    return kind(record) in (BUILD, GATE_CHECK) or single_stage(record)


def single_stage(record: Dict[str, Any]) -> bool:
    """Whether the task's whole workflow is the one stage it is in, and that stage ships.

    One run is that workflow: nothing before its stage to build and nothing after it to review, so
    its run is judged at its own end. It is read from the stages rather than from the workflow's
    name, since a workflow of one shipping stage is the same shape however it was made — and a
    shipping stage with a stage after it is not one run, since that stage would never run.
    """
    return ships(record) and record["stage"] == 0 and len(record["stages"]) == 1


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


def posts(stages: Sequence[Dict[str, Any]], index: int) -> bool:
    """Whether the stage at ``index`` posts a run of the task's session.

    A checkpoint posts none: its check is the host's to answer, from the run before it (ADR 0020).
    A stage after the shipping one posts one only when it names steps — a wrap-up with no skill has
    nothing to do, so the task passes over it. Every stage up to and including the shipping one posts
    one, steps or no steps, because its built-in brief is what makes a preset work on a fresh project:
    a build with no skill still implements, and a review with no skill still reviews and ships.
    """
    if not 0 <= index < len(stages):
        return False
    step = _kinds(stages)[index]
    if step == GATE_CHECK:
        return False
    if step == DONE:
        return bool(stages[index].get("steps"))
    return True


def posts_now(record: Optional[Dict[str, Any]]) -> bool:
    """Whether the stage a task is in posts a run, which is what the sweep and the hook start."""
    if not record:
        return False
    return posts(record["stages"], record["stage"])


def stage_name(record: Optional[Dict[str, Any]]) -> Optional[str]:
    """The name of the stage a task is in, or ``None`` once it is past its workflow's last one."""
    entry = _entry_of(record)
    return entry["name"] if entry else None


def shipping_name(record: Optional[Dict[str, Any]]) -> Optional[str]:
    """The name of the stage that may open the pull request, or ``None`` for a record without one."""
    stages = (record or {}).get("stages") or []
    index = shipping(list(stages))
    return stages[index]["name"] if index is not None else None


def retry(record: Optional[Dict[str, Any]]) -> Optional[str]:
    """Why the round before this one failed, as a loop's next round is told it, or ``None``."""
    return (_current(_entry_of(record)) or {}).get("retry") or None


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

    A checkpoint that failed inside a loop sends the task back to the stage the loop starts at, as
    another round told what failed, until the loop's cap is spent: then it stalls naming the command,
    and nothing after the loop starts. A run whose stage nothing measures — the shipping stage's, or
    one after it — has finished, and hands over to the next stage that posts a run.
    """
    if record is None or record["stage"] >= len(record["stages"]):
        return Step(DONE, None)
    if stopped:
        return Step(kind(record), stopped)
    if not measured(record):
        return _forward(record)
    why = gate_verdict(record)
    if why is not None:
        again = _round_again(record, why)
        if again is not None:
            return again
    return _after(record, why, list(worktree))


def _after(record: Dict[str, Any], why: Optional[str], worktree: List[Dict[str, Any]]) -> Step:
    """Where a measured stage's finished run goes, once its checkpoint and its tree are read."""
    if why is None:
        if any(one.get("changed") for one in worktree):
            why = UNCOMMITTED
        elif not any(one.get("ahead") for one in worktree):
            why = NO_COMMITS
    if why is not None:
        return Step(GATE_CHECK, why)
    if single_stage(record):
        # One run: its only stage implements, gates itself and ships, so a run that gated and left
        # its commits behind is finished rather than waiting on a review of itself.
        return Step(DONE, None)
    return _forward(record)


def _forward(record: Dict[str, Any]) -> Step:
    """The next stage of the workflow that posts a run, or the task's own end."""
    following = _next_stage(record)
    if following >= len(record["stages"]):
        return Step(DONE, None)
    return Step(kind({**record, "stage": following}), None, following)


def _round_again(record: Dict[str, Any], why: str) -> Optional[Step]:
    """The loop's answer to a failed checkpoint: its next round, its last one, or no loop at all.

    ``None`` is a checkpoint no loop covers, which is a stall the caller works out from ``why``. The
    rounds a loop has had are the rounds of the stage its span starts at, so a cap of three is three
    runs of that stage however many stages the span holds.
    """
    found = _loop_for(record)
    if found is None:
        return None
    start, cap = found.start, found.cap
    if not posts(record["stages"], start):
        # A loop whose span starts at a checkpoint has nothing of its own to repeat.
        return None
    if len(record["stages"][start]["rounds"]) >= cap:
        failed = failing_command(record) or why
        return Step(GATE_CHECK, LOOP_EXHAUSTED.format(cap=cap, failed=failed))
    return Step(
        kind({**record, "stage": start}), None, start, retry=failing_command(record) or why
    )


class Loop(NamedTuple):
    """A workflow's loop as the rule reads it: the stage its span starts at, and its cap."""

    start: int
    cap: int


def _loop_for(record: Dict[str, Any]) -> Optional[Loop]:
    """The loop a stage's failed checkpoint belongs to: the stage its span starts at, and its cap.

    The nearest loop at or after the stage the task is in, whose span reaches back to it — so a
    workflow with a loop around its build and test, and a second one around its review, each read
    their own.
    """
    index = record["stage"]
    for at in range(index, len(record["stages"])):
        loop = record["stages"][at].get("loop") or {}
        start = _index_of_name(record["stages"], loop.get("from"))
        cap = loop.get("cap")
        if start is None or start > index or not isinstance(cap, int) or cap < 1:
            continue
        return Loop(start, cap)
    return None


def _index_of_name(stages: Sequence[Dict[str, Any]], name: Any) -> Optional[int]:
    return next((index for index, stage in enumerate(stages) if stage.get("name") == name), None)


def moved(record: Dict[str, Any], step: Step) -> Dict[str, Any]:
    """The record a step leaves behind: the stage it is in now, its rounds, and why it stalled."""
    stages = _copy(record["stages"])
    out = {**record, "stages": stages}
    index = record["stage"]
    if step.retry is not None:
        return _again(out, step)
    if index < len(stages):
        entry = stages[index]
        entry["state"] = FAILED if step.stall else FINISHED
        current = _current(entry)
        if current is not None:
            current["stop"] = step.stall
    target = step.index if step.index is not None else _index_of_kind(stages, step.stage, index)
    if target == index:
        return out
    # Every stage the task passed over is done: a checkpoint has been answered by the host from the
    # run before it, and a stage with nothing to do has nothing left for it to do.
    for passed in range(index + 1, min(target, len(stages))):
        stages[passed]["state"] = FINISHED
    if target >= len(stages):
        return {**out, "stage": target}
    following = stages[target]
    if following["rounds"]:
        # A loop's second pass: the stage keeps the round it ran before, and this one goes beside it.
        following["rounds"].append(new_round())
    else:
        following["rounds"] = [new_round()]
    following["state"] = CURRENT
    return {**out, "stage": target, "round": len(following["rounds"])}


def _again(record: Dict[str, Any], step: Step) -> Dict[str, Any]:
    """The record a loop's next round starts with: its span's first stage goes again.

    The failure the checkpoint gave is written on the round it starts rather than on the stage as a
    stop, because the task is still going: a build repeating itself after a failed test is work, not
    a wait for the user. Every stage the span passed over goes back to what is still to come, and
    keeps the rounds it ran — they are what the task says it did.
    """
    stages = record["stages"]
    index = record["stage"]
    target = step.index if step.index is not None else index
    target = len(stages) - 1 if target >= len(stages) else max(target, 0)
    entry = stages[target]
    entry["rounds"].append({**new_round(), "retry": step.retry})
    entry["state"] = CURRENT
    for passed in range(target + 1, min(index + 1, len(stages))):
        if stages[passed]["rounds"]:
            stages[passed]["state"] = TODO
    return {**record, "stage": target, "round": len(entry["rounds"])}


def _copy(stages: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """The stages, and every round in them, copied: a write never edits the record it was given.

    A round's commands and findings are copied too: a command appended to what this hands back, or a
    report replaced in it, must not land on the record the caller still holds.
    """
    return [
        {
            **stage,
            "steps": list(stage.get("steps") or []),
            "rounds": [_round_copy(one) for one in stage.get("rounds") or []],
        }
        for stage in stages
    ]


def _round_copy(value: Dict[str, Any]) -> Dict[str, Any]:
    """One round of the copy: its own lists, and the gate's commands in their own dicts."""
    return {
        **value,
        "commands": [dict(one) for one in value.get("commands") or [] if isinstance(one, dict)],
        "gate": (
            {
                **value["gate"],
                "commands": [
                    dict(one)
                    for one in value["gate"].get("commands") or []
                    if isinstance(one, dict)
                ],
            }
            if isinstance(value.get("gate"), dict)
            else value.get("gate")
        ),
        "findings": [
            {**one, "findings": [dict(item) for item in one.get("findings") or []]}
            for one in value.get("findings") or []
            if isinstance(one, dict)
        ],
    }


def _next_stage(record: Dict[str, Any]) -> Optional[int]:
    """The stage a finished run hands over to: the next one that posts a run.

    A checkpoint posts nothing — the host answers it from the run before it — and a stage with
    nothing to do has nothing to start, so the task passes both and lands on the stage after them. A
    workflow whose stages have all run answers the stage past its last one, which is ``done``.
    """
    for index in range(record["stage"] + 1, len(record["stages"])):
        if posts(record["stages"], index):
            return index
    return len(record["stages"])


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


def ran(record: Dict[str, Any], line: str, repo: Optional[str] = None) -> Dict[str, Any]:
    """The record once the stage in hand has run one more shell command, the line only.

    The run's own commands are what the sheet lists beside the gate's: a run that linted, typechecked
    and tested in its own shell says so, whichever one the host later checked. Only the most recent
    ``COMMAND_CAP`` of a stage's are kept, across its rounds, since a loop's third round would
    otherwise carry every earlier one; a line longer than ``COMMAND_CHARS`` is cut, because a
    heredoc is not a record.
    """
    if not record or not isinstance(line, str) or not line.strip():
        return record
    stages = _copy(record["stages"])
    index = record["stage"]
    if index >= len(stages):
        return record
    current = _current(stages[index])
    if current is None:
        return record
    current["commands"].append(
        {"command": line.strip()[:COMMAND_CHARS], "repo": text(repo), "code": None}
    )
    _trimmed(stages[index])
    return {**record, "stages": stages}


def _trimmed(entry: Dict[str, Any]) -> None:
    """Drops a stage's oldest commands until it holds the most recent ``COMMAND_CAP``, in place."""
    rounds = entry.get("rounds") or []
    held = sum(len(one.get("commands") or []) for one in rounds)
    for one in rounds:
        if held <= COMMAND_CAP:
            return
        commands = one.get("commands") or []
        dropped = min(len(commands), held - COMMAND_CAP)
        one["commands"] = commands[dropped:]
        held -= dropped


def reported(record: Dict[str, Any], skill: str, findings: Sequence[Any]) -> Dict[str, Any]:
    """The record once the stage in hand says what one review skill found, capped.

    A skill's report replaces the one before it, since a review that reports twice has had its second
    say — the same way the gate's last answer is the one the run is judged by. An empty list is a
    report too: a skill that found nothing is on the record with ``0``, not missing from it.
    """
    if not record or not isinstance(skill, str) or not skill.strip():
        return record
    stages = _copy(record["stages"])
    index = record["stage"]
    if index >= len(stages):
        return record
    current = _current(stages[index])
    if current is None:
        return record
    kept = [one for one in (_finding(item) for item in findings or []) if one][:FINDING_CAP]
    entry = {"skill": skill.strip(), "findings": kept}
    says: List[Dict[str, Any]] = []
    placed = False
    for one in current["findings"]:
        if one.get("skill") != entry["skill"]:
            says.append(one)
        elif not placed:
            says.append(entry)
            placed = True
    current["findings"] = says if placed else [*says, entry]
    return {**record, "stages": stages}


def stage_commands(
    record: Optional[Dict[str, Any]], index: Optional[int] = None
) -> List[Dict[str, Any]]:
    """Every command a stage ran, in order, each with the exit code the host read where it checked it.

    The run's own commands and the gate's are one list: a command the gate ran carries that call's
    exit code and ``checked``, so a sheet can mark what the host verified and stand it apart from what
    the run ran for itself. A gate command the run never executed in its own shell (or that fell off
    the cap) is on the list too, since the host ran it either way. Commands are read across the
    stage's rounds, each marked with the round it ran in.
    """
    entry = _entry_at(record, index)
    if entry is None:
        return []
    found: List[Dict[str, Any]] = []
    for number, round_ in enumerate(entry["rounds"], start=1):
        checked = [
            one for one in ((round_.get("gate") or {}).get("commands") or []) if isinstance(one, dict)
        ]
        matched: Set[int] = set()
        for one in round_.get("commands") or []:
            at = _twin(one, checked, matched)
            answer = checked[at] if at is not None else {}
            found.append(_row(one, answer, at is not None, number))
        for at, answer in enumerate(checked):
            if at in matched or not isinstance(answer.get("command"), str):
                continue
            found.append(_row(answer, answer, True, number))
    return found


def _row(
    one: Dict[str, Any], answer: Dict[str, Any], checked: bool, number: int
) -> Dict[str, Any]:
    """One line a stage ran, as the sheet reads it: what ran, where, and what the host read from it."""
    return {
        "command": one.get("command") or "",
        "repo": one.get("repo") or answer.get("repo"),
        "code": answer.get("code"),
        "checked": checked,
        "round": number,
    }


def _twin(
    one: Dict[str, Any], checked: Sequence[Dict[str, Any]], matched: Set[int]
) -> Optional[int]:
    """The gate's answer to a command the run executed itself, where the gate ran the same line."""
    for at, answer in enumerate(checked):
        if at in matched or answer.get("command") != one.get("command"):
            continue
        # A gate command naming a repo is that repo's own: the same line in another one is another
        # command, where the run's own record knows which repo it was in.
        if answer.get("repo") and one.get("repo") and answer["repo"] != one["repo"]:
            continue
        matched.add(at)
        return at
    return None


def stage_findings(
    record: Optional[Dict[str, Any]], index: Optional[int] = None
) -> List[Dict[str, Any]]:
    """What each review skill reported in a stage, each skill once, with nothing for one that found none.

    Read across the stage's rounds: a skill that reported again in a later round has had its second
    say, and the skills keep the order they first reported in.
    """
    entry = _entry_at(record, index)
    if entry is None:
        return []
    found: Dict[str, Dict[str, Any]] = {}
    for round_ in entry["rounds"]:
        for one in round_.get("findings") or []:
            if isinstance(one, dict) and one.get("skill"):
                found[one["skill"]] = one
    return list(found.values())


def _entry_at(record: Optional[Dict[str, Any]], index: Optional[int]) -> Optional[Dict[str, Any]]:
    """The stage a read was asked about: the one in hand, or the one at ``index``."""
    if not record:
        return None
    stages = record.get("stages") or []
    at = record.get("stage") if index is None else index
    if not isinstance(at, int) or not 0 <= at < len(stages):
        return None
    return stages[at]


def gate_verdict(record: Optional[Dict[str, Any]]) -> Optional[str]:
    """Why the current stage's gate doesn't pass, or ``None`` when it ran and every command exited
    zero.

    The one reading of the gate's answer, so the tool and the rule that ends a stage can't disagree
    about whether a task is clear to go on.
    """
    broken = _broken(record)
    if broken is not None:
        return FAILED_GATE.format(failed=_named(broken))
    answered = [one for one in (gate_of(record) or {}).get("commands") or [] if isinstance(one, dict)]
    return None if answered else NO_GATE


def failing_command(record: Optional[Dict[str, Any]]) -> Optional[str]:
    """The command a failed gate broke on, as a sentence names it: ``pnpm test exited 1``.

    Its repo is part of its name where it ran in one of several, since the same line in two repos is
    two different commands. ``None`` when the gate's answer holds no command to name.
    """
    broken = _broken(record)
    return _named(broken) if broken is not None else None


def _broken(record: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """The first command of the stage's gate that exited non-zero, or ``None`` when none did.

    The one place that says which failure a gate broke on, so the sentence a stall carries and the
    retry a loop's next round is told always name the same command.
    """
    answer = gate_of(record) or {}
    return next(
        (
            one
            for one in answer.get("commands") or []
            if isinstance(one, dict) and one.get("code") != 0
        ),
        None,
    )


def _named(broken: Dict[str, Any]) -> str:
    """A gate command as a sentence names it, with the repo it ran in where the gate named one."""
    named = broken.get("command") or ""
    if broken.get("repo"):
        named = f"{broken['repo']}: {named}"
    return f"{named} exited {broken.get('code')}"


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


def stage_steps(record: Optional[Dict[str, Any]]) -> List[str]:
    """The skills the stage a task is in applies, in the order it applies them."""
    return list((_entry_of(record) or {}).get("steps") or [])


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
