"""AFK: a project's switch for working its own tasks, the sweep that claims one, and its state.

The switch answers one question — is this project left to work its own tasks — and it lives in the
plugin's store rather than on the device that flipped it, because the sweep that works those tasks
runs on the host with the app closed. So the state is read back from the host, per project, and a
project's switch never touches another's.

The sweep reads the project's frontier from GitHub and takes the oldest ready tasks, as many as the
project's pick count allows: each assigned to the host's account and marked with Gots's claim label,
created on the repository the first time it's used (ADR 0012). A hold is a row of its own, so a
project may have several tasks in flight, and a pass fills every free place, oldest first — the
starts themselves are serialized, since each makes a worktree on the same repository. A GitHub
refusal stops the pass, leaves the switch on and records the reason the app's sheet shows, rather
than asking again in a loop. Lowering the count abandons nothing: a hold leaves when its work is in
review, when the user closes its session, or when its start failed.

Each task it takes is worked in a session of its own, made the way the app's workspace route makes
one (`sessions.ensure`: its own worktree, branch and row, in Auto), and the chat record that makes
that session appear and open in the app is written here (ADR 0013) — the Code list hides a session
nothing was sent in, and the app has no conversation for one it didn't make. The run then starts
from this plugin: `prompt_builder.afk_prompt` is its instructions — AFK's fixed points, then the
project's Prompt, which is how its work is carried out and is read off the project's own row here so
a task claimed with the app closed is still told it (ADR 0027) — and its input is the issue itself,
its title, its description verbatim and the link, so what the change is judged against is in front of
the agent rather than something it fetches. The title and description ride in the input and not the
instructions, so the prompt is the same tokens every turn. Every run carries the model its session
is pinned to: `_starting_pin` reads the profile's main model for a session that has no record yet —
the one its record is then published with — and `chats.pin` reads its own record's pick for every
run after that, so changing the Default model never moves a session already under way.

A project that named no workflow works its task in one run: nothing is snapshotted, so the session
records no pipeline and its run is the task's whole work. One that named a workflow runs its stages
instead, under the snapshot of it written as the task starts (`_snapshot`, ADR 0027). A stage's run
can leave subagents still writing the worktree its gate reads, so a stage moves on only once its run
has ended and every subagent that run started has ended too — the gate's end is held from the store's
own reading and looked at again while it waits (`_held_for_subagents`, `settle_held`, ADR 0038).

A project that can't be left to work says why instead of offering a switch: it has no GitHub
repository to read tasks from, the host has no GitHub account to read or claim one with, or the
project has been put away. The reason is the host's own answer rather than the app's guess, because
the host is what would do the work — and turning a project on is refused with that reason, so nothing
is ever left half on.

"""

from __future__ import annotations

import asyncio
import json
import logging
import sqlite3
import time
import uuid
from functools import cached_property
from pathlib import Path
from typing import Any, Dict, Iterable, List, NamedTuple, Optional, Set, Tuple

from . import (
    chats,
    delegation,
    events,
    github,
    host_model,
    pipeline,
    prompt_builder,
    sessions,
    ship,
    tasks,
    usage,
    workflows,
)
from .profile_scope import profile_scope
from .store import connect, db_path, get_setting, get_settings, put_setting

logger = logging.getLogger(__name__)

NO_REPOSITORY = "This project has no repository."
NO_GITHUB = "No GitHub account on the server."
# The same words the plugin already refuses an archived project a turn with (sessions._blocked).
ARCHIVED = "This project is archived."
# A skill the project picked that its bot no longer has: the sweep records it and claims nothing.
MISSING_SKILL = (
    'The skill "{name}" isn\'t one this bot has any more, so no task is claimed. '
    "Pick another in the project's AFK pop-up."
)
NO_PULL_REQUEST = "The stage that opens the pull request ended without one."
# A stage of the workflow couldn't be started: nothing is working the task from here.
STAGE_FAILED = 'The "{name}" stage couldn\'t start.'

# How often a project left on is swept for work. A GitHub refusal ends that sweep and the next one
# waits for its turn rather than asking again at once.
SWEEP_SECONDS = 180
HELD = ("repo", "number", "title", "url", "created_at")
# How many tasks a project holds at once when it names no count, and the most it may ask for: one
# place per task, which is what the user means by "how many at once" when they look at the list
# (ADR 0025). The floor is its own number: a stored count of zero reads as the fewest it can be,
# which is a different thing from a count nobody set.
DEFAULT_PICK_COUNT = 1
LOWEST_PICK_COUNT = 1
MAX_PICK_COUNT = 5
# The bot's own pick budget: how many tasks the projects of one bot hold together, the range it may
# be set to, and the settings row it lives under (ADR 0042). One number over the projects, because
# eight projects at a count of one are eight sessions at once and nothing else says "enough".
DEFAULT_PICK_BUDGET = 5
LOWEST_PICK_BUDGET = 1
HIGHEST_PICK_BUDGET = 10
PICK_BUDGET_KEY = "afk_pick_budget"
# Why a project claims nothing when the bot already holds as many tasks as its budget allows: the
# budget is the bot's, so the sheet has to say so rather than blame the project's own count, and it
# names both numbers so "full" can't be read as a number the user never set (ADR 0042).
PICK_BUDGET_FULL = (
    "This bot's pick budget is full ({held} of {budget} held), so no task is claimed. "
    "Let one finish, or raise the budget in the bot's Coding tab."
)
# The bot's usage threshold: the used share of its account at which AFK stops picking tasks up, the
# range it may be set to, and the settings row it lives under (ADR 0026). One number for the bot,
# because the account is one, and absent means off — a bot with no threshold never reads the account.
LOWEST_USAGE_THRESHOLD = 50
HIGHEST_USAGE_THRESHOLD = 100
USAGE_THRESHOLD_KEY = "afk_usage_threshold"
# Why a project claims nothing when its account is at or over the bot's threshold: it names the
# window that decided, that window's own percent and the number the user set, so the hold reads as a
# figure to wait on rather than as a failure (ADR 0026). The switch stays on, so the sheet shows it.
USAGE_HELD = (
    "The account's {window} window is at {percent}% used, at or above this bot's {threshold}% usage "
    "threshold, so no task is claimed. Wait for it to reset, or raise the threshold in the bot's "
    "Coding tab."
)
# A window's label as the refusal says it: core names every window, and one that names nothing is
# still one the account answered with.
UNNAMED_WINDOW = "usage"
# How long a claim may sit with nothing running it before the app is told it stalled. A start makes
# the session's worktrees first, which can take a while on a big repository, so a claim just taken is
# given that much room; a run that ends says why at once. Every hold has its own clock, so a task
# claimed after an older one was not made to look stalled by its age.
STALL_SECONDS = 300
DEFAULT_STALL = "AFK stopped before the task was finished."
FAILED_RUN = "The run failed."
INTERRUPTED_RUN = "The run was interrupted."
# How long the sweep waits while a stage is held for the subagents its run started. The hold is
# settled from the plugin's own store, not GitHub, so it is looked at on a shorter clock than a
# sweep: a gate must move on as soon as the tree it reads has stopped being written.
HOLD_SECONDS = 5.0


class StageHold(NamedTuple):
    """A stage whose run ended while the subagents it started still work: its home, and its outcome."""

    home: Path
    outcome: sessions.Outcome


_loop: Optional[asyncio.AbstractEventLoop] = None
_event: Optional["asyncio.Event"] = None
# In memory, like ``_loop``: a restart leaves the task where the stall clock finds it.
_held: Dict[str, StageHold] = {}


class Refused(Exception):
    """Turning a project on where it can't be left to work. Its reason is the message.

    Its own type, so the route refuses with the reason it was given and nothing else: an error from
    the store is a fault, not the project's answer, and must not reach the app as one.
    """


def reason(
    hermes_home: Path, folders: Iterable[Any], archived: bool = False
) -> Optional[str]:
    """Why this project can't be left to work, or None when it can.

    A project put away is never worked, so it is neither asked about its repositories nor the
    account. One whose checkouts point at no GitHub repository has no tasks to read at all; one with
    a repository needs the host's account to read the tracker and to claim a task on it.
    """
    if archived:
        return ARCHIVED
    if not tasks.repos_of(folders):
        return NO_REPOSITORY
    auth, _ = github.token(hermes_home)
    return None if auth else NO_GITHUB


def set_on(
    hermes_home: Path,
    project_id: str,
    folders: Iterable[Any],
    on: bool,
    archived: bool = False,
) -> Dict[str, Any]:
    """Turns the project's AFK on or off, answering the sheet's whole answer after the write.

    Turning it on is refused for a project that can't be left to work, the reason being the error's
    message: the app shows that where the switch would be, and nothing is written, so the host never
    holds an on it refused. A project turned on earlier keeps its switch when its reason comes back —
    turning it off is still the user's to do — so the on it answers is the row it holds.
    """
    why = reason(hermes_home, folders, archived)
    if on and why is not None:
        raise Refused(why)
    _write(hermes_home, project_id, on)
    if on:
        # Turning it on is a fresh intent: a refusal recorded before it isn't this switch's answer,
        # and the sweep is asked to look now rather than at the next tick.
        _clear_refusal(hermes_home, project_id)
        wake()
    return read(hermes_home, project_id, folders, archived)


def turn_off(hermes_home: Path, project_id: str) -> None:
    """Turns a project's AFK off: what archiving a project does to it (deleting one forgets it)."""
    _write(hermes_home, project_id, False)


def forget(hermes_home: Path, project_id: str) -> None:
    """Drops a project's switch: the project's record is gone, so there is nothing to leave off.

    Each hold's claim is given back first, best effort: a task left labelled and assigned with no
    project to work it would stay out of every future frontier forever (ADR 0012 — the frontier
    excludes an issue carrying either mark). A GitHub that can't answer only loses the attempt: the
    record is going away either way, and the repository's next sweep is what reads the task back.
    """
    auth, _ = github.token(hermes_home)
    if auth:
        for hold in _holds(hermes_home, project_id):
            if not hold.task:
                continue
            try:
                github.release_claim(
                    str(hold.task["repo"]), int(hold.task["number"]), tasks.CLAIM_LABEL, auth
                )
            except (github.GitHubError, KeyError, TypeError, ValueError):
                logger.warning(
                    "memento: couldn't release %s with its project", hold.task, exc_info=True
                )
    conn = connect(db_path(hermes_home))
    try:
        conn.execute("DELETE FROM project_afk WHERE project_id = ?", (project_id,))
        conn.execute("DELETE FROM holds WHERE project_id = ?", (project_id,))
    finally:
        conn.close()


