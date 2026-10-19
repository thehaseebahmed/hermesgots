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

The skills its work follows are the project's too: one to build by and the ones to critique, kept on
the same row as the switch (`set_skills`) and read back with it, so the sweep has them on the host
with the app closed. The list they are picked from is the profile's live skills
(`skill_catalog.read`); nothing here decides what a chosen skill does to a run.
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

from . import chats, github, prompt_builder, sessions, tasks
from .store import connect, db_path

logger = logging.getLogger(__name__)

NO_REPOSITORY = "This project has no repository."
NO_GITHUB = "No GitHub account on the server."
# The same words the plugin already refuses an archived project a turn with (sessions._blocked).
ARCHIVED = "This project is archived."

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
    }


def skills_from(body: Dict[str, Any]) -> Tuple[Optional[str], List[str]]:
    """The skills a write names, read from its body, or ``ValueError`` saying what's wrong.

    Both fields or neither: the sheet writes the two pickers together, so a body naming one leaves
    the other's meaning to a guess. The names are the profile's as the pickers read them; whether
    they are still skills is the sweep's question, not this write's, so a name the profile has since
    lost is kept as the project's choice and refused where a task would be claimed (#323).
    """
    if "build_skill" not in body or "critique_skills" not in body:
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


def set_skills(
    hermes_home: Path,
    project_id: str,
    build_skill: Optional[str],
    critique_skills: Iterable[str],
) -> None:
    """Keeps the skills this project's AFK work follows: one to build by, and the ones to critique.

    Written on the project's own row, beside the switch and not on the device that picked them: the
    sweep reads them on the host with the app closed, and they belong to that project alone. A
    project with no row yet gets one with its switch off — the pickers sit under the switch, not
    behind it, so choosing a skill is no reason to start working anything. Turning the switch on or
    off writes its own columns only, so a choice outlives both.
    """
    names = _names(critique_skills)
    conn = connect(db_path(hermes_home))
    try:
        conn.execute(
            """INSERT INTO project_afk (project_id, enabled, at, build_skill, critique_skills)
               VALUES (?, 0, ?, ?, ?)
               ON CONFLICT(project_id) DO UPDATE SET
                   build_skill = excluded.build_skill,
                   critique_skills = excluded.critique_skills,
                   at = excluded.at""",
            (project_id, int(time.time()), _name(build_skill), json.dumps(names)),
        )
    finally:
        conn.close()


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
    hermes_home: Path, project_id: str, folders: Iterable[Any], archived: bool = False
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
    from . import link, outbox

    profile = link.profile_name(hermes_home)
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
        started = await outbox.post(
            adapter,
            profile,
            "/v1/runs",
            run_body(record, task),
            authorization=_authorization(hermes_home),
        )
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

    A run that finished hands the project its next task: its claim stays on GitHub, because the task
    is in review, but the hold is what one task at a time is, so it goes and the sweep is asked to
    look now. A run that stopped any other way is left exactly as it is — the session, its
    transcript and its claim — and records why nothing is working the task (a failure, an
    interruption, or no reason at all), so the app shows the session where it shows a wait (ADR
    0015). Only a session AFK is holding is its own: every other project session just wakes the
    sweep, and a chat's turn says nothing about any work.
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
        if project_id is not None:
            if not stopped.finished:
                _stall(home, project_id, _stopped(stopped))
                return
            _free(home, project_id)
        wake()
    except Exception:
        logger.debug("memento: couldn't wake AFK's sweep", exc_info=True)


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
    """The project's AFK row, read once: its switch, the task it holds, its last refusal, the session
    working that task, why it stalled, since when it was claimed, and the skills its work follows.
    """
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
        "build_skill": _name(row[6]),
        "critique_skills": _names(_list(row[7])),
    }


def _name(value: Any) -> Optional[str]:
    """A skill's name as the pickers write it, or None: a blank name is no choice at all."""
    if not isinstance(value, str):
        return None
    return value.strip() or None


def _names(values: Iterable[Any]) -> List[str]:
    """The names a choice holds, trimmed, without blanks and each once, in the order they were given.

    Order is the user's: the critique's delegates follow the skills in the order the row holds them,
    so a set would hand that back in an order nobody picked.
    """
    found: List[str] = []
    for value in values:
        name = _name(value)
        if name is not None and name not in found:
            found.append(name)
    return found


def _list(value: Any) -> List[Any]:
    """The JSON list a column holds, or none: a row written before the column, or by hand, reads as
    no choice rather than failing the sheet."""
    if not isinstance(value, str) or not value:
        return []
    try:
        found = json.loads(value)
    except ValueError:
        return []
    return found if isinstance(found, list) else []


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
    if not isinstance(value, str) or not value:
        return None
    try:
        found = json.loads(value)
    except ValueError:
        return None
    return found if isinstance(found, dict) else None


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
    conn = connect(db_path(hermes_home))
    try:
        # The switch's own columns only: the task it holds and the last refusal are the sweep's, and
        # the skills its work follows are the pickers' (`set_skills`) — turning it on or off leaves
        # both alone.
        conn.execute(
            """INSERT INTO project_afk (project_id, enabled, at) VALUES (?, ?, ?)
               ON CONFLICT(project_id) DO UPDATE SET enabled = excluded.enabled, at = excluded.at""",
            (project_id, 1 if on else 0, int(time.time())),
        )
    finally:
        conn.close()
