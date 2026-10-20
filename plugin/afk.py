"""AFK: a project's switch for working its own tasks, the sweep that claims one, and its state.

The switch answers one question — is this project left to work its own tasks — and it lives in the
plugin's store rather than on the device that flipped it, because the sweep that works those tasks
runs on the host with the app closed. So the state is read back from the host, per project, and a
project's switch never touches another's.

The sweep reads the project's frontier from GitHub and takes the oldest ready task: assigned to the
host's account and marked with Gots's claim label, created on the repository the first time it's
used (ADR 0012). One task per project at a time — while one is held the sweep has nothing to do —
and a GitHub refusal stops it, leaves the switch on and records the reason the app's sheet shows,
rather than asking again in a loop.

The task it takes is worked in a session of its own, made the way the app's workspace route makes
one (`sessions.ensure`: its own worktree, branch and row, in Auto), and the chat record that makes
that session appear and open in the app is written here (ADR 0013) — the Code list hides a session
nothing was sent in, and the app has no conversation for one it didn't make. The run then starts
from this plugin: `prompt_builder.afk_prompt` is its instructions — how to work an issue that was
planned before the user left, with nobody to ask — and its input is one line naming the issue and
where it is. Its own text is deliberately not copied into either: the agent fetches the issue, so
the brief can't go stale and the prompt is the same tokens every turn. It carries no model, so the
host's own runs.

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
from pathlib import Path
from typing import Any, Dict, Iterable, List, NamedTuple, Optional, Tuple

from . import chats, github, pipeline, prompt_builder, sessions, ship, tasks
from .store import connect, db_path

logger = logging.getLogger(__name__)

NO_REPOSITORY = "This project has no repository."
NO_GITHUB = "No GitHub account on the server."
# The same words the plugin already refuses an archived project a turn with (sessions._blocked).
ARCHIVED = "This project is archived."
# A skill the project picked that its bot no longer has: the sweep records it and claims nothing.
MISSING_SKILL = (
    'The skill "{name}" isn\'t one this bot has any more, so no task is claimed. '
    "Pick another in AFK's settings."
)
CRITIQUE_FAILED = "The critique couldn't start."

# How often a project left on is swept for work. A GitHub refusal ends that sweep and the next one
# waits for its turn rather than asking again at once.
SWEEP_SECONDS = 180
HELD = ("repo", "number", "title", "url", "created_at")
# How long a claim may sit with nothing running it before the app is told it stalled. A start makes
# the session's worktrees first, which can take a while on a big repository, so a claim just taken is
# given that much room; a run that ends says why at once.
STALL_SECONDS = 300
DEFAULT_STALL = "AFK stopped before the task was finished."
FAILED_RUN = "The run failed."
INTERRUPTED_RUN = "The run was interrupted."

_loop: Optional[asyncio.AbstractEventLoop] = None
_event: Optional["asyncio.Event"] = None


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
    """Drops a project's switch: the project's record is gone, so there is nothing to leave off."""
    conn = connect(db_path(hermes_home))
    try:
        conn.execute("DELETE FROM project_afk WHERE project_id = ?", (project_id,))
    finally:
        conn.close()


def read(
    hermes_home: Path, project_id: str, folders: Iterable[Any], archived: bool = False
) -> Dict[str, Any]:
    """Everything the app's sheet shows: the switch and its reason, the task held, the last refusal,
    and the skills this project's work follows.

    An archived project is turned off here if anything had left it on, and reads off whatever
    happens: it was put away, so its switch isn't a setting anything acts on. Writing it off rather
    than only masking it is what keeps a restore from resuming work no one asked for — a project
    archived where this plugin didn't do it (Hermes's own dashboard or CLI) still has its old row.
    """
    found = _row(hermes_home, project_id) or {
        "on": False,
        "task": None,
        "refusal": None,
        "build_skill": None,
        "critique_skills": [],
    }
    why = reason(hermes_home, folders, archived)
    on = found["on"]
    if on and why == ARCHIVED:
        turn_off(hermes_home, project_id)
        on = False
    return {
        "on": on,
        "reason": why,
        "task": found["task"],
        "refusal": found["refusal"],
        "build_skill": found["build_skill"],
        "critique_skills": found["critique_skills"],
        # The stage the task it holds is in, for the sheet's Working row (ADR 0018): None for a
        # project holding nothing, and for a task that isn't staged.
        "stage": _held_stage(hermes_home, found),
    }


def _held_stage(hermes_home: Path, found: Dict[str, Any]) -> Optional[str]:
    """The stage the task a project holds is in, read off the record of the session working it.

    Only while it holds one: the stage outlives the hold on the session's own row — so a finished
    task can still say how it got there — but nothing in the sheet names a task it isn't working,
    and the strip that reads a finished one is its own change (#319). A store that can't be read
    answers no stage rather than failing the sheet.
    """
    session_id = found.get("session_id")
    if not found.get("task") or not session_id:
        return None
    try:
        stored = sessions.pipeline_of(db_path(hermes_home), session_id)
    except Exception:
        logger.debug("memento: couldn't read the stage of %s", session_id, exc_info=True)
        return None
    return pipeline.stage(pipeline.read(stored))


SKILL_FIELDS = ("build_skill", "critique_skills")


def skills_from(body: Dict[str, Any]) -> Tuple[Optional[str], List[str]]:
    """The skills a write names, or ``ValueError`` saying what's wrong.

    Both fields or neither: the sheet writes the two pickers together, so a body naming one leaves
    the other's meaning to a guess.
    """
    if any(field not in body for field in SKILL_FIELDS):
        raise ValueError("A skills write names build_skill and critique_skills.")
    build_skill = body["build_skill"]
    if build_skill is not None and not isinstance(build_skill, str):
        raise ValueError("build_skill must be a skill's name or null.")
    critique_skills = body["critique_skills"]
    if not isinstance(critique_skills, list) or not all(
        isinstance(name, str) for name in critique_skills
    ):
        raise ValueError("critique_skills must be a list of skill names.")
    return build_skill, critique_skills


def write_from(body: Dict[str, Any]) -> Tuple[str, Any]:
    """What a write names — ``"on"`` with its flag, or ``"skills"`` with the pair — or ValueError.

    One write, one shape: the skills land before the switch wakes the sweep, so a body naming both
    could write the choice and then be refused, leaving half of it written.
    """
    switch = "on" in body
    choosing = any(field in body for field in SKILL_FIELDS)
    if switch and choosing:
        raise ValueError("A write names either on or the skills, not both.")
    if switch:
        on = body["on"]
        if not isinstance(on, bool):
            raise ValueError("on must be true or false.")
        return "on", on
    if choosing:
        return "skills", skills_from(body)
    raise ValueError("on, build_skill or critique_skills is needed.")


def set_skills(
    hermes_home: Path,
    project_id: str,
    build_skill: Optional[str],
    critique_skills: Iterable[str],
) -> None:
    """Keeps the skills this project's AFK work follows, on the project's row beside the switch.

    A project with no row yet gets one with its switch off: the pickers sit under the switch, not
    behind it, so choosing a skill is no reason to start working anything.
    """
    _upsert(
        hermes_home,
        project_id,
        build_skill=pipeline.text(build_skill),
        critique_skills=json.dumps(pipeline.names(critique_skills)),
        at=int(time.time()),
    )


def release(
    hermes_home: Path, project_id: str, task: Optional[Dict[str, Any]] = None
) -> None:
    """Gives a claimed task back: the mark and the assignment come off GitHub, the project lets go.

    ``task`` is the row's own unless the caller names one, and the hold is only dropped for the task
    the row is actually holding: a session the user closes names the task its own record carries,
    which the row may have let go of already — when its run finished and the sweep took the next one
    — and that newer hold is not a closed session's to clear. A GitHub refusal is recorded for the
    sheet, and the hold goes anyway: nothing on the host is working the task either way, and the next
    sweep's read is what says whether it is back in the frontier.
    """
    found = _row(hermes_home, project_id)
    held = task if task is not None else (found["task"] if found else None)
    if held is None:
        return
    row_holds_this_task = found is not None and _same_task(found["task"], held)
    auth, _ = github.token(hermes_home)
    if auth:
        try:
            github.release_claim(str(held["repo"]), int(held["number"]), tasks.CLAIM_LABEL, auth)
        except (github.GitHubError, KeyError, TypeError, ValueError) as error:
            logger.warning("memento: couldn't release %s on GitHub", held, exc_info=True)
            if row_holds_this_task:
                _refuse(hermes_home, project_id, str(error))
    if row_holds_this_task:
        _free(hermes_home, project_id)


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
        return next(
            (hold.project_id for hold in _holding_rows(hermes_home) if hold.session_id == session_id),
            None,
        )
    except (sqlite3.Error, OSError):
        logger.warning("memento: couldn't read AFK's hold for %s", session_id, exc_info=True)
        return None


def stalled(
    hermes_home: Path, live: Optional[Dict[str, str]] = None
) -> Dict[str, Dict[str, Any]]:
    """AFK sessions nothing is working, by Hermes session id, with the reason they wait on the user.

    A project still holding a task whose session has no run in flight is one the user has to look
    at: its run failed, or the host restarted while it worked and the session was adopted rather than
    restarted or doubled. Either way it is where waiting sessions appear, naming the project like the
    rest, and never beside a live run — a run in flight is what working it looks like.
    """
    found: Dict[str, Dict[str, Any]] = {}
    now = time.time()
    waiting: List[Hold] = []
    for hold in _holding_rows(hermes_home):
        if not hold.session_id or (live and hold.session_id in live):
            continue
        if (
            not hold.stalled_reason
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
            "reason": hold.stalled_reason or DEFAULT_STALL,
        }
        if names.get(hold.project_id):
            reason["project"] = names[hold.project_id]
        found[hold.session_id] = reason
    return found


def sweep(
    hermes_home: Path,
    project_id: str,
    folders: Iterable[Any],
    archived: bool = False,
    *,
    skills: Optional[Iterable[str]],
) -> Optional[Dict[str, Any]]:
    """Claims the oldest ready task for a project left to work, if it isn't holding one.

    Answers the task it just claimed, so the caller starts the session that works it without a
    second read, and None when it claimed nothing. One task at a time per project, and a hold is
    settled whether or not the project is still switched on, because the claim is on GitHub either
    way and the switch is only what decides whether a *new* task is taken. A project holding a task
    claims nothing in this pass, even when it has just given one back: the task the user closed its
    session to be rid of waits for the next sweep, so it isn't handed out again the moment they walk
    away from it. A GitHub refusal — no permission to write issues, a rate limit, no connection —
    records its reason and stops this sweep with the switch left on, so the sheet says why; the next
    sweep is the next attempt, not an immediate one.

    ``skills`` is the names the profile can run, read once for a whole sweep; a project whose chosen
    build or critique skill isn't among them claims nothing and records why, with its switch still
    on, so a choice the user forgot about is visible instead of silently working around it (ADR
    0018). It is the caller's to pass, and not defaulted: a sweep that judges no choice has to say
    so, since a forgotten argument would quietly turn the check off.
    """
    found = _row(hermes_home, project_id)
    if found is None:
        return None
    if found["task"] is not None:
        _settle(hermes_home, project_id, found)
        return None
    if not found["on"]:
        return None
    why = reason(hermes_home, folders, archived)
    if why is not None:
        # Put away, with no repository to read, or no account to read it with: the sheet's own
        # reason already says so, and it isn't GitHub refusing anything — so a refusal it recorded
        # before would sit beside that reason saying something GitHub no longer says.
        _forget_refusal(hermes_home, project_id, found)
        return None
    if skills is not None:
        missing = _missing_skill(found, skills)
        if missing is not None:
            _refuse(hermes_home, project_id, MISSING_SKILL.format(name=missing))
            return None
    auth, _ = github.token(hermes_home)
    try:
        answers = tasks.read(hermes_home, folders)
    except github.GitHubError as error:
        _refuse(hermes_home, project_id, str(error))
        return None
    ready = answers.get("ready") or []
    if not ready:
        # GitHub answered and has nothing to give: whatever it refused before is stale.
        _forget_refusal(hermes_home, project_id, found)
        return None
    task = ready[0]
    try:
        github.claim_issue(
            task["repo"], task["number"], github.login(auth), tasks.CLAIM_LABEL, auth
        )
    except github.GitHubError as error:
        _refuse(hermes_home, project_id, str(error))
        return None
    # The hold clears the last refusal in the same write: this sweep just got an answer.
    _hold(hermes_home, project_id, task)
    return task


def new_session_id() -> str:
    return f"{sessions.MEMENTO_ID_PREFIX}afk-{uuid.uuid4().hex[:12]}"


def session_title(task: Dict[str, Any]) -> str:
    return f"#{task.get('number')} {task.get('title') or ''}".strip()


def run_body(record: Dict[str, Any], task: Dict[str, Any]) -> Dict[str, Any]:
    """The ``POST /v1/runs`` request: how to work a planned issue, and the issue's name as the input.

    The prompt is all `prompt_builder`'s — one module holds every word the agent is told — and the
    issue's own text is left out of both: the agent reads it from GitHub.
    """
    return {
        "session_id": record["session_id"],
        "instructions": prompt_builder.afk_prompt(record, task),
        "input": [{"role": "user", "content": prompt_builder.afk_input(task)}],
    }


def critique_body(record: Dict[str, Any], task: Dict[str, Any]) -> Dict[str, Any]:
    """The second run's request: the same session, reviewing the build and opening the pull request.

    The base branch is read from the worktree's own origin, so the critique hands it to its
    delegates rather than each of them guessing which branch the change is against.
    """
    return {
        "session_id": record["session_id"],
        "instructions": prompt_builder.critique_prompt(record, task, base_branch(record)),
        "input": [{"role": "user", "content": prompt_builder.critique_input(task)}],
    }


def base_branch(record: Dict[str, Any]) -> Optional[str]:
    """The branch this session's work is against: its primary worktree's base."""
    from . import projects

    primary = next((repo.get("path") for repo in record.get("repos") or []), None)
    return projects._base_branch(primary) if primary else None


def _begin(
    hermes_home: Path, path: Path, project_id: str, session_id: str
) -> Optional[Dict[str, Any]]:
    """Writes the pipeline a staged task starts with, answering it as the run's record carries it.

    None for a project with no critique skill: that task is one run which ships, exactly as it was
    before there were stages (ADR 0018). Written before the run is posted, so the build's own
    instructions already know where they end.
    """
    found = _row(hermes_home, project_id) or {}
    staged = pipeline.start(found.get("build_skill"), found.get("critique_skills") or [])
    sessions.set_pipeline(path, session_id, staged)
    return staged


def publish(
    hermes_home: Path, session_id: str, project_id: str, task: Dict[str, Any]
) -> Dict[str, Any]:
    """Writes the chat record that makes the session appear and open in the app (ADR 0013).

    Its ``updatedAt`` is newer than its ``createdAt``, because the Code list hides a session nothing
    was sent in by exactly that rule; the record is keyed by the session id, so a device has one id
    for it. It is written once, here: the chat list is last-write-wins, so a title the user edits, a
    mode they change or a resolve they make afterwards has to win.
    """
    sessions.set_task(db_path(hermes_home), session_id, task)
    now = int(time.time() * 1000)
    value = {
        "title": session_title(task),
        "hermesSessionId": session_id,
        "createdAt": now,
        "updatedAt": now + 1,
        "projectId": project_id,
        "mode": "auto",
        "afk": True,
    }
    chats.merge(db_path(hermes_home), {session_id: {"at": now + 1, "value": value}})
    return value


async def start(
    adapter: Any, hermes_home: Path, project_id: str, task: Dict[str, Any]
) -> None:
    """Works a claimed task in a session of its own: its worktree, its run, its chat record.

    The task is already claimed by the sweep, and it's named to the run rather than read: the agent
    fetches the issue itself, so the claim stays the fast path and the brief is never a stale copy of
    what the tracker says. The record is written only once the run is under way: a session the app
    shows with no run behind it is worse than one it never hears about. A start that never gets its
    run away gives the claim back (ADR 0015): nothing began the work, so the task returns to the
    frontier instead of sitting claimed with no session to show for it.
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
        await asyncio.to_thread(release, hermes_home, project_id)
        return
    try:
        await asyncio.to_thread(_adopt, hermes_home, project_id, session_id)
        sessions.apply_cwd(session_id, record["path"])
        staged = await asyncio.to_thread(
            _begin, hermes_home, db_path(hermes_home), project_id, session_id
        )
        record = {**record, "pipeline": staged}
        started = await _post(adapter, hermes_home, run_body(record, task))
    except Exception as error:
        logger.warning("memento: AFK couldn't start the session for %s: %s", issue, error)
        await asyncio.to_thread(release, hermes_home, project_id)
        return
    try:
        await asyncio.to_thread(publish, hermes_home, session_id, project_id, task)
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
        authorization=_authorization(hermes_home),
    )