def read(
    hermes_home: Path, project_id: str, folders: Iterable[Any], archived: bool = False
) -> Dict[str, Any]:
    """Everything the app's sheet shows: the switch and its reason, the tasks held, the last
    refusal, the workflow this project's work runs under, and the Prompt its runs are told.

    An archived project is turned off here if anything had left it on, and reads off whatever
    happens: it was put away, so its switch isn't a setting anything acts on. Writing it off rather
    than only masking it is what keeps a restore from resuming work no one asked for — a project
    archived where this plugin didn't do it (Hermes's own dashboard or CLI) still has its old row.
    """
    # The bot's own numbers, read once here: the budget it works within and the holds against it
    # belong to the answer for a project with a row and one without, so they come from the bot's
    # store rather than from the row `_row` reads (ADR 0042).
    bot = bot_read(hermes_home)
    found = _row(hermes_home, project_id) or {
        "on": False,
        "holds": [],
        "task": None,
        "refusal": None,
        "build_skill": None,
        "critique_skills": [],
        "workflow_id": None,
        "prompt": None,
        "pick_count": None,
        "prompt_id": None,
    }
    why = reason(hermes_home, folders, archived)
    on = found["on"]
    if on and why == ARCHIVED:
        turn_off(hermes_home, project_id)
        on = False
    holds = _hold_answers(hermes_home, found["holds"])
    # The oldest hold is the one the sheet's single Working row has always drawn, and an app that
    # knows nothing of picks keeps drawing exactly that.
    oldest = holds[0] if holds else {"stage": None, "stage_name": None}
    return {
        "on": on,
        "reason": why,
        "task": found["task"],
        # Every hold, oldest first: the sheet draws a Working row per task and counts them against
        # the count beside it (ADR 0025). Always a list, so a project holding nothing answers one.
        "holds": holds,
        "pick_count": _pick_count(found),
        "prompt_id": found["prompt_id"],
        "refusal": found["refusal"],
        "workflow": _workflow(hermes_home, project_id, found),
        # Empty and unset are the same thing — the bot's default method — so the app is handed the
        # words a run would read rather than a blank field.
        "prompt": found["prompt"] or prompt_builder.DEFAULT_PROMPT,
        # The bot's pick budget and the holds against it, answered on the project's read so the
        # sheet's one read draws the usage line beside the pick count (ADR 0042); and the bot's usage
        # threshold beside them, so one read still answers both of the numbers a pickup is judged by
        # (ADR 0026).
        "pick_budget": bot["pick_budget"],
        "holds_held": bot["holds_held"],
        "usage_threshold": bot["usage_threshold"],
        # The stage the oldest task it holds is in, for the sheet's own Working row (ADR 0018):
        # None for a project holding nothing, and for a task that isn't staged. Its own name comes
        # beside it, so a workflow's own words — "Migrate", "Verify" — are what the row says.
        "stage": oldest["stage"],
        "stage_name": oldest["stage_name"],
    }


def _hold_answers(hermes_home: Path, holds: Iterable["Hold"]) -> List[Dict[str, Any]]:
    """Every hold as the sheet reads it: the task, the stage its session is in, and why it stalled.

    The stage is read once for the whole list — a project may hold several tasks and the sheet is
    polled every few seconds — and the rule for one hold is unchanged: only a held task's stage is
    named, and it comes off its session's own record, which outlives the hold (the strip that reads
    a finished task is its own change, #319).
    """
    held = list(holds)
    stages = _stages(hermes_home, held)
    answers: List[Dict[str, Any]] = []
    for hold in held:
        staged = stages.get(hold.session_id) if hold.task and hold.session_id else None
        answers.append(
            {
                **{key: hold.task.get(key) for key in HELD},
                "stage": staged.step if staged is not None else None,
                "stage_name": staged.name if staged is not None else None,
                "stalled": hold.stalled,
            }
        )
    return answers


def _stages(hermes_home: Path, holds: Iterable["Hold"]) -> Dict[str, HeldStage]:
    """Each hold's stage, by session id, in one look at the session store rather than one per hold.

    A store that can't be read answers no stage at all: the sheet is worth more than the stage
    beside it, and a poll that failed to read would otherwise fail whole.
    """
    wanted = [hold.session_id for hold in holds if hold.task and hold.session_id]
    if not wanted:
        return {}
    try:
        stored = sessions.pipelines_of(db_path(hermes_home), wanted)
    except Exception:
        logger.debug("memento: couldn't read the stage of %s", wanted, exc_info=True)
        return {}
    stages: Dict[str, HeldStage] = {}
    for session_id, value in stored.items():
        record = pipeline.read(value)
        stages[session_id] = HeldStage(pipeline.stage(record), pipeline.stage_name(record))
    return stages


def _whole(value: Any) -> bool:
    """Whether a value is a whole number: a bool is a flag, never a count."""
    return isinstance(value, int) and not isinstance(value, bool)


def _range(name: str, lowest: int, highest: int) -> str:
    """The words a write outside a range is refused with, naming the field and both of its ends."""
    return f"{name} must be a whole number from {lowest} to {highest}."


def _pick_count(found: Dict[str, Any]) -> int:
    """How many tasks this project may hold at once: one unless it says, and never outside 1–5."""
    value = found.get("pick_count")
    if not _whole(value):
        return DEFAULT_PICK_COUNT
    return max(LOWEST_PICK_COUNT, min(MAX_PICK_COUNT, value))


def _budget_of(value: Any) -> int:
    """A stored budget as the bot works it: five where none is usable, clamped to 1–10."""
    if not _whole(value):
        return DEFAULT_PICK_BUDGET
    return max(LOWEST_PICK_BUDGET, min(HIGHEST_PICK_BUDGET, value))


def _threshold_of(value: Any) -> Optional[int]:
    """A stored threshold as the bot holds it: None where it is off or a row nothing could have set."""
    if not _whole(value) or not LOWEST_USAGE_THRESHOLD <= value <= HIGHEST_USAGE_THRESHOLD:
        return None
    return value


def pick_budget(hermes_home: Path) -> int:
    """How many tasks this bot's projects hold together: five unless it says, and never outside 1–10.

    The default and the range live here rather than in the stored value, so "nothing set" reads as
    five the way an empty Prompt reads as the bot's default method: an old store, a row somebody
    wrote by hand and a bot that never opened its Coding tab all answer the same number (ADR 0042).
    """
    return _budget_of(get_setting(db_path(hermes_home), PICK_BUDGET_KEY))


def usage_threshold(hermes_home: Path) -> Optional[int]:
    """The used share of its account at which this bot stops picking up, or None while it is off.

    Absent is off — a bot that never set one behaves exactly as it did before the setting existed,
    and never reads the account at all. A row somebody wrote by hand outside the range reads as off
    too rather than as a clamp: a threshold nobody asked for, silently held, would stop the bot's
    work (ADR 0026).
    """
    return _threshold_of(get_setting(db_path(hermes_home), USAGE_THRESHOLD_KEY))


def set_usage_threshold(hermes_home: Path, threshold: Optional[int]) -> None:
    """Records the bot's usage threshold, or takes it away (None is Off).

    Raising it or turning it off is worth a wake — the projects it was holding back may claim now —
    while lowering it frees nothing: a hold already taken stays until its own work is done, and every
    pickup after this one simply asks the tighter number (ADR 0026).
    """
    before = usage_threshold(hermes_home)
    put_setting(db_path(hermes_home), USAGE_THRESHOLD_KEY, threshold)
    if before is not None and (threshold is None or threshold > before):
        wake()


def holds_held(hermes_home: Path) -> int:
    """How many tasks this bot holds across all of its projects, stalled ones included.

    Rows are counted, whatever their stall: a hold is the bot's claimed work whether or not
    something is running it, so five stalled tasks are five places taken (ADR 0042). One read of
    the bot's own store, and never a question for GitHub.
    """
    conn = connect(db_path(hermes_home))
    try:
        row = conn.execute("SELECT COUNT(*) FROM holds").fetchone()
    finally:
        conn.close()
    return int(row[0]) if row else 0


def bot_read(hermes_home: Path) -> Dict[str, Any]:
    """The bot's own AFK numbers: the pick budget, how much of it is held, and the usage threshold.

    Answered by the bot-level route, and beside the project's own read so one read still carries every
    number, whatever project it is. Both settings come out of one look at the store, since the sheet
    this answers is polled.
    """
    stored = get_settings(db_path(hermes_home), (PICK_BUDGET_KEY, USAGE_THRESHOLD_KEY))
    return {
        "pick_budget": _budget_of(stored.get(PICK_BUDGET_KEY)),
        "holds_held": holds_held(hermes_home),
        "usage_threshold": _threshold_of(stored.get(USAGE_THRESHOLD_KEY)),
    }


def _legacy(found: Dict[str, Any]) -> bool:
    """Whether a project's row predates the picker and names its work by its old skill columns."""
    return found.get("workflow_id") is None and bool(
        found.get("build_skill") or found.get("critique_skills")
    )


def _chosen(
    hermes_home: Path, project_id: str, found: Dict[str, Any]
) -> Optional[Dict[str, Any]]:
    """The workflow this project has picked, or ``None`` where it has none to run.

    Read from the row the caller already holds, so answering a project costs one store open. A row
    that predates the picker is migrated to the workflow its build and critique skill columns
    described, and names it, so what the project does can't change shape under the user on upgrade.
    A pick the library no longer holds is no pick: its delete was refused where a project still named
    it, so only a hand edit strands one.
    """
    if _legacy(found):
        return workflows.migrate(
            hermes_home,
            project_id,
            found.get("build_skill"),
            found.get("critique_skills") or [],
        )
    return workflows.get(hermes_home, found.get("workflow_id"))


def _workflow(hermes_home: Path, project_id: str, found: Dict[str, Any]) -> Dict[str, Any]:
    """The workflow this project's AFK work reads as: its pick, or One run where it has none."""
    return _chosen(hermes_home, project_id, found) or workflows.one_run()


def _snapshot(
    hermes_home: Path, project_id: str, found: Dict[str, Any]
) -> Optional[Dict[str, Any]]:
    """The pipeline snapshot a task starting now begins under, or ``None`` for one prompt run.

    Only a project on a workflow is staged. A project that named none works one run told its Prompt,
    and nothing is written: its session records no pipeline, so the app draws no stage and no sheet
    (ADR 0027).
    """
    chosen = _chosen(hermes_home, project_id, found)
    return pipeline.start(chosen) if chosen is not None else None


class HeldStage(NamedTuple):
    """The step a held task is in, and the stage's own name: what a sheet's Working row says."""

    step: Optional[str]
    name: Optional[str]


