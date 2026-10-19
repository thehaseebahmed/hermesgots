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
import time
import uuid
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

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
    """Everything the app's sheet shows: the switch and its reason, the task held, the last refusal.

    An archived project is turned off here if anything had left it on, and reads off whatever
    happens: it was put away, so its switch isn't a setting anything acts on. Writing it off rather
    than only masking it is what keeps a restore from resuming work no one asked for — a project
    archived where this plugin didn't do it (Hermes's own dashboard or CLI) still has its old row.
    """
    found = _row(hermes_home, project_id) or {"on": False, "task": None, "refusal": None}
    why = reason(hermes_home, folders, archived)
    on = found["on"]
    if on and why == ARCHIVED:
        turn_off(hermes_home, project_id)
        on = False
    return {"on": on, "reason": why, "task": found["task"], "refusal": found["refusal"]}


def sweep(
    hermes_home: Path, project_id: str, folders: Iterable[Any], archived: bool = False
) -> Optional[Dict[str, Any]]:
    """Claims the oldest ready task for a project left to work, if it isn't holding one.

    Answers the task it just claimed, so the caller starts the session that works it without a
    second read, and None when it claimed nothing. One task per project at a time: while a task is
    held this does nothing, and the session that works it is what lets the next one be taken. A
    GitHub refusal — no permission to write issues, a rate limit, no connection — records its reason
    and stops this sweep with the switch left on, so the sheet says why; the next sweep is the next
    attempt, not an immediate one.
    """
    found = _row(hermes_home, project_id)
    if found is None or not found["on"]:
        return None
    if found["task"] is not None:
        # Already holding the task it took: the session that works it is what frees the next one.
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


def task_for_session(hermes_home: Path, session_id: str) -> Optional[Dict[str, Any]]:
    """The task a session of AFK's was started for, or None when the session isn't working one.

    The row names both, so a session's pull request can close the task it was given (ADR 0012)
    without the app having to tell the host anything: the session is the plugin's own, and the task
    it works is what the plugin claimed.
    """
    if not session_id:
        return None
    conn = connect(db_path(hermes_home))
    try:
        row = conn.execute(
            "SELECT task FROM project_afk WHERE session_id = ?", (session_id,)
        ).fetchone()
    finally:
        conn.close()
    return _task(row[0]) if row else None


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
    shows with no run behind it is worse than one it never hears about. A start that fails leaves
    the claim held, and its own ticket (#270) is what gives it back, so the same task is never
    worked twice.
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
        return
    sessions.apply_cwd(session_id, record["path"])
    try:
        started = await outbox.post(
            adapter,
            profile,
            "/v1/runs",
            run_body(record, task),
            authorization=_authorization(hermes_home),
        )
    except outbox.StartError as error:
        logger.warning("memento: AFK couldn't start the session for %s: %s", issue, error)
        return
    try:
        # Which session works which task, so its pull request can close the task (#269). Written
        # before the record is published: a run under way must name its task even if publishing
        # fails and the session is only found through the log.
        await asyncio.to_thread(_update, hermes_home, project_id, session_id=session_id)
    except Exception:
        logger.warning("memento: AFK couldn't name %s's session", issue, exc_info=True)
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
    """Sweeps every project left on; one project's trouble never stops another's.

    Answers what each project just claimed, so the caller can start those sessions; a project that
    claimed nothing isn't in the list.
    """
    claimed: List[Tuple[str, Dict[str, Any]]] = []
    left_on = enabled_projects(hermes_home)
    if not left_on:
        return claimed
    # One read of the project list, not one per project: a sweep only needs their folders.
    projects = sessions.projects(hermes_home / "projects.db")
    for project_id in left_on:
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


def after_run(session_id: Any = None, **_kwargs: Any) -> None:
    """The ``on_session_end`` hook: a project session finished, so AFK looks for the next task now.

    Only a project session is AFK's cue — a chat's turn says nothing about its work, and waking a
    sweep for every chat would read GitHub for nothing.
    """
    try:
        path, home = sessions._paths()
        if sessions.record_for(path, home, str(session_id or "")):
            wake()
    except Exception:
        logger.debug("memento: couldn't wake AFK's sweep", exc_info=True)


def _hold(hermes_home: Path, project_id: str, task: Dict[str, Any]) -> None:
    """Records the task AFK holds, and clears any refusal: the sweep just succeeded.

    The session working it is cleared too: it belongs to the hold before this one, and its pull
    request must never close the task now claimed.
    """
    row = {key: task.get(key) for key in HELD}
    _update(
        hermes_home,
        project_id,
        task=json.dumps(row),
        claimed_at=int(time.time()),
        session_id=None,
        refusal=None,
        refused_at=None,
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
    """The project's AFK row, read once: its switch, the task it holds and its last refusal."""
    conn = connect(db_path(hermes_home))
    try:
        row = conn.execute(
            "SELECT enabled, task, refusal FROM project_afk WHERE project_id = ?", (project_id,)
        ).fetchone()
    finally:
        conn.close()
    if row is None:
        return None
    return {
        "on": bool(row[0]),
        "task": _task(row[1]),
        "refusal": row[2] if isinstance(row[2], str) and row[2] else None,
    }


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
        # The switch's own columns only: the task it holds and the last refusal are the sweep's.
        conn.execute(
            """INSERT INTO project_afk (project_id, enabled, at) VALUES (?, ?, ?)
               ON CONFLICT(project_id) DO UPDATE SET enabled = excluded.enabled, at = excluded.at""",
            (project_id, 1 if on else 0, int(time.time())),
        )
    finally:
        conn.close()