def _authorization(hermes_home: Path) -> Optional[str]:
    """The key this home's runs are posted with, or None to let ``outbox`` resolve its own.

    Read from the home's own ``.env``, the same read ``link.record`` publishes a bot's key from,
    rather than through Hermes's credential helper: AFK runs from the gateway's loop, where no
    request's profile scope is set, so the helper would answer the launch profile's key for every
    home a multiplexed process serves.
    """
    from . import link

    key = link.env_value(hermes_home, "API_SERVER_KEY")
    return f"Bearer {key}" if key else None


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
    hold still has to be settled when the user closes the session, or the claim sits on GitHub with
    nothing working it and nothing ever looking again.

    Answers what each project just claimed, so the caller can start those sessions; a project that
    claimed nothing isn't in the list.
    """
    claimed: List[Tuple[str, Dict[str, Any]]] = []
    held = [hold.project_id for hold in _holding_rows(hermes_home)]
    due = list(dict.fromkeys([*enabled_projects(hermes_home), *held]))
    if not due:
        return claimed
    # One read of the project list, not one per project: a sweep only needs their folders.
    projects = sessions.projects(hermes_home / "projects.db")
    # And one of the skills this bot can run, for every project's choice: a skill the profile no
    # longer has stops that project's sweep (ADR 0018), and a host that can't list its skills
    # judges nothing. Read only when a project has picked one to judge.
    skills = _profile_skills(hermes_home) if _any_staged(hermes_home) else None
    for project_id in due:
        project = projects.get(project_id)
        if project is None:
            # A row whose project is gone.
            continue
        try:
            task = sweep(
                hermes_home,
                project_id,
                project.folders,
                bool(getattr(project, "archived", False)),
                skills=skills,
            )
        except Exception:
            logger.warning("memento: couldn't sweep AFK's project %s", project_id, exc_info=True)
            continue
        if task is not None:
            claimed.append((project_id, task))
    return claimed


async def sweep_homes(adapter: Any) -> None:
    """Sweeps every home this process serves, and starts the session for what each just claimed.

    Not just its own home: a /p/<profile> bot keeps its own store. One home's trouble is that
    home's, so a store it can't read must not stop the rest. A session is started here, on the loop,
    because starting a run is the API server's own call and this is the thread it's reached from.
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

    while True:
        try:
            await sweep_homes(adapter)
        except Exception:
            logger.warning("memento: AFK's sweep failed", exc_info=True)
        try:
            await asyncio.wait_for(_event.wait(), SWEEP_SECONDS)
        except asyncio.TimeoutError:
            pass
        _event.clear()