def write_from(body: Dict[str, Any]) -> Tuple[str, Dict[str, Any]]:
    """What a write names and the arguments that write takes — or ValueError.

    One write, one shape: two fields in one body could write one of them and then be refused, leaving
    half of it written. A Prompt's source is no shape of its own, because an id without words names
    nothing to write: it rides with the text as that shape's second argument, None for a plain write
    (which clears whatever source the row held — ADR 0043).

    The answer is the shape's name and the arguments its writer is called with, so the route names
    each writer once, in one table, rather than unpacking a value whose type depends on the shape.
    """
    if "prompt_id" in body and "prompt" not in body:
        raise ValueError("prompt_id needs a prompt beside it.")
    named = [key for key in ("on", "workflow_id", "prompt", "pick_count") if key in body]
    if len(named) > 1:
        raise ValueError("A write names one of on, workflow_id, prompt or pick_count.")
    if "on" in body:
        on = body["on"]
        if not isinstance(on, bool):
            raise ValueError("on must be true or false.")
        return "on", {"on": on}
    if "workflow_id" in body:
        workflow_id = body["workflow_id"]
        if not isinstance(workflow_id, str) or not workflow_id.strip():
            raise ValueError("workflow_id must be a workflow's id.")
        return "workflow", {"workflow_id": workflow_id.strip()}
    if "prompt" in body:
        text = prompt_text(body["prompt"])
        source = prompt_source(body["prompt_id"]) if "prompt_id" in body else None
        return "prompt", {"prompt": text, "prompt_id": source}
    if "pick_count" in body:
        return "pick_count", {"count": pick_count_of(body["pick_count"])}
    raise ValueError("on, workflow_id, prompt or pick_count is needed.")


def pick_count_of(value: Any) -> int:
    """How many tasks a write asks the project to hold: a whole number from one to five.

    Refused rather than clamped, like every other write shape: a count the user didn't ask for
    silently held is worse than a sheet that says what it takes.
    """
    if not _whole(value) or not LOWEST_PICK_COUNT <= value <= MAX_PICK_COUNT:
        raise ValueError(_range("pick_count", LOWEST_PICK_COUNT, MAX_PICK_COUNT))
    return value


def prompt_text(value: Any) -> Optional[str]:
    """A Prompt as the row holds it: trimmed, and None for what isn't one.

    Empty and unset are the same thing — the bot's default method — so a blank Prompt clears the
    column instead of storing words a run would read as the user's.
    """
    if value is not None and not isinstance(value, str):
        raise ValueError("prompt must be text.")
    return pipeline.text(value)


def prompt_source(value: Any) -> str:
    """The library entry a Prompt was copied from: its id, trimmed.

    Given beside a Prompt it has to be one: the app only names an entry it really copied from, so a
    blank or non-text id is a client's mistake rather than a copy without a source — refused, like
    every other write of a shape this host can't hold. A Prompt written without one clears the
    source in ``set_prompt``; that is how a hand edit detaches the copy (ADR 0043).
    """
    if not isinstance(value, str) or not value.strip():
        raise ValueError("prompt_id must be a library entry's id.")
    return value.strip()


def set_prompt(
    hermes_home: Path,
    project_id: str,
    prompt: Optional[str],
    prompt_id: Optional[str] = None,
) -> None:
    """Writes the project's Prompt and the library entry it was copied from, clearing any workflow
    pick in the same write.

    A project is never both: a Prompt is one run's method and a workflow is the stages its work runs
    through. The skill columns a row from before the picker carries go with the pick: they are what
    ``_workflow`` migrates a project with no pick from, so leaving them would put the old workflow
    back as soon as the Prompt was cleared, and empty has to mean the default.

    ``prompt_id`` rides the same write as the words: a pick writes both, and a plain write (the id
    left None) clears it, so a Prompt typed by hand never reads as a stale copy of an entry the user
    didn't choose (ADR 0043).
    """
    _upsert(
        hermes_home,
        project_id,
        prompt=prompt,
        prompt_id=prompt_id,
        workflow_id=None,
        build_skill=None,
        critique_skills=None,
        at=int(time.time()),
    )


def set_workflow(hermes_home: Path, project_id: str, workflow_id: str) -> None:
    """Points this project's AFK work at a workflow in its bot's library, clearing any Prompt it held.

    The id has to be one the library holds: a project naming nothing would silently run the default
    preset, and the user would have picked a workflow that isn't what works. A Prompt and a pick are
    one choice between them, so picking one drops the Prompt in the same write: a project holding both
    would show words no run reads. The Prompt's library source goes with the words it describes.
    """
    if workflows.get(hermes_home, workflow_id) is None:
        raise ValueError(f'There is no workflow "{workflow_id}" in this bot\'s library.')
    _upsert(
        hermes_home,
        project_id,
        workflow_id=workflow_id,
        prompt=None,
        prompt_id=None,
        at=int(time.time()),
    )


def set_pick_count(hermes_home: Path, project_id: str, count: int) -> None:
    """Records how many of its tasks the project may hold at once.

    Lowering it abandons nothing: the holds it has stay until their own work is done, and the next
    pass fills to the new count rather than trimming to it (ADR 0025). Raising it is worth a wake —
    the places it just made are the sweep's to fill now, not in three minutes — and lowering it is
    not: it frees no place, so the sweep it would ask for would find nothing it didn't have.
    """
    before = _stored_pick_count(hermes_home, project_id)
    _upsert(hermes_home, project_id, pick_count=count, at=int(time.time()))
    if count > before:
        wake()


def _stored_pick_count(hermes_home: Path, project_id: str) -> int:
    """The count the project's row holds now, read as its sheet reads it: unset is the default."""
    conn = connect(db_path(hermes_home))
    try:
        row = conn.execute(
            "SELECT pick_count FROM project_afk WHERE project_id = ?", (project_id,)
        ).fetchone()
    finally:
        conn.close()
    return _pick_count({"pick_count": row[0] if row is not None else None})


def budget_from(body: Dict[str, Any]) -> int:
    """The pick budget a bot write names: a whole number from one to ten, or ValueError.

    The bot's own one shape, refused rather than clamped like the project's count: a budget the
    user didn't ask for, silently held, is worse than a Coding tab that says what it takes. Nothing
    else in the body is read, so a field a later route adds beside the budget isn't a refusal here
    (ADR 0026's usage threshold is the one expected to land on this route).
    """
    value = body.get("pick_budget")
    if not _whole(value) or not LOWEST_PICK_BUDGET <= value <= HIGHEST_PICK_BUDGET:
        raise ValueError(_range("pick_budget", LOWEST_PICK_BUDGET, HIGHEST_PICK_BUDGET))
    return value


def threshold_from(body: Dict[str, Any]) -> Optional[int]:
    """The usage threshold a bot write names: a whole number from 50 to 100, or None for Off.

    An explicit null is the same Off an absent row reads as, so the Coding tab's Off pill is a write
    like any other; a value outside the range is refused with a message naming both ends, like the
    budget (ADR 0026). Whole tens are what the control offers, not what the host insists on.
    """
    value = body.get("usage_threshold")
    if value is None:
        return None
    if not _whole(value) or not LOWEST_USAGE_THRESHOLD <= value <= HIGHEST_USAGE_THRESHOLD:
        raise ValueError(
            _range("usage_threshold", LOWEST_USAGE_THRESHOLD, HIGHEST_USAGE_THRESHOLD)
        )
    return value


def bot_writes(body: Dict[str, Any]) -> Dict[str, Any]:
    """The bot-level writes a body names, keyed by settings row, or ValueError.

    Both of the bot's numbers ride one route, so a body may name either or both: the Coding tab
    writes one pill's choice at a time, and a client that knows both may send them together. Nothing
    named is a client's mistake rather than a no-op, and it says which fields it takes. Everything
    named is validated before anything is written, so a body with one good field and one bad one
    writes neither.
    """
    writes: Dict[str, Any] = {}
    if "pick_budget" in body:
        writes[PICK_BUDGET_KEY] = budget_from(body)
    if "usage_threshold" in body:
        writes[USAGE_THRESHOLD_KEY] = threshold_from(body)
    if not writes:
        raise ValueError("pick_budget or usage_threshold is needed.")
    return writes


def write_bot(hermes_home: Path, writes: Dict[str, Any]) -> None:
    """Applies what a bot-level body named, each field through its own writer."""
    if PICK_BUDGET_KEY in writes:
        set_pick_budget(hermes_home, writes[PICK_BUDGET_KEY])
    if USAGE_THRESHOLD_KEY in writes:
        set_usage_threshold(hermes_home, writes[USAGE_THRESHOLD_KEY])


def set_pick_budget(hermes_home: Path, budget: int) -> None:
    """Records how much AFK work the whole bot may hold at once, across all of its projects.

    Lowering it abandons nothing: every hold stays until its own work is done, and the projects that
    are over the new number simply stop claiming until the bot is under it again — the same rule as
    lowering a pick count (ADR 0042). Raising it is worth a wake, since the places it just made are
    the sweep's to fill now; lowering it frees none, so it wakes nothing.
    """
    before = pick_budget(hermes_home)
    put_setting(db_path(hermes_home), PICK_BUDGET_KEY, budget)
    if budget > before:
        wake()


def release(
    hermes_home: Path,
    project_id: str,
    task: Optional[Dict[str, Any]] = None,
    holds: Optional[List["Hold"]] = None,
) -> None:
    """Gives a claimed task back: the mark and the assignment come off GitHub, its hold goes.

    ``task`` is the project's oldest hold unless the caller names one — a session the user closes
    names the task its own record carries — and the hold is only dropped for a task the project is
    actually holding: a session closed after its run finished names a task the hold let go of
    already, when its work went to review, and that is no longer the project's to clear. The
    project's other holds are never touched: giving one task back gives back one row (ADR 0025). A
    GitHub refusal is recorded for the sheet, and the hold goes anyway: nothing on the host is
    working the task either way, and the next sweep's read is what says whether it is back in the
    frontier.

    ``holds`` is the project's holds as the caller already read them, so a settle that gives back
    several tasks reads the project once rather than once per task; left None, they are read here.
    """
    if holds is None:
        found = _row(hermes_home, project_id)
        holds = found["holds"] if found is not None else []
    held = task if task is not None else (holds[0].task if holds else None)
    if held is None:
        return
    row_holds_this_task = any(_same_task(hold.task, held) for hold in holds)
    auth, _ = github.token(hermes_home)
    if auth:
        try:
            github.release_claim(str(held["repo"]), int(held["number"]), tasks.CLAIM_LABEL, auth)
        except (github.GitHubError, KeyError, TypeError, ValueError) as error:
            logger.warning("memento: couldn't release %s on GitHub", held, exc_info=True)
            if row_holds_this_task:
                _refuse(hermes_home, project_id, str(error))
    if row_holds_this_task:
        _free(hermes_home, project_id, held)


def release_session(hermes_home: Path, record: Optional[Dict[str, Any]]) -> bool:
    """Gives back the task a closed session worked, answering whether it had one.

    The task comes off the session's own record, written as its run was published, because the
    project's row lets go of it as soon as that run finishes — which is before the user decides to
    discard or resolve the session. A session the user started by hand names no task and releases
    nothing. Whoever calls this wakes the sweep, unless it is the sweep itself.
    """
    task = (record or {}).get("task")
    project_id = (record or {}).get("project_id")
    if not isinstance(task, dict) or not project_id:
        return False
    release(hermes_home, str(project_id), task)
    return True


def holding_project(hermes_home: Path, session_id: str) -> Optional[str]:
    """The project whose task this session is working, or None when AFK isn't holding it.

    None too when the store can't be read: a hook that can't look is not a reason to stop a finished
    run from waking the sweep.
    """
    if not session_id or not db_path(hermes_home).exists():
        return None
    try:
        hold = _hold_for_session(hermes_home, session_id)
    except (sqlite3.Error, OSError):
        logger.warning("memento: couldn't read AFK's hold for %s", session_id, exc_info=True)
        return None
    return hold.project_id if hold is not None else None


def staged_session(hermes_home: Path, session_id: str) -> Optional[bool]:
    """Whether this session is working a stage of a task's workflow, so nothing may wake it.

    A stage keeps its one run: the stage it moves to is posted on the same session by the gate that
    judged the run before it, so a turn posted by a subagent's completion would be a second run on
    that session, racing the work it is meant to be reading (#469). AFK's own reading is what says
    so — the session's record, found the way a hook finds it (a compressed session walks up to the
    one that has the record), carrying a workflow snapshot (`pipeline.read`, the same read
    ``after_run`` decides a stage by). A task with no workflow snapshots none and is an ordinary
    conversation here.

    A store this can't read answers None — neither a stage nor an ordinary conversation. The caller
    is the wake, which must decide a child's fate from a reading that really landed: a failure is
    not a stage, and dropping every wake of a look on one storage blip is not a bound but a bug.
    """
    path = db_path(hermes_home)
    if not session_id or not path.exists():
        return False
    try:
        record = sessions.record_for(path, hermes_home, session_id)
    except (sqlite3.Error, OSError):
        logger.warning("memento: couldn't read %s's workflow", session_id, exc_info=True)
        return None
    return pipeline.read((record or {}).get("pipeline")) is not None


def stalled(
    hermes_home: Path, live: Optional[Dict[str, str]] = None
) -> Dict[str, Dict[str, Any]]:
    """AFK sessions nothing is working, by Hermes session id, with the reason they wait on the user.

    A hold whose session has no run in flight is one the user has to look at: its run failed, or the
    host restarted while it worked and the session was adopted rather than restarted or doubled.
    Either way it is where waiting sessions appear, naming the project like the rest, and never
    beside a live run — a run in flight is what working it looks like — nor while a stage waits for
    the subagents its run started, since those are working it and the stage's own gate moves on
    without the user (``_held_for_subagents``). Each hold is judged on its own clock, so the one
    claimed a moment ago isn't reported because the one beside it is old.
    """
    found: Dict[str, Dict[str, Any]] = {}
    now = time.time()
    waiting: List[Hold] = []
    for hold in _holds(hermes_home):
        if not hold.session_id or (live and hold.session_id in live):
            continue
        if hold.session_id in _held:
            continue
        if (
            not hold.stalled
            and hold.claimed_at
            and now - hold.claimed_at < STALL_SECONDS
        ):
            continue
        waiting.append(hold)
    if not waiting:
        return found
    names = sessions.project_names(hermes_home)
    for hold in waiting:
        reason: Dict[str, Any] = {
            "kind": "stalled",
            "reason": hold.stalled or DEFAULT_STALL,
        }
        if names.get(hold.project_id):
            reason["project"] = names[hold.project_id]
        found[hold.session_id] = reason
    return found


class _Budget:
    """The bot's pick budget as one pass spends it, counted once before any GitHub read.

    ``total`` is the number the bot is set to and ``held`` how many tasks its projects hold now,
    read from the bot's own store; the pass then moves ``held`` itself — a claim takes a place, a
    task a closed session gave back frees one — so a place freed by the first project can be taken
    by the oldest task of the last, and the numbers a refusal names are the ones the pass arrived
    at (ADR 0042).
    """

    def __init__(self, hermes_home: Path) -> None:
        self.total = pick_budget(hermes_home)
        self.held = holds_held(hermes_home)

    @property
    def remaining(self) -> int:
        return max(0, self.total - self.held)

    def take(self) -> bool:
        """Takes one place, or answers False when the bot already holds as many as it may."""
        if self.remaining <= 0:
            return False
        self.held += 1
        return True

    def give_back(self, count: int) -> None:
        """Credits places whose holds this pass let go of, so the same pass may fill them."""
        self.held = max(0, self.held - count)


class _Account:
    """This bot's account, read at most once per pass and only for a project that could otherwise claim.

    The threshold is the bot's own number, so a bot without one never reads the account at all. The
    read is the profile's main model's provider — the account a pickup's first run will spend, not a
    chat's pick, not a held session's pin, and never a fallback — and its answer is reused by every
    project of the pass, so a bot serving five projects costs one read (ADR 0026).

    Anything that stops an answer — no key, no fetcher for the provider, a provider that is down, an
    answer with no windows, a main model the host can't name — is no hold at all: a host that can't
    read an account is not a reason to stop working, and nothing is recorded.
    """

    def __init__(self, hermes_home: Path) -> None:
        self.hermes_home = hermes_home
        self.threshold = usage_threshold(hermes_home)

    @cached_property
    def deciding(self) -> Optional[Dict[str, Any]]:
        """The account's deciding window, read on first use; None where it can run or can't be read."""
        return _deciding_window(self.hermes_home)

    def refusal(self) -> Optional[str]:
        """Why the account stops this project claiming, or None while it can run or can't be read."""
        if self.threshold is None:
            return None
        window = self.deciding
        if window is None:
            return None
        used = float(window.get("used_percent") or 0.0)
        if used < self.threshold:
            return None
        return USAGE_HELD.format(
            window=window.get("label") or UNNAMED_WINDOW,
            percent=_percent(used),
            threshold=self.threshold,
        )


def _percent(value: float) -> str:
    """A used percent as a sentence says it: whole where it is whole, and no trailing zero where not."""
    return f"{value:g}"


def _deciding_window(hermes_home: Path) -> Optional[Dict[str, Any]]:
    """The window that decides this bot's account, or None where it can't be read.

    The provider is ``_starting_pin``'s read of the profile's main model — the account a pickup's
    first run will spend, read here rather than from a session because a pickup happens before any
    session exists to carry a pin. Every failure is no answer rather than a hold (ADR 0026).
    """
    main = _starting_pin(hermes_home)
    if not main or not main.get("provider"):
        return None
    try:
        with profile_scope(hermes_home):
            answer = usage.fetch(main["provider"])
    except Exception:
        logger.debug("memento: couldn't read this bot's account usage", exc_info=True)
        return None
    if not answer:
        return None
    return answer.get("deciding")


class Plan(NamedTuple):
    """One project's part of a pass: the tasks it could claim, oldest first, and nothing else.

    Read before anything is claimed, because a pass claims in one order over the whole bot: a
    project's candidates are the frontier's oldest tasks its own free places could hold (ADR 0025),
    and which of them actually claim is decided across every project at once (ADR 0042).
    """

    project_id: str
    candidates: List[Dict[str, Any]]


def sweep(
    hermes_home: Path,
    project_id: str,
    folders: Iterable[Any],
    archived: bool = False,
    *,
    skills: Optional[Iterable[str]],
) -> List[Dict[str, Any]]:
    """Claims tasks for a project left to work, filling every free place, oldest first.

    Answers the tasks it just claimed — each carrying the issue's body, which the run that starts it
    opens with — so the caller starts the session for each without a second read, and nothing when
    it claimed nothing. A place is a task: the project holds as many as its pick count says, and a
    pass takes that many less the holds it already has (ADR 0025), within whatever the bot's pick
    budget has left (ADR 0042).

    One project's whole pass, which is all a sweep of one project is; ``sweep_all`` is the same two
    steps over every project of a bot at once, and is where the ordering across projects belongs. A
    hold is settled whether or not the project is still switched on, because the claim is on GitHub
    either way and the switch is only what decides whether a *new* task is taken; a place a settle
    freed is filled by this same pass, but the task it gave back waits for the next sweep, so it
    isn't handed out again the moment the user walks away from it.

    A GitHub refusal — no permission to write issues, a rate limit, no connection — records its
    reason and stops this project's claims where they stand, with the tasks it had already claimed
    held and the switch left on, so the sheet says why; the next sweep is the next attempt, not an
    immediate one.

    The bot's usage threshold, where it has one, is asked before the frontier is read: an account at
    or over it claims nothing and records the window that decided, so a bot left alone stops before it
    spends the last of an account it cannot finish a task on (ADR 0026).

    ``skills`` is the names the profile can run, read once for a whole sweep; a project whose chosen
    build or critique skill isn't among them claims nothing and records why, with its switch still
    on, so a choice the user forgot about is visible instead of silently working around it (ADR
    0018). It is the caller's to pass, and not defaulted: a sweep that judges no choice has to say
    so, since a forgotten argument would quietly turn the check off.
    """
    budget = _Budget(hermes_home)
    plan = _plan(
        hermes_home,
        project_id,
        folders,
        archived,
        skills=skills,
        budget=budget,
        account=_Account(hermes_home),
        promised=set(),
    )
    return [task for _, task in _claims(hermes_home, [plan], budget)]


def _plan(
    hermes_home: Path,
    project_id: str,
    folders: Iterable[Any],
    archived: bool,
    *,
    skills: Optional[Iterable[str]],
    budget: _Budget,
    account: _Account,
    promised: Set[Tuple[Any, Any]],
) -> Plan:
    """What one project could claim in this pass, and the reason it can claim nothing at all.

    Everything a claim needs is decided here but nothing is claimed: the holds this project's closed
    sessions gave back, the reason its switch can't claim, the places its pick count and the bot's
    budget leave it, the skill the bot has lost, the account the pickup would spend, and the frontier
    read that fills them — one GitHub read per project per pass, and none at all for a project with no
    free place or one the bot's budget, a lost skill or a spent account already holds back. A refusal
    recorded here is the project's own answer for this pass: GitHub's, a skill the bot has lost, the
    bot's budget being full, or its account being at the bot's usage threshold.

    The account is asked only here, after the bot's own numbers and its skill, so the read is spent on
    a project that would otherwise claim.

    ``promised`` is the tasks an earlier project of this pass has already planned (or claimed): two
    projects can point at one repository, so their frontiers are the same list, and a task planned
    twice is a task claimed twice. The tasks taken here are added to it, so the pass hands each task
    out once; a project whose whole frontier was taken is one with nothing to claim rather than one
    the budget held back, and says nothing of it.
    """
    found = _row(hermes_home, project_id)
    if found is None:
        return Plan(project_id, [])
    # Before anything is claimed: a hold whose session the user closed goes back, and what it gave
    # back is not claimed again by this pass — but its place is the pass's to fill again.
    given_back = _settle(hermes_home, project_id, found["holds"])
    budget.give_back(len(given_back))
    if not found["on"]:
        return Plan(project_id, [])
    why = reason(hermes_home, folders, archived)
    if why is not None:
        # Put away, with no repository to read, or no account to read it with: the sheet's own
        # reason already says so, and it isn't GitHub refusing anything — so a refusal it recorded
        # before would sit beside that reason saying something GitHub no longer says.
        _forget_refusal(hermes_home, project_id, found)
        return Plan(project_id, [])
    gave_back = {_key(task) for task in given_back}
    holds = [hold for hold in found["holds"] if _key(hold.task) not in gave_back]
    places = _pick_count(found) - len(holds)
    if places <= 0:
        return Plan(project_id, [])
    if budget.remaining <= 0:
        # The bot holds as much as its budget allows and this project would have claimed: its sheet
        # says so, and the pass reads no frontier for a task it couldn't take — a sweep held back by
        # the budget never asks GitHub how full it is (ADR 0042).
        _refuse(hermes_home, project_id, _budget_full(budget))
        return Plan(project_id, [])
    if skills is not None:
        missing = _missing_skill(hermes_home, project_id, found, skills)
        if missing is not None:
            _refuse(hermes_home, project_id, MISSING_SKILL.format(name=missing))
            return Plan(project_id, [])
    # Beside the lost-skill branch rather than inside it: a project that runs one prompt names no
    # skill, so a check written there would never run for it (ADR 0026).
    spent = account.refusal()
    if spent is not None:
        _refuse(hermes_home, project_id, spent)
        return Plan(project_id, [])
    try:
        ready = tasks.frontier(hermes_home, folders)
    except github.GitHubError as error:
        _refuse(hermes_home, project_id, str(error))
        return Plan(project_id, [])
    # A task the project holds, one this pass just gave back, or one an earlier project of this
    # pass already has, is not one to claim now: the release took its marks off GitHub, so it is
    # back in the frontier the read above sees, and two projects of one repository plan from the
    # same list.
    taken = {_key(hold.task) for hold in holds} | {_key(task) for task in given_back}
    candidates = [task for task in ready if _key(task) not in taken | promised][:places]
    if not candidates:
        # GitHub answered and has nothing to give: whatever it refused before is stale.
        _forget_refusal(hermes_home, project_id, found)
        return Plan(project_id, [])
    promised.update(_key(task) for task in candidates)
    return Plan(project_id, candidates)