def wake() -> None:
    """Asks the sweep to look now — a project was turned on, or a session finished — from any thread."""
    loop, event = _loop, _event
    if loop is None or event is None:
        return
    try:
        loop.call_soon_threadsafe(event.set)
    except RuntimeError:
        pass


def after_run(
    session_id: Any = None,
    completed: bool = False,
    failed: bool = False,
    interrupted: bool = False,
    **_kwargs: Any,
) -> None:
    """The ``on_session_end`` hook: AFK's own task finished, or nothing is working it any more.

    A run that finished hands the project its next task: its claim stays on GitHub, because the
    task is in review, but the hold is what one task at a time is, so it goes and the sweep is asked
    to look now. A run that stopped any other way is left exactly as it is — the session, its
    transcript and its claim — and records why nothing is working the task (a failure, an
    interruption, or no reason at all), so the app shows the session where it shows a wait (ADR
    0015). Only a session AFK is holding is its own: every other project session just wakes the
    sweep, and a chat's turn says nothing about any work.

    A staged task's run end is its stage's business instead (ADR 0018): a build that finished is
    judged by its gate, which either starts the critique on the same session or stalls the task
    where it stands, and a critique that finished is the end of the pipeline.
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
        if project_id is not None:
            if staged is not None:
                _stage_end(home, path, project_id, record, staged, stopped)
                return
            if not stopped.finished:
                _stall(home, project_id, _stopped(stopped))
                return
            _free(home, project_id)
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
    """Settles a staged task whose run just ended: the gate's verdict, then the critique or a stall.

    The worktree is measured only for a build whose gate already passed: a gate that failed stalls
    the task in the stage it stopped in, and nothing about the tree can change that. The stage is
    written before anything is started, so a critique that can't be posted leaves a record that says
    where the task stands.
    """
    worktree: Iterable[Dict[str, Any]] = ()
    pre_gate = stopped.finished and pipeline.blocks_ship(staged)
    if pre_gate and pipeline.gate_verdict(staged) is None:
        worktree = ship.status(record)
    step = pipeline.advance(
        staged, stopped=None if stopped.finished else _stopped(stopped), worktree=worktree
    )
    moved = pipeline.moved(staged, step)
    sessions.set_pipeline(path, record["session_id"], moved)
    if step.stall:
        _stall(hermes_home, project_id, step.stall)
        return
    if step.next == pipeline.CRITIQUE:
        # The critique is the same session's next run: the hold keeps the task, and the stall
        # clock starts again so the moment between the two runs isn't read as nothing working it.
        _adopt(hermes_home, project_id, record["session_id"])
        # The record as the task stands now, not as the build left it: the critique's prompt reads
        # the stage off it, and handing it the build's would tell the reviewer it is building.
        _critique(hermes_home, {**record, "pipeline": moved})
        return
    _free(hermes_home, project_id)
    wake()


def _critique(hermes_home: Path, record: Dict[str, Any]) -> None:
    """Starts the critique run on the task's own session, on the loop that owns the runs.

    The hook runs in Hermes's own thread, so the run is posted there rather than awaited here. A
    run that can't be started stalls the task instead: nothing is reviewing it, and the claim is
    what the user finds it by.
    """
    project_id = str(record.get("project_id") or "")
    held = _row(hermes_home, project_id) if project_id else None
    task = (held or {}).get("task")
    loop = _loop
    if not isinstance(task, dict) or loop is None:
        logger.warning(
            "memento: AFK can't start the critique of %s (no task held or no loop)",
            record.get("session_id"),
        )
        if project_id:
            _stall(hermes_home, project_id, CRITIQUE_FAILED)
        return
    asyncio.run_coroutine_threadsafe(critique(sessions.adapter, hermes_home, record, task), loop)


async def critique(adapter: Any, hermes_home: Path, record: Dict[str, Any], task: Dict[str, Any]) -> None:
    """Posts the second run on the session: the build reviewed, and the pull request opened last."""
    issue = f"{task.get('repo')}#{task.get('number')}"
    try:
        started = await _post(adapter, hermes_home, critique_body(record, task))
    except Exception as error:
        logger.warning("memento: AFK couldn't start the critique for %s: %s", issue, error)
        project_id = str(record.get("project_id") or "")
        if project_id and holding_project(hermes_home, record["session_id"]) == project_id:
            _stall(hermes_home, project_id, CRITIQUE_FAILED)
        return
    logger.info(
        "memento: AFK is critiquing %s in %s (run %s)",
        issue,
        record["session_id"],
        started.get("run_id"),
    )


def _missing_skill(found: Dict[str, Any], skills: Iterable[str]) -> Optional[str]:
    """The first skill this project's next task would follow that its bot no longer has, if any.

    Only a staged task follows one: a project with no critique skill runs one task as it always has,
    which never names a build skill, so refusing there would stop work over a name that changes
    nothing about it (ADR 0018, and #327 leaves that path untouched). ``pipeline.start`` is what says
    which skills that task would follow, so this and the task itself can't disagree.
    """
    staged = pipeline.start(found.get("build_skill"), found.get("critique_skills") or [])
    if staged is None:
        return None
    known = set(skills)
    judged = [staged["build_skill"], *staged["critique_skills"]]
    return next((name for name in judged if name and name not in known), None)


def _any_staged(hermes_home: Path) -> bool:
    """Whether any project has picked a critique skill, so a sweep has choices worth reading.

    Reading the skill catalog walks a directory tree, and a sweep only needs it to judge a choice: a
    profile with nothing staged anywhere skips the walk on every home, every wake. A store that
    can't answer reads as yes, since a check that can't run is no reason to stop judging.
    """
    try:
        conn = connect(db_path(hermes_home))
        try:
            row = conn.execute(
                """SELECT 1 FROM project_afk
                   WHERE critique_skills IS NOT NULL AND critique_skills NOT IN ('', '[]') LIMIT 1"""
            ).fetchone()
        finally:
            conn.close()
    except Exception:
        logger.debug("memento: couldn't tell whether anything is staged", exc_info=True)
        return True
    return row is not None


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


def _hold(hermes_home: Path, project_id: str, task: Dict[str, Any]) -> None:
    """Records the task AFK holds, and clears any refusal: the sweep just succeeded."""
    row = {key: task.get(key) for key in HELD}
    _update(
        hermes_home,
        project_id,
        task=json.dumps(row),
        claimed_at=int(time.time()),
        refusal=None,
        refused_at=None,
        session_id=None,
        stalled=None,
        stalled_at=None,
    )


def _adopt(hermes_home: Path, project_id: str, session_id: str) -> None:
    """Names the session working the held task, so a restart adopts that one and nothing else.

    Written before the run is posted, so a run that ends at once still finds the project holding its
    session, and cleared only when the task is finished or given back. It also restarts the clock a
    stalled claim is measured from.
    """
    _update(
        hermes_home,
        project_id,
        session_id=session_id,
        claimed_at=int(time.time()),
        stalled=None,
        stalled_at=None,
    )


def _free(hermes_home: Path, project_id: str) -> None:
    """Lets go of the held task without giving the claim back: its work is in review on GitHub."""
    _update(
        hermes_home,
        project_id,
        task=None,
        session_id=None,
        claimed_at=None,
        stalled=None,
        stalled_at=None,
    )


def _stall(hermes_home: Path, project_id: str, why: str) -> None:
    """Records why nothing is working the held task, which the app shows where a wait is shown."""
    _update(hermes_home, project_id, stalled=why, stalled_at=int(time.time()))


def _settle(hermes_home: Path, project_id: str, found: Dict[str, Any]) -> None:
    """Lets go of a held task whose session the user closed.

    The user's own marks are what says a session's work is over: discarded, resolved, or deleted
    outright, read from the chat list rather than a route, so a session closed on any device — or
    while the host was away — still gives its task back.

    A hold that names no session is one nothing can be working: a row from before the column existed,
    or a start killed between the claim and its session. It goes back once it is old enough that the
    claim can't be one whose session is being made right now (`STALL_SECONDS`, the same clock that
    says nothing has touched a hold). No wake here: this runs inside a sweep.
    """
    task = found.get("task")
    session_id = found.get("session_id")
    if not isinstance(task, dict):
        return
    if not session_id:
        claimed_at = found.get("claimed_at")
        if isinstance(claimed_at, (int, float)) and time.time() - claimed_at < STALL_SECONDS:
            return
        release(hermes_home, project_id, task)
        return
    if chats.closed(chats.one(db_path(hermes_home), session_id)):
        release(hermes_home, project_id, task)


def _same_task(found: Any, held: Dict[str, Any]) -> bool:
    """Whether the row is holding this task: its repository and number, which no two tasks share."""
    return (
        isinstance(found, dict)
        and found.get("repo") == held.get("repo")
        and found.get("number") == held.get("number")
    )


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
    """The project's AFK row, read once: its switch, the task it holds and what is working it."""
    conn = connect(db_path(hermes_home))
    try:
        row = conn.execute(
            """SELECT enabled, task, refusal, session_id, stalled, claimed_at,
                      build_skill, critique_skills
               FROM project_afk WHERE project_id = ?""",
            (project_id,),
        ).fetchone()
    finally:
        conn.close()
    if row is None:
        return None
    return {
        "on": bool(row[0]),
        "task": _task(row[1]),
        "refusal": row[2] if isinstance(row[2], str) and row[2] else None,
        "session_id": row[3] if isinstance(row[3], str) and row[3] else None,
        "stalled": row[4] if isinstance(row[4], str) and row[4] else None,
        "claimed_at": int(row[5]) if isinstance(row[5], (int, float)) else None,
        "build_skill": pipeline.text(row[6]),
        "critique_skills": pipeline.names(_column(row[7], list)),
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
    """A project holding a task: the session working it, why it stalled, and since when."""

    project_id: str
    session_id: Optional[str]
    stalled_reason: Optional[str]
    claimed_at: Optional[int]


def _holding_rows(hermes_home: Path) -> List[Hold]:
    """Every project holding a task, whatever its switch says: a project switched off mid-run still
    has a claim on GitHub, and nothing else would ever look at it again.
    """
    conn = connect(db_path(hermes_home))
    try:
        rows = conn.execute(
            """SELECT project_id, session_id, stalled, claimed_at FROM project_afk
               WHERE task IS NOT NULL ORDER BY project_id"""
        ).fetchall()
    finally:
        conn.close()
    return [
        Hold(
            str(row[0]),
            str(row[1]) if isinstance(row[1], str) and row[1] else None,
            row[2] if isinstance(row[2], str) and row[2] else None,
            int(row[3]) if isinstance(row[3], (int, float)) else None,
        )
        for row in rows
    ]


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