def _claims(
    hermes_home: Path, plans: Iterable[Plan], budget: _Budget
) -> List[Tuple[str, Dict[str, Any]]]:
    """Claims the plans' tasks in one order over the whole bot: the oldest ready task first.

    A freed place goes to the oldest ready task of any project, not to the first project the pass
    happened to look at — the frontier's oldest-first rule, read over the bot instead of over one
    project (ADR 0042). Each claim still needs a place of its own project's count (which its plan
    already allowed for) and of the bot's budget, so a task whose place the budget took is left for
    the next pass, and the project it belonged to records why.

    A GitHub refusal records that project's reason and leaves its remaining tasks for the next pass,
    while the tasks other projects hold stay claimed: one project's trouble is no reason to stop
    another's work, and the switch stays on so the sheet says what happened.
    """
    ordered = sorted(
        ((task, plan.project_id) for plan in plans for task in plan.candidates),
        key=lambda pair: (*tasks.order(pair[0]), pair[1]),
    )
    if not ordered:
        return []
    auth, _ = github.token(hermes_home)
    claimed: List[Tuple[str, Dict[str, Any]]] = []
    claimed_this_pass: Set[Tuple[Any, Any]] = set()
    labelled: set = set()
    stopped: set = set()
    refused: set = set()
    # Whose account a claim is assigned to, resolved on the first claim and not once per task: it
    # is one read of GitHub's own answer about the token, and the same answer every time.
    account: Optional[str] = None
    for task, project_id in ordered:
        key = _key(task)
        if key in claimed_this_pass:
            continue
        if project_id in stopped:
            # GitHub refused this project's last claim: the rest of its tasks wait for the next pass.
            continue
        if not budget.take():
            if project_id not in refused:
                refused.add(project_id)
                _refuse(hermes_home, project_id, _budget_full(budget))
            continue
        try:
            if account is None:
                account = github.login(auth)
            github.claim_issue(
                task["repo"],
                task["number"],
                account,
                tasks.CLAIM_LABEL,
                auth,
                labelled=labelled,
            )
        except github.GitHubError as error:
            # Nothing was taken, so the place the claim would have used is the pass's again.
            budget.give_back(1)
            _refuse(hermes_home, project_id, str(error))
            stopped.add(project_id)
            continue
        # The hold clears the last refusal in the same write: this sweep just got an answer.
        _hold(hermes_home, project_id, task)
        claimed.append((project_id, task))
        claimed_this_pass.add(key)
    return claimed


def _budget_full(budget: _Budget) -> str:
    """The words a project the bot's budget held back records, naming both numbers."""
    return PICK_BUDGET_FULL.format(held=budget.held, budget=budget.total)


def new_session_id() -> str:
    return f"{sessions.MEMENTO_ID_PREFIX}afk-{uuid.uuid4().hex[:12]}"


def session_title(task: Dict[str, Any]) -> str:
    return f"#{task.get('number')} {task.get('title') or ''}".strip()


def run_body(
    record: Dict[str, Any],
    task: Dict[str, Any],
    prompt: Optional[str],
    pinned: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    """The ``POST /v1/runs`` request: how to work a planned issue, and the issue itself as the input.

    The prompt is all `prompt_builder`'s — one module holds every word the agent is told — and the
    input is `prompt_builder.afk_input`: the issue's title, description and link.
    """
    return _request(
        record,
        prompt_builder.afk_prompt(record, task, prompt),
        prompt_builder.afk_input(task),
        pinned,
    )


def stage_body(
    record: Dict[str, Any], task: Dict[str, Any], pinned: Optional[Dict[str, str]] = None
) -> Dict[str, Any]:
    """The next run's request: the same session, briefed for the stage the task is in now.

    Every stage is one run of that session — the transcript is the work's own account of itself —
    and the brief names the stage, its skills in order and, for a loop's next round, the command the
    round before failed on. Only the shipping stage is told the base branch, because only its run
    opens the pull request; the review hands it to whatever reads the diff.
    """
    staged = pipeline.read(record.get("pipeline"))
    return _request(
        record,
        prompt_builder.stage_prompt(
            record, task, base_branch(record) if pipeline.ships(staged) else None
        ),
        prompt_builder.stage_input(task, pipeline.stage_name(staged)),
        pinned,
    )


def _request(
    record: Dict[str, Any],
    instructions: str,
    content: str,
    pinned: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    """One run of the task's session: what the agent is told, and the line that opens the turn.

    ``pinned`` is the model this session keeps (``chats.pin``): naming it on the run is what keeps
    the profile's Default model from reaching a session already under way, since the host builds the
    agent off its file for every run it is asked for.
    """
    return {
        "session_id": record["session_id"],
        "instructions": instructions,
        "input": [{"role": "user", "content": content}],
        **chats.pin_fields(pinned),
    }


def _starting_pin(hermes_home: Path) -> Optional[Dict[str, str]]:
    """The model a new session's first run takes, and the pick its record is then published with.

    A session ``start`` makes has no record of its own to read: its id is minted there, and its
    record is written only once its run is under way, so the profile's main model is the only answer
    — what its run would have taken with no model named at all, made explicit here so the record can
    keep it. A file this can't read is no pin rather than a failure: a model pick is never worth
    losing a task's start over, and a run that names no model runs the host's own, as every AFK run
    used to.
    """
    try:
        return host_model.read_main(Path(hermes_home) / "config.yaml")
    except Exception:
        logger.debug("memento: AFK couldn't read this home's main model", exc_info=True)
        return None


def base_branch(record: Dict[str, Any]) -> Optional[str]:
    """The branch this session's work is against: its primary worktree's base."""
    from . import projects

    primary = next((repo.get("path") for repo in record.get("repos") or []), None)
    return projects._base_branch(primary) if primary else None


class Start(NamedTuple):
    """What a start takes off the project's row: the task's workflow snapshot — none for a project
    that works one prompt run — its Prompt, and the model its first run goes out on."""

    snapshot: Optional[Dict[str, Any]]
    prompt: Optional[str]
    pinned: Optional[Dict[str, str]]


def _begin(
    hermes_home: Path, path: Path, project_id: str, session_id: str
) -> Start:
    """Writes the snapshot a staged task starts with, and answers the Prompt and the pin beside it.

    The project's workflow as it stands now, copied onto the task: editing or deleting the library
    entry afterwards cannot rewrite what this task ran. Written before the run is posted, so the
    build's own instructions already know where they end. The Prompt comes off the same read of the
    row — the sweep works a task with the app closed, so the Prompt written last night is the one the
    run reads, with nothing the app sent in between. The pin is the model the session's first run
    goes out on and the pick its record is then published with (``_starting_pin``), read here so
    that the two can never disagree and ``start`` holds no local it has to carry past a block that
    can give the claim back.

    A project that named no workflow snapshots nothing (ADR 0027). A task already holding its work
    keeps the snapshot it started under, since the snapshot it runs by lives on its own session's
    record and not here.
    """
    found = _row(hermes_home, project_id) or {}
    staged = _snapshot(hermes_home, project_id, found)
    if staged is not None:
        sessions.set_pipeline(path, session_id, staged)
    return Start(staged, found.get("prompt"), _starting_pin(hermes_home))


def publish(
    hermes_home: Path,
    session_id: str,
    project_id: str,
    task: Dict[str, Any],
    pinned: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    """Writes the chat record that makes the session appear and open in the app (ADR 0013).

    Its ``updatedAt`` is newer than its ``createdAt``, because the Code list hides a session nothing
    was sent in by exactly that rule; the record is keyed by the session id, so a device has one id
    for it. It is written once, here: the chat list is last-write-wins, so a title the user edits, a
    mode they change or a resolve they make afterwards has to win. The title is marked edited because
    Hermes titles a session from a slice of its opener, which here is the issue block's `Title:` line,
    and the app would otherwise replace the task's own name with that.

    ``pinned`` is the model the session's first run went out on, when the host named one, written as
    the record's ``modelChoice`` so every later run of that session — its stages, its subagents'
    wakes — runs it too, and a change to the profile's Default model leaves it alone.
    """
    sessions.set_task(db_path(hermes_home), session_id, _held_fields(task))
    now = int(time.time() * 1000)
    value = {
        "title": session_title(task),
        "hermesSessionId": session_id,
        "createdAt": now,
        "updatedAt": now + 1,
        "projectId": project_id,
        "mode": "auto",
        "afk": True,
        "titleEdited": True,
        **chats.pin_fields(pinned, choice=True),
    }
    chats.merge(db_path(hermes_home), {session_id: {"at": now + 1, "value": value}})
    return value


async def start(
    adapter: Any, hermes_home: Path, project_id: str, task: Dict[str, Any]
) -> None:
    """Works a claimed task in a session of its own: its worktree, its run, its chat record.

    The task is already claimed by the sweep, and it carries the issue's own text from that claim:
    the run opens with the issue as the claim read it, and the tracker stays the source for anything
    written since. The record is written only once the run is under way: a session the app
    shows with no run behind it is worse than one it never hears about. A start that never gets its
    run away gives the claim back (ADR 0015): nothing began the work, so the task returns to the
    frontier instead of sitting claimed with no session to show for it.

    A new session has no model of its own yet, so its first run goes out on the profile's main model
    and the record it publishes keeps that pick (`_starting_pin`, read by ``_begin`` and handed back
    with the run's other ingredients): the user's Default model chooses a model for a session that
    starts, and never one that is already running.
    """
    session_id = new_session_id()
    issue = f"{task.get('repo')}#{task.get('number')}"
    try:
        record = await asyncio.to_thread(
            sessions.ensure,
            db_path(hermes_home),
            hermes_home,
            session_id,
            project_id,
            task.get("title") or "",
            "auto",
        )
    except Exception:
        logger.warning("memento: AFK couldn't make a session for %s", issue, exc_info=True)
        await asyncio.to_thread(release, hermes_home, project_id, task)
        return
    try:
        await asyncio.to_thread(_adopt, hermes_home, project_id, session_id, task)
        sessions.apply_cwd(session_id, record["path"])
        began = await asyncio.to_thread(
            _begin, hermes_home, db_path(hermes_home), project_id, session_id
        )
        record = {**record, "pipeline": began.snapshot}
        started = await _post(
            adapter, hermes_home, run_body(record, task, began.prompt, began.pinned)
        )
    except Exception as error:
        logger.warning("memento: AFK couldn't start the session for %s: %s", issue, error)
        await asyncio.to_thread(release, hermes_home, project_id, task)
        return
    try:
        await asyncio.to_thread(publish, hermes_home, session_id, project_id, task, began.pinned)
    except Exception:
        # The run is going and nothing else can show it: name the session, which is all a reader of
        # the log has to find it with.
        logger.error(
            "memento: AFK started %s in %s but couldn't publish it to the app",
            issue,
            session_id,
            exc_info=True,
        )
    logger.info(
        "memento: AFK is working %s in %s (run %s)", issue, session_id, started.get("run_id")
    )


async def _post(adapter: Any, hermes_home: Path, body: Dict[str, Any]) -> Dict[str, Any]:
    """Posts one run on a session's own agent, through the key this home holds (ADR 0013)."""
    from . import link, outbox

    return await outbox.post(
        adapter,
        link.profile_name(hermes_home),
        "/v1/runs",
        body,
        authorization=link.authorization(hermes_home),
    )


def enabled_projects(hermes_home: Path) -> List[str]:
    """Every project left to work: one read for a whole sweep, which reads each row as it goes."""
    conn = connect(db_path(hermes_home))
    try:
        rows = conn.execute(
            "SELECT project_id FROM project_afk WHERE enabled = 1 ORDER BY project_id"
        ).fetchall()
    finally:
        conn.close()
    return [str(row[0]) for row in rows]


def sweep_all(hermes_home: Path) -> List[Tuple[str, Dict[str, Any]]]:
    """Sweeps every project left on, and every one still holding a task; one's trouble never stops another's.

    A project switched off with a task held is swept too: nothing takes a new task for it, but its
    holds still have to be settled when the user closes their sessions, or the claims sit on GitHub
    with nothing working them and nothing ever looking again.

    The bot's pick budget is counted here, once, before any project's frontier is read: how many
    tasks every project of this bot holds together is a count on the bot's own store, and the pass
    spends that number as it claims (``_Budget``). Each project is then read into its own plan, and
    the plans' tasks are claimed in one order over the whole bot — oldest ready first — so a place
    that frees goes to whoever has waited longest rather than to whichever project the loop reached
    first (ADR 0042).

    Answers what the pass claimed, in the order it took them, so the caller can start those sessions
    one after another; a project that claimed nothing isn't in the list.
    """
    held = [hold.project_id for hold in _holds(hermes_home)]
    due = list(dict.fromkeys([*enabled_projects(hermes_home), *held]))
    if not due:
        return []
    # Counted once, and before any GitHub read: the budget and the holds against it are this bot's
    # own store's answer, so a pass never asks GitHub how full it is (ADR 0042).
    budget = _Budget(hermes_home)
    # One read of the project list, not one per project: a sweep only needs their folders.
    projects = sessions.projects(hermes_home / "projects.db")
    # And one of the skills this bot can run, for every project's choice: a skill the profile no
    # longer has stops that project's sweep (ADR 0018), and a host that can't list its skills
    # judges nothing. Read only when a project has picked one to judge.
    skills = _profile_skills(hermes_home) if workflows.any_steps(hermes_home) else None
    # And one look at the bot's account, for every project of the pass: the threshold is the bot's,
    # so its account is too, and the read is made only when a project reaches the point of claiming
    # what it has left (ADR 0026).
    account = _Account(hermes_home)
    plans: List[Plan] = []
    # The tasks this pass has already given to a project: two projects can point at one repository,
    # so their frontiers are one list and each task is planned once.
    promised: Set[Tuple[Any, Any]] = set()
    for project_id in due:
        project = projects.get(project_id)
        if project is None:
            # A row whose project is gone.
            continue
        try:
            plans.append(
                _plan(
                    hermes_home,
                    project_id,
                    project.folders,
                    bool(getattr(project, "archived", False)),
                    skills=skills,
                    budget=budget,
                    account=account,
                    promised=promised,
                )
            )
        except Exception:
            logger.warning("memento: couldn't sweep AFK's project %s", project_id, exc_info=True)
            continue
    return _claims(hermes_home, plans, budget)


async def sweep_homes(adapter: Any) -> None:
    """Sweeps every home this process serves, and starts the session for what each just claimed.

    Not just its own home: a /p/<profile> bot keeps its own store. One home's trouble is that
    home's, so a store it can't read must not stop the rest. A session is started here, on the loop,
    because starting a run is the API server's own call and this is the thread it's reached from —
    and one after another, even where a project claimed several: a start makes a worktree on the
    project's repository, and two of those at once is a load nobody asked for (ADR 0025).
    """
    from . import link

    for one in link.served_homes(adapter):
        try:
            claimed = await asyncio.to_thread(sweep_all, one)
        except Exception:
            logger.warning("memento: AFK couldn't sweep the home at %s", one, exc_info=True)
            continue
        for project_id, task in claimed:
            try:
                await start(adapter, one, project_id, task)
            except Exception:
                logger.warning("memento: AFK couldn't start %s's task", project_id, exc_info=True)


async def run(adapter: Any) -> None:
    """Sweeps the projects left on every ``SWEEP_SECONDS``, and at once when woken, while Hermes runs."""
    global _loop, _event
    _loop = asyncio.get_running_loop()
    _event = asyncio.Event()
    swept = 0.0

    while True:
        now = time.monotonic()
        if _held:
            try:
                await settle_held(adapter)
            except Exception:
                logger.warning("memento: AFK couldn't settle a held stage", exc_info=True)
        if not _held or now - swept >= SWEEP_SECONDS:
            swept = now
            try:
                await sweep_homes(adapter)
            except Exception:
                logger.warning("memento: AFK's sweep failed", exc_info=True)
        try:
            await asyncio.wait_for(_event.wait(), HOLD_SECONDS if _held else SWEEP_SECONDS)
        except asyncio.TimeoutError:
            pass
        _event.clear()


def wake() -> None:
    """Asks the sweep to look now — a project was turned on, or a session finished — from any thread."""
    events.poke(_loop, _event)


def after_run(
    session_id: Any = None,
    completed: bool = False,
    failed: bool = False,
    interrupted: bool = False,
    **_kwargs: Any,
) -> None:
    """The ``on_session_end`` hook: AFK's own task finished, or nothing is working it any more.

    A run that finished hands the project the hold back: its claim stays on GitHub, because the task
    is in review, but the hold is the place it took, so it goes and the sweep is asked to look now. A
    run that stopped any other way is left exactly as it is — the session, its transcript and its
    claim — and records why nothing is working the task (a failure, an interruption, or no reason at
    all), so the app shows the session where it shows a wait (ADR 0015). Only a session AFK is
    holding is its own: every other project session just wakes the sweep, and a chat's turn says
    nothing about any work. The project's other holds are never touched: a run's end is its own
    task's business (ADR 0025).

    A staged task's run end is its stage's business instead (ADR 0018, ADR 0020): the stage's
    checkpoint and the worktree decide whether it moves on, repeats a loop or stalls, and the stage
    it moves to is posted on the same session as its own run.
    """
    try:
        path, home = sessions._paths()
        record = sessions.record_for(path, home, str(session_id or ""))
        if not record:
            return
        stopped = sessions.outcome(
            completed=completed, failed=failed, interrupted=interrupted
        )
        project_id = holding_project(home, str(record.get("session_id") or ""))
        staged = pipeline.read(record.get("pipeline"))
        session_id = record.get("session_id")
        if project_id is not None:
            if staged is not None:
                _stage_end(home, path, project_id, record, staged, stopped)
                return
            if not stopped.finished:
                _stall(home, project_id, record.get("task"), _stopped(stopped), session_id)
                return
            _free(home, project_id, record.get("task"), session_id)
        wake()
    except Exception:
        logger.debug("memento: couldn't wake AFK's sweep", exc_info=True)


def _stage_end(
    hermes_home: Path,
    path: Path,
    project_id: str,
    record: Dict[str, Any],
    staged: Dict[str, Any],
    stopped: sessions.Outcome,
) -> None:
    """Settles a staged task whose run just ended: its gate's verdict, then the stage that follows.

    A run of a stage that posts nothing never reaches here — a checkpoint is judged by the host from
    the run before it, and an inert stage by nothing at all. The worktree is measured only for a
    stage whose gate already passed: a gate that failed stalls the task in the stage it stopped in,
    and nothing about the tree can change that. The stage is written before anything is started, so
    a run that can't be posted leaves a record that says where the task stands.

    A run is only half of what a stage waits for: one that dispatched a subagent leaves it writing
    the tree the gate reads, so the end is held until every one of them has ended too (#469).
    """
    if _held_for_subagents(hermes_home, record, stopped):
        return
    worktree: Iterable[Dict[str, Any]] = ()
    in_gate = stopped.finished and pipeline.measured(staged)
    if in_gate and pipeline.gate_verdict(staged) is None:
        worktree = ship.status(record)
    step = pipeline.advance(
        staged, stopped=None if stopped.finished else _stopped(stopped), worktree=worktree
    )
    moved = pipeline.moved(staged, step)
    sessions.set_pipeline(path, record["session_id"], moved)
    session_id = record.get("session_id")
    if step.stall:
        _stall(hermes_home, project_id, record.get("task"), step.stall, session_id)
        return
    if pipeline.ships(staged):
        # The stage that just ended is the one that opens the pull request, so the draft is what
        # says it did: a review that ended without one reviewed nothing the user can see.
        unshipped = _unshipped(hermes_home, record)
        if unshipped is not None:
            sessions.set_pipeline(path, record["session_id"], pipeline.failed(moved, unshipped))
            _stall(hermes_home, project_id, record.get("task"), unshipped, session_id)
            return
    if not pipeline.posts_now(moved):
        # Nothing is left to run: the task's work is in review, so its hold goes and the sweep looks
        # for the project's next task.
        _free(hermes_home, project_id, record.get("task"), session_id)
        wake()
        return
    # The next stage is the same session's next run: the hold keeps the task, and the stall clock
    # starts again so the moment between two runs isn't read as nothing working it.
    _adopt(hermes_home, project_id, record["session_id"], record.get("task"))
    # The record as the task stands now, not as the run that ended left it: the next brief reads the
    # stage off it, and handing it the stage behind would brief the run for work already done.
    _start_stage(hermes_home, {**record, "pipeline": moved})


def _held_for_subagents(
    hermes_home: Path, record: Dict[str, Any], stopped: sessions.Outcome
) -> bool:
    """Whether the stage's run left subagents at work, holding its gate until they end.

    A subagent counts as at work while the session that dispatched it has a run in flight — the rule
    ``delegation.children`` reads every card by — so a row a host left open with no run behind it
    (the host died with the child) reads stopped, and stopped is ended: it can't hold a stage for
    ever. What the hold keeps is the session, its home and how its run ended, because that run is
    what is over: the look that finds the last subagent ended (``settle_held``) takes the stage on
    with the outcome its own run had, rather than with a later reading of it.
    """
    session_id = str(record.get("session_id") or "")
    if not session_id:
        return False
    try:
        live = sessions.live_runs(getattr(sessions, "adapter", None), None, hermes_home)[0]
        working = any(
            child["status"] == "running"
            for child in delegation.children(hermes_home, session_id, set(live))
        )
    except Exception:
        logger.debug("memento: couldn't read %s's subagents", session_id, exc_info=True)
        return False
    if not working:
        _held.pop(session_id, None)
        return False
    _held[session_id] = StageHold(home=Path(hermes_home), outcome=stopped)
    return True


async def settle_held(adapter: Any) -> List[str]:
    """Moves on every held stage whose subagents have all ended, on each home this process serves.

    A stage's run ends before the subagents it started do, so its gate is settled here instead of by
    a hook: from the store's own reading, on the loop's short clock while a hold is pending
    (``HOLD_SECONDS``) — never at a sweep's pace, because a sweep reads GitHub. Answers the sessions
    it moved on.
    """
    from . import link

    moved: List[str] = []
    for home in link.served_homes(adapter):
        try:
            moved += await asyncio.to_thread(_settle_home, home)
        except Exception:
            logger.warning("memento: AFK couldn't settle a held stage at %s", home, exc_info=True)
    return moved


def _settle_home(hermes_home: Path) -> List[str]:
    """Looks again at each stage this home holds for its subagents; names the ones that moved on."""
    moved: List[str] = []
    path = db_path(hermes_home)
    for session_id in list(_held):
        held = _held[session_id]
        if Path(held.home) != Path(hermes_home):
            continue
        record = sessions.record_for(path, hermes_home, session_id)
        project_id = holding_project(hermes_home, session_id)
        staged = pipeline.read((record or {}).get("pipeline"))
        if not record or project_id is None or staged is None:
            # The task moved on, or its session is gone: nothing is waiting on this stage.
            _held.pop(session_id, None)
            continue
        _stage_end(hermes_home, path, project_id, record, staged, held.outcome)
        if session_id not in _held:
            moved.append(session_id)
    return moved


def _start_stage(hermes_home: Path, record: Dict[str, Any]) -> None:
    """Starts the run for the stage a task has moved to, on the loop that owns the runs.

    The hook runs in Hermes's own thread, so the run is posted there rather than awaited here. A run
    that can't be started stalls the task instead: nothing is working its next stage, and the claim
    is what the user finds it by. The task is the one this session holds, not the project's oldest:
    another task of the same project may be further along.
    """
    project_id = str(record.get("project_id") or "")
    task = (
        _held_task(hermes_home, project_id, session_id=record["session_id"])
        if project_id
        else None
    )
    loop = _loop
    name = pipeline.stage_name(pipeline.read(record.get("pipeline"))) or ""
    if not isinstance(task, dict) or loop is None:
        logger.warning(
            "memento: AFK can't start the \"%s\" stage of %s (no task held or no loop)",
            name,
            record.get("session_id"),
        )
        if project_id:
            _stall(hermes_home, project_id, task, STAGE_FAILED.format(name=name))
        return
    asyncio.run_coroutine_threadsafe(
        work_stage(sessions.adapter, hermes_home, record, task), loop
    )


async def work_stage(
    adapter: Any, hermes_home: Path, record: Dict[str, Any], task: Dict[str, Any]
) -> None:
    """Posts one stage's run on the session, briefed for the stage the task is in.

    The run carries the model the session is pinned to (`chats.pin`), read back off its chat record,
    so a session that pinned one keeps it however the profile's Default model moves. A record that
    pins none — one published before records carried a pick, and every session that started before
    this change — names no model, and the host runs its current main model, exactly as every run did
    before the pin existed.
    """
    issue = f"{task.get('repo')}#{task.get('number')}"
    name = pipeline.stage_name(pipeline.read(record.get("pipeline"))) or ""
    try:
        pinned = await asyncio.to_thread(chats.pin, db_path(hermes_home), record["session_id"])
        started = await _post(adapter, hermes_home, stage_body(record, task, pinned))
    except Exception as error:
        logger.warning(
            "memento: AFK couldn't start %s's \"%s\" stage for %s: %s", issue, name, record["session_id"], error
        )
        project_id = str(record.get("project_id") or "")
        if project_id and holding_project(hermes_home, record["session_id"]) == project_id:
            _stall(
                hermes_home,
                project_id,
                task,
                STAGE_FAILED.format(name=name),
                record["session_id"],
            )
        return
    logger.info(
        "memento: AFK is working %s's \"%s\" stage in %s (run %s)",
        issue,
        name,
        record["session_id"],
        started.get("run_id"),
    )


def _unshipped(hermes_home: Path, record: Dict[str, Any]) -> Optional[str]:
    """Why a finished shipping stage left no pull request, or None when one of its repos has one.

    A GitHub that can't be asked says nothing rather than stalling the task over a failed lookup.
    """
    from . import github

    try:
        for repo in record.get("repos") or []:
            found = github.pull_request(
                hermes_home, repo.get("repo_root") or "", repo.get("branch") or "", checks=False
            )
            if found:
                return None
    except Exception:
        logger.debug(
            "memento: couldn't ask GitHub whether %s shipped", record.get("session_id"), exc_info=True
        )
        return None
    return NO_PULL_REQUEST


def _missing_skill(
    hermes_home: Path, project_id: str, found: Dict[str, Any], skills: Iterable[str]
) -> Optional[str]:
    """The first skill this project's next task would apply that its bot no longer has, if any.

    A workflow naming a skill the profile has lost claims nothing until the user picks otherwise
    (ADR 0018). The steps judged are the ones the task's own snapshot names (``_snapshot``), so a
    project working one prompt run names none and this and the task can't disagree.
    """
    staged = _snapshot(hermes_home, project_id, found)
    known = set(skills)
    return next((name for name in pipeline.steps_of(staged) if name not in known), None)


def _profile_skills(hermes_home: Path) -> Optional[set]:
    """The skill names this home's profile can run, or None when its host can't say.

    Read the way the composer's ``/`` menu reads them (`skill_catalog`, the enabled and loadable
    set), because only what the bot can actually run is worth refusing over. A Hermes whose skills
    module moved answers None instead of stopping every sweep: a host that can't list its skills
    isn't a host to judge a choice by.
    """
    from . import link, skill_catalog

    try:
        return {
            str(skill.get("name") or "")
            for skill in skill_catalog.read(link.profile_name(hermes_home))
        }
    except Exception:
        logger.debug("memento: couldn't read this bot's skills", exc_info=True)
        return None


def _stopped(outcome: sessions.Outcome) -> str:
    """Why a run stopped, in the words the app shows under the session.

    A stop is not always a failure: a turn that ends without finishing — an iteration limit reached,
    a stop, an empty answer — is the claim nothing is working, and saying it failed would be the host
    inventing a reason.
    """
    if outcome.interrupted:
        return INTERRUPTED_RUN
    return FAILED_RUN if outcome.failed else DEFAULT_STALL


def _held_fields(task: Dict[str, Any]) -> Dict[str, Any]:
    """The task as the host keeps it — the sheet's fields, and what a pull request closes it by.

    The issue's body is the run's, and stays out of both records: the hold and the session row are
    read on every hook and answered to the app, and neither shows what the task says.
    """
    return {key: task.get(key) for key in HELD}


def _hold(hermes_home: Path, project_id: str, task: Dict[str, Any]) -> None:
    """Takes a place on the task, and clears any refusal: the sweep just succeeded.

    A row of its own, so the project's other holds are untouched; keyed by the task, so a claim
    already held is refreshed rather than doubled.
    """
    held = _held_fields(task)
    conn = connect(db_path(hermes_home))
    try:
        conn.execute(
            f"""INSERT INTO holds
                   (project_id, task, repo, number, created_at, claimed_at, session_id, stalled, stalled_at)
               VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
               ON CONFLICT({', '.join(HOLD_COLUMNS)}) DO UPDATE SET
                   task = excluded.task, created_at = excluded.created_at,
                   claimed_at = excluded.claimed_at, session_id = NULL,
                   stalled = NULL, stalled_at = NULL""",
            (
                project_id,
                json.dumps(held),
                held["repo"],
                held["number"],
                held["created_at"],
                int(time.time()),
            ),
        )
        conn.execute(
            "UPDATE project_afk SET refusal = NULL, refused_at = NULL WHERE project_id = ?",
            (project_id,),
        )
    finally:
        conn.close()


def _write_hold(hermes_home: Path, project_id: str, task: Any, **fields: Any) -> None:
    """Writes the named columns of one hold; naming none, the hold goes.

    The one writer for a hold's columns, so the three writers below agree on which row they mean —
    this project's hold for this task, never the oldest one it happens to have — and on what a
    write that finds no such row says. A delete that finds none says nothing: a task already given
    back is what a second end of the same run means.
    """
    held = _held_fields(task) if isinstance(task, dict) else {}
    keys = (project_id, held.get("repo"), held.get("number"))
    conn = connect(db_path(hermes_home))
    try:
        if not fields:
            conn.execute(f"DELETE FROM holds WHERE {HOLD_KEY}", keys)
            return
        assignments = ", ".join(f"{name} = ?" for name in fields)
        cursor = conn.execute(
            f"UPDATE holds SET {assignments} WHERE {HOLD_KEY}", (*fields.values(), *keys)
        )
        if cursor.rowcount == 0:
            logger.warning("memento: AFK had no hold for project %s to write", project_id)
    finally:
        conn.close()


def _held_task(
    hermes_home: Path, project_id: str, task: Any = None, session_id: Optional[str] = None
) -> Optional[Dict[str, Any]]:
    """The task a hook is about: the one its record names, or else the one its session holds.

    Never the project's oldest, which is what a missing task used to mean: a project may hold
    several, and a record that names none must not have a run's end give back whichever of them
    happened to be claimed first. A caller that can name neither a task nor a session holding one
    has nothing to write about.
    """
    if isinstance(task, dict) and task:
        return task
    if not session_id:
        return None
    hold = _hold_for_session(hermes_home, session_id)
    if hold is None or hold.project_id != project_id or not hold.task:
        return None
    return hold.task


def _adopt(
    hermes_home: Path, project_id: str, session_id: str, task: Any = None
) -> None:
    """Names the session working a held task, so a restart adopts that one and nothing else.

    Written before the run is posted, so a run that ends at once still finds the hold naming its
    session, and cleared only when the task is finished or given back. It also restarts the clock a
    stalled claim is measured from — this hold's clock, not its neighbours'.
    """
    held = _held_task(hermes_home, project_id, task, session_id)
    if held is None:
        logger.warning(
            "memento: AFK had no hold for project %s to name a session on", project_id
        )
        return
    _write_hold(
        hermes_home,
        project_id,
        held,
        session_id=session_id,
        claimed_at=int(time.time()),
        stalled=None,
        stalled_at=None,
    )


def _free(
    hermes_home: Path,
    project_id: str,
    task: Any = None,
    session_id: Optional[str] = None,
) -> None:
    """Lets go of a held task without giving the claim back: its work is in review on GitHub.

    ``task`` is the one that session worked, and it is the hold the session is working that says so
    when the caller names none: giving one task back gives back one row and never the project's
    others, and never one the record can't name.
    """
    held = _held_task(hermes_home, project_id, task, session_id)
    if held is None:
        return
    _write_hold(hermes_home, project_id, held)


def _stall(
    hermes_home: Path,
    project_id: str,
    task: Any,
    why: str,
    session_id: Optional[str] = None,
) -> None:
    """Records why nothing is working a held task, which the app shows where a wait is shown."""
    held = _held_task(hermes_home, project_id, task, session_id)
    if held is None:
        logger.warning("memento: AFK had no hold for project %s to stall", project_id)
        return
    _write_hold(hermes_home, project_id, held, stalled=why, stalled_at=int(time.time()))


def _settle(
    hermes_home: Path, project_id: str, holds: Iterable["Hold"]
) -> List[Dict[str, Any]]:
    """Gives back the holds whose session the user closed, answering the tasks it gave back.

    The user's own marks are what says a session's work is over: discarded, resolved, or deleted
    outright, read from the chat list rather than a route, so a session closed on any device — or
    while the host was away — still gives its task back. Each hold is judged on its own: one
    session closed says nothing about the task beside it.

    A hold that names no session is one nothing can be working: a start killed between the claim and
    its session, say. It goes back once it is old enough that the claim can't be one whose session
    is being made right now (`STALL_SECONDS`, the same clock that says nothing has touched a hold).
    No wake here: this runs inside a sweep.
    """
    given_back: List[Dict[str, Any]] = []
    for hold in holds:
        task = hold.task
        if not isinstance(task, dict):
            continue
        if not hold.session_id:
            # A claim this young may be one whose session is being made right now.
            if isinstance(hold.claimed_at, (int, float)) and (
                time.time() - hold.claimed_at < STALL_SECONDS
            ):
                continue
        elif not chats.closed(chats.one(db_path(hermes_home), hold.session_id)):
            continue
        release(hermes_home, project_id, task, holds)
        given_back.append(task)
    return given_back


def _same_task(found: Any, held: Dict[str, Any]) -> bool:
    """Whether a row is holding this task: its repository and number, which no two tasks share."""
    return isinstance(found, dict) and _key(found) == _key(held)


def _key(task: Any) -> Tuple[Any, Any]:
    """A task's identity, as the holds table keys it: its repository and its issue number."""
    found = task if isinstance(task, dict) else {}
    return (found.get("repo"), found.get("number"))


def _refuse(hermes_home: Path, project_id: str, why: str) -> None:
    """Records why GitHub refused the sweep, which the app's sheet shows under the switch."""
    _update(hermes_home, project_id, refusal=why, refused_at=int(time.time()))


def _clear_refusal(hermes_home: Path, project_id: str) -> None:
    _update(hermes_home, project_id, refusal=None, refused_at=None)


def _forget_refusal(hermes_home: Path, project_id: str, found: Dict[str, Any]) -> None:
    """Clears a refusal the row holds, when the sweep has something else to say instead."""
    if found["refusal"] is not None:
        _clear_refusal(hermes_home, project_id)


def _row(hermes_home: Path, project_id: str) -> Optional[Dict[str, Any]]:
    """The project's AFK row, read once: its switch, what it works with, and the tasks it holds.

    ``task`` is the oldest hold's — the one the sheet's single Working row draws — and ``holds`` the
    whole list, oldest first; a project holding nothing answers None and an empty list.
    """
    conn = connect(db_path(hermes_home))
    try:
        row = conn.execute(
            """SELECT enabled, refusal, build_skill, critique_skills, workflow_id, prompt,
                      pick_count, prompt_id
               FROM project_afk WHERE project_id = ?""",
            (project_id,),
        ).fetchone()
        holds = _read_holds(conn, project_id) if row is not None else []
    finally:
        conn.close()
    if row is None:
        return None
    return {
        "on": bool(row[0]),
        "holds": holds,
        "task": holds[0].task if holds else None,
        "refusal": row[1] if isinstance(row[1], str) and row[1] else None,
        # The two skill columns are only read to migrate a row written before the workflow picker;
        # nothing answers them.
        "build_skill": pipeline.text(row[2]),
        "critique_skills": pipeline.names(_column(row[3], list)),
        "workflow_id": row[4] if isinstance(row[4], str) and row[4] else None,
        "prompt": pipeline.text(row[5]),
        "pick_count": row[6],
        "prompt_id": row[7] if isinstance(row[7], str) and row[7] else None,
    }


def _column(value: Any, kind: type) -> Any:
    """The JSON a column holds when it is a `kind`, else None: a row written before the column, or by
    hand, reads as nothing rather than failing the sheet."""
    if not isinstance(value, str) or not value:
        return None
    try:
        found = json.loads(value)
    except ValueError:
        return None
    return found if isinstance(found, kind) else None


def _list(value: Any) -> List[Any]:
    return _column(value, list) or []


class Hold(NamedTuple):
    """One claimed task: the task itself, the session working it, and its own stall clock."""

    project_id: str
    task: Dict[str, Any]
    session_id: Optional[str]
    stalled: Optional[str]
    claimed_at: Optional[int]
    stalled_at: Optional[int]


# What a hold's row is read as, in the order the answers below select it.
HOLD_FIELDS = "project_id, task, session_id, stalled, claimed_at, stalled_at"
# Oldest first: the task's own creation time on GitHub, with the issue number breaking a tie, so the
# first hold is the task AFK has waited longest for.
HOLD_ORDER = "created_at, number"
# The one key a hold has — its project and its task — so every write names the same row.
HOLD_COLUMNS = ("project_id", "repo", "number")
HOLD_KEY = " AND ".join(f"{column} = ?" for column in HOLD_COLUMNS)


def _holds(
    hermes_home: Path,
    project_id: Optional[str] = None,
    session_id: Optional[str] = None,
) -> List[Hold]:
    """The rows one project holds, one session works, or every project holds — oldest first.

    One look at the store answers all three: a sheet asks for a project's holds, a sweep for every
    project's — whatever their switches say, since a project switched off mid-run still has a claim
    on GitHub that nothing else would ever look at again — and a hook for the one its session works.
    """
    conn = connect(db_path(hermes_home))
    try:
        return _read_holds(conn, project_id, session_id)
    finally:
        conn.close()


def _hold_for_session(hermes_home: Path, session_id: str) -> Optional[Hold]:
    """The hold this session is working, or None when AFK isn't holding it — the one read a hook
    needs to know whose task a run's end is.
    """
    return next(iter(_holds(hermes_home, session_id=session_id)), None)


def _read_holds(
    conn: sqlite3.Connection,
    project_id: Optional[str] = None,
    session_id: Optional[str] = None,
) -> List[Hold]:
    """A connection's holds, oldest first: one project's, one session's, or every project's."""
    narrows: List[str] = []
    values: List[Any] = []
    if project_id is not None:
        narrows.append("project_id = ?")
        values.append(project_id)
    if session_id is not None:
        narrows.append("session_id = ?")
        values.append(session_id)
    where = f"WHERE {' AND '.join(narrows)} " if narrows else ""
    order = f"project_id, {HOLD_ORDER}" if project_id is None else HOLD_ORDER
    rows = conn.execute(
        f"SELECT {HOLD_FIELDS} FROM holds {where}ORDER BY {order}", values
    ).fetchall()
    return [_as_hold(row) for row in rows]


def _as_hold(row: Any) -> Hold:
    """One holds row as a `Hold`: the task JSON parsed, and nothing a column can't say."""
    return Hold(
        str(row[0]),
        _task(row[1]) or {},
        row[2] if isinstance(row[2], str) and row[2] else None,
        row[3] if isinstance(row[3], str) and row[3] else None,
        int(row[4]) if isinstance(row[4], (int, float)) else None,
        int(row[5]) if isinstance(row[5], (int, float)) else None,
    )


def _task(value: Any) -> Optional[Dict[str, Any]]:
    """The task a row's JSON column holds, or None when it holds nothing a sheet can show."""
    return _column(value, dict)


def _upsert(hermes_home: Path, project_id: str, **fields: Any) -> None:
    """Writes the named columns of the project's row, making the row where the project has none.

    One statement for every writer, so a column is never added to an insert and forgotten in an
    update. Nothing a caller doesn't name is touched, so the switch and the skills leave each other
    alone; a fresh row starts switched off.
    """
    row = {"enabled": 0, **fields}
    columns = ", ".join(row)
    placeholders = ", ".join("?" for _ in row)
    assignments = ", ".join(f"{name} = excluded.{name}" for name in fields)
    conn = connect(db_path(hermes_home))
    try:
        conn.execute(
            f"""INSERT INTO project_afk (project_id, {columns}) VALUES (?, {placeholders})
                ON CONFLICT(project_id) DO UPDATE SET {assignments}""",
            (project_id, *row.values()),
        )
    finally:
        conn.close()


def _update(hermes_home: Path, project_id: str, **fields: Any) -> None:
    """Writes the named fields of the project's AFK row; a project with no row stays without one."""
    assignments = ", ".join(f"{name} = ?" for name in fields)
    conn = connect(db_path(hermes_home))
    try:
        cursor = conn.execute(
            f"UPDATE project_afk SET {assignments} WHERE project_id = ?",
            (*fields.values(), project_id),
        )
        if cursor.rowcount == 0:
            # The project's row went away under the sweep (removed, or forgotten with the project).
            logger.warning("memento: AFK had no row for project %s to record", project_id)
    finally:
        conn.close()


def _write(hermes_home: Path, project_id: str, on: bool) -> None:
    _upsert(hermes_home, project_id, enabled=1 if on else 0, at=int(time.time()))
