"""A bot's library of workflows, and the one a project's AFK work runs under.

A workflow is a name and an ordered list of stages; a stage is a name, the steps (skills) its run
applies in order, and optionally a check, a loop and the shipping mark. One rule over a whole
workflow decides what is acceptable — the same rule the app's editor calls before it saves — so the
editor and the host can never disagree about what a workflow is.

Three presets ship with the plugin and are seeded on the first read: One run, which is a single stage
that implements, gates itself and ships, and is what a project that picked no workflow reads as, since
one prompt run is the shape its work has (ADR 0027); Build · Test · Review · Summary, four runs from
a build to a wrap-up; and Build ⇄ Test · Review · Summary, which repeats the build and its test while
the gate fails. A preset is read-only: a write to one forks it into a copy with a new id and the name
the user gave it, so a preset body is never written and can be corrected in place when the plugin
version moves.

The library lives in the plugin's store rather than on the device, like the switch it drives: the
sweep that works the tasks runs on the host with the app closed. A project names one by id on its AFK
row, and deleting a workflow a project names is refused — naming those projects — so nothing is ever
silently switched to another workflow.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from .store import connect, db_path

logger = logging.getLogger(__name__)

MAX_STAGES = 12
MIN_CAP = 1
MAX_CAP = 10
# The gate is the only check there is: a stage the host answers itself, over the commands the build
# named.
GATE = "gate"
CHECKS = (GATE,)

# The preset a project that named nothing reads as. One prompt run is the shape its work has, so the
# picker has something true to show rather than a workflow nothing is running; picking a workflow is
# what puts a project back on stages (ADR 0027), and a project on a pick keeps its own.
DEFAULT_ID = "preset:one-run"
# The name a copy of a preset takes when the write names none.
COPY = "{name} (copy)"
# The name a workflow migrated from a project's old skill columns takes. It is the shape those
# columns described, so it says where it came from rather than pretending to be one of the presets.
MIGRATED = "From your skills"


class Refused(Exception):
    """A workflow that can't be deleted: its reason names the projects that work under it.

    Its own type, so a route answers the refusal it was given and nothing else — an error from the
    store is a fault, not the library's answer.
    """


def _stage(
    name: str,
    steps: Iterable[str] = (),
    check: Optional[str] = None,
    loop: Optional[Dict[str, Any]] = None,
    ships: bool = False,
) -> Dict[str, Any]:
    return {
        "name": name,
        "steps": list(steps),
        "check": check,
        "loop": dict(loop) if loop else None,
        "ships": ships,
    }


_BT = "Build"
_TEST = "Test"
_REVIEW = "Review"
_SUMMARY = "Summary"

# Seeded on first read, and refreshed in place by id when the plugin version moves: an id is what a
# project names, so it outlives any correction to the body.
PRESETS: Tuple[Tuple[str, str, List[Dict[str, Any]]], ...] = (
    ("preset:one-run", "One run", [_stage(_BT, ships=True)]),
    (
        "preset:staged",
        "Build · Test · Review · Summary",
        [
            _stage(_BT),
            _stage(_TEST, check=GATE),
            _stage(_REVIEW, ships=True),
            _stage(_SUMMARY),
        ],
    ),
    (
        "preset:loop",
        "Build ⇄ Test · Review · Summary",
        [
            _stage(_BT),
            _stage(_TEST, check=GATE, loop={"from": _BT, "cap": 3}),
            _stage(_REVIEW, ships=True),
            _stage(_SUMMARY),
        ],
    ),
)


def text(value: Any) -> Optional[str]:
    """One name as a workflow holds it: trimmed, and nothing for what isn't text."""
    if not isinstance(value, str):
        return None
    return value.strip() or None


def names(value: Any) -> List[str]:
    """The names a list holds, each once, in its own order.

    A bare string is no list — read one character at a time it would name eleven skills — and
    neither is a value that isn't a sequence at all.
    """
    if isinstance(value, (str, bytes)):
        return []
    try:
        found = list(value)
    except TypeError:
        return []
    return list(dict.fromkeys(name for name in (text(one) for one in found) if name))


def normalise(body: Any) -> Dict[str, Any]:
    """A workflow as the library holds it, or ``ValueError`` saying what's wrong with it.

    One rule over the whole workflow, called by the host's write and by the app's editor (which reads
    its messages), so the two cannot disagree. What can be cleaned is cleaned — a stage's name and
    its steps are trimmed, and a step named twice is one step — and what can't is refused: a workflow
    with no name or no stages, two stages sharing a name, more than twelve of them, a stage that
    names both steps and a check (it either runs its skills and ends, or the host answers it), a loop
    whose cap is outside 1–10 or that starts nowhere before the stage it ends on, and a count of
    shipping stages other than one.
    """
    if not isinstance(body, dict):
        raise ValueError("A workflow is a name and its stages.")
    name = text(body.get("name"))
    if not name:
        raise ValueError("A workflow needs a name.")
    raw = body.get("stages")
    if not isinstance(raw, list):
        raise ValueError("A workflow needs a list of stages.")
    if not raw:
        raise ValueError("A workflow needs at least one stage.")
    if len(raw) > MAX_STAGES:
        raise ValueError(f"A workflow holds at most {MAX_STAGES} stages.")
    stages: List[Dict[str, Any]] = []
    seen: Dict[str, int] = {}
    for one in raw:
        if not isinstance(one, dict):
            raise ValueError("A stage is a name, its steps and, if it has them, its check and loop.")
        stage_name = text(one.get("name"))
        if not stage_name:
            raise ValueError("A stage needs a name.")
        if stage_name in seen:
            raise ValueError(f'Two stages can\'t both be called "{stage_name}".')
        seen[stage_name] = len(stages)
        check = text(one.get("check"))
        if check is not None and check not in CHECKS:
            raise ValueError(f'A stage\'s check is "{GATE}", or nothing at all.')
        if check is not None and names(one.get("steps")):
            raise ValueError(
                f'"{stage_name}" names both steps and a check: a stage runs its skills or the host '
                "answers it, not both."
            )
        loop = _loop(one.get("loop"), stage_name)
        stages.append(
            _stage(
                stage_name,
                names(one.get("steps")),
                check=check,
                loop=loop,
                ships=bool(one.get("ships")),
            )
        )
    for stage in stages:
        start = (stage["loop"] or {}).get("from")
        if start is None:
            continue
        if start not in seen:
            raise ValueError(f'A loop on "{stage["name"]}" starts at "{start}", which is no stage.')
        if seen[start] >= seen[stage["name"]]:
            raise ValueError(f'A loop on "{stage["name"]}" has to start at a stage before it.')
    shipping = [stage for stage in stages if stage["ships"]]
    if len(shipping) != 1:
        raise ValueError("A workflow has exactly one stage that ships.")
    if shipping[0]["check"] is not None and not shipping[0]["steps"]:
        # A gate stage posts no run, so a workflow that shipped from one would never open a pull
        # request. One run ships from a stage that names no check at all.
        raise ValueError("A workflow's shipping stage can't be a gate stage.")
    return {"name": name, "stages": stages}


def _loop(value: Any, stage_name: str) -> Optional[Dict[str, Any]]:
    """A stage's loop, or ``ValueError``: the stage it starts at, and how many rounds it may take."""
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError(f'The loop on "{stage_name}" names the stage it starts at and its cap.')
    cap = value.get("cap")
    if not isinstance(cap, int) or isinstance(cap, bool) or not MIN_CAP <= cap <= MAX_CAP:
        raise ValueError(f"The loop on \"{stage_name}\" takes between {MIN_CAP} and {MAX_CAP} rounds.")
    start = text(value.get("from"))
    if not start:
        raise ValueError(f'The loop on "{stage_name}" has to start at a stage before it.')
    return {"from": start, "cap": cap}


def read_body(value: Any) -> Optional[Dict[str, Any]]:
    """A stored workflow body, read back as the library holds it, or ``None`` for one it can't read.

    A body written before this shape, or one a hand edit broke, reads as nothing rather than failing
    a whole library read: the preset is re-seeded, and a project naming it falls back to the default.
    """
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            return None
    if not isinstance(value, dict):
        return None
    found = stages(value.get("stages"))
    if not found:
        return None
    return {"name": text(value.get("name")) or "", "stages": found}


def stages(value: Any) -> List[Dict[str, Any]]:
    """The stages a workflow holds, cleaned, for a reader that must not throw on a broken body.

    The library's own writes go through ``normalise``, so this is only ever the tolerant read of what
    is already stored — a record of a task's snapshot, or a row from before a key existed.
    """
    if not isinstance(value, list):
        return []
    found: List[Dict[str, Any]] = []
    for one in value:
        if not isinstance(one, dict):
            continue
        name = text(one.get("name"))
        if not name:
            continue
        check = text(one.get("check"))
        found.append(
            _stage(
                name,
                names(one.get("steps")),
                check=check if check in CHECKS else None,
                loop=one.get("loop") if isinstance(one.get("loop"), dict) else None,
                ships=bool(one.get("ships")),
            )
        )
    return found


def shipping(stages: List[Dict[str, Any]]) -> Optional[int]:
    """The index of the stage that ships, or ``None`` for a workflow whose stages name none."""
    return next((index for index, stage in enumerate(stages) if stage.get("ships")), None)


def steps_of(stages: List[Dict[str, Any]]) -> List[str]:
    """Every skill a workflow's stages apply, each once, in the order the workflow applies them."""
    found: List[str] = []
    for stage in stages:
        found.extend(stage.get("steps") or [])
    return list(dict.fromkeys(found))


def _entry(workflow_id: str, name: str, body: Dict[str, Any], preset: bool, at: int) -> Dict[str, Any]:
    """A library entry as the routes answer it: the workflow's own name and stages, and where it came
    from."""
    return {
        "id": workflow_id,
        "name": name,
        "preset": preset,
        "at": at,
        "stages": body.get("stages") or [],
    }


def _version() -> str:
    """The plugin's own version, which is what a preset's body was seeded by.

    Read lazily: ``plugin/__init__.py`` imports this module, so a name taken at import time would be
    a cycle.
    """
    try:
        from . import VERSION

        return str(VERSION)
    except Exception:
        return "0"


def _seed(conn: sqlite3.Connection) -> None:
    """Puts the presets in the store, and refreshes a preset whose body this version moved.

    By id rather than by name: an id is what a project names, so a preset can be renamed or rewritten
    without a project losing its pick. A preset the user deleted stays deleted — seeding is what is
    missing, not what was taken away. It runs on the caller's connection, so a read seeds and lists
    in one open rather than two.
    """
    version = _version()
    now = int(time.time())
    rows = {
        str(row[0]): (bool(row[1]), row[2], bool(row[3]))
        for row in conn.execute("SELECT id, preset, version, deleted FROM workflows")
    }
    for workflow_id, name, stages in PRESETS:
        body = json.dumps({"name": name, "stages": stages})
        found = rows.get(workflow_id)
        if found is None:
            conn.execute(
                """INSERT INTO workflows (id, name, body, preset, version, deleted, at)
                   VALUES (?, ?, ?, 1, ?, 0, ?)""",
                (workflow_id, name, body, version, now),
            )
        elif found[2]:
            continue
        elif found[0] and found[1] != version:
            conn.execute(
                "UPDATE workflows SET name = ?, body = ?, version = ?, at = ? WHERE id = ?",
                (name, body, version, now, workflow_id),
            )


def _rows(hermes_home: Path, where: str, params: Tuple[Any, ...]) -> List[Tuple[Any, ...]]:
    """One read of the library: the presets seeded, then the rows this query names.

    Seeding and listing share the connection, so a read costs one open — the sweep reads the library
    for every home it serves and the sheet's poll reads it while it is open.
    """
    conn = connect(db_path(hermes_home))
    try:
        _seed(conn)
        return conn.execute(
            f"SELECT id, name, body, preset, at FROM workflows WHERE deleted = 0 AND {where}", params
        ).fetchall()
    finally:
        conn.close()


def library(hermes_home: Path) -> List[Dict[str, Any]]:
    """Every workflow this bot holds, presets first and each group by name."""
    return [
        _entry(str(row[0]), str(row[1]), _body(row[2]), bool(row[3]), int(row[4]))
        for row in _rows(hermes_home, "1 = 1 ORDER BY preset DESC, name COLLATE NOCASE, id", ())
    ]


def _body(value: Any) -> Dict[str, Any]:
    """A stored workflow body as the library holds it, and an empty one for a row it can't read."""
    return read_body(value) or {"name": "", "stages": []}


def get(hermes_home: Path, workflow_id: str) -> Optional[Dict[str, Any]]:
    """One workflow, or ``None`` when the library holds no such id.

    Its own row rather than the whole library: the app's editor asks for one, and so does a write
    that checks an id before it stores it.
    """
    rows = _rows(hermes_home, "id = ?", (workflow_id,))
    if not rows:
        return None
    row = rows[0]
    return _entry(str(row[0]), str(row[1]), _body(row[2]), bool(row[3]), int(row[4]))


def _row(hermes_home: Path, workflow_id: str) -> Optional[Dict[str, Any]]:
    """One stored row as a write reads it: its name, its body as the library holds it, its preset.

    Read through ``get`` so a write and a read answer from the same place, and a workflow the library
    can't read is nobody's to write.
    """
    found = get(hermes_home, workflow_id)
    if found is None:
        return None
    return {
        "name": found["name"],
        "body": {"name": found["name"], "stages": found["stages"]},
        "preset": found["preset"],
    }


def named(hermes_home: Path, project_id: str) -> Optional[Dict[str, Any]]:
    """The workflow a project picks, or ``None`` where it picks none or the library has lost it."""
    workflow_id = _named(hermes_home, project_id)
    return get(hermes_home, workflow_id) if workflow_id else None


def pick(hermes_home: Path, project_id: str) -> Dict[str, Any]:
    """The workflow a project's AFK work runs under: its own pick, or the One run preset.

    A project that named nothing works in one prompt run, so One run is what it reads as: the picker
    has something true to show, and picking a workflow is what puts the project back on stages
    (ADR 0027). A project naming a workflow the library no longer holds reads the same way — a
    deleted workflow can't be what the next task stalls on, and its delete was refused where a
    project still named it.
    """
    return named(hermes_home, project_id) or one_run()


def one_run() -> Dict[str, Any]:
    """The One run preset as a library entry: the shape a project that named nothing reads as.

    Built from the presets rather than read from a store, so a library the user has edited can't
    answer a staged shape for a project that runs one run.
    """
    workflow_id, name, stages = next(one for one in PRESETS if one[0] == DEFAULT_ID)
    return _entry(workflow_id, name, {"name": name, "stages": stages}, True, 0)


def _named(hermes_home: Path, project_id: str) -> Optional[str]:
    conn = connect(db_path(hermes_home))
    try:
        row = conn.execute(
            "SELECT workflow_id FROM project_afk WHERE project_id = ?", (project_id,)
        ).fetchone()
    except Exception:
        logger.debug("memento: couldn't read project %s's workflow", project_id, exc_info=True)
        return None
    finally:
        conn.close()
    return text(row[0]) if row else None


def create(hermes_home: Path, body: Any) -> Dict[str, Any]:
    """Adds a workflow to the library, answering the entry it wrote.

    A new id, never the caller's: an id is what a project names, so only the library hands them out.
    """
    found = normalise(body)
    return _write(hermes_home, f"wf-{uuid.uuid4().hex[:12]}", found, preset=False)


def update(hermes_home: Path, workflow_id: str, body: Any) -> Optional[Dict[str, Any]]:
    """Rewrites a workflow, answering the entry that now holds it, or ``None`` for an unknown id.

    A preset is never written: a write to one forks it into a copy with a new id, and the copy takes
    the name the write gave it — or, when it named none, a name that reads as a copy of the preset's.
    """
    row = _row(hermes_home, workflow_id)
    if row is None:
        return None
    if not row["preset"]:
        return _write(hermes_home, workflow_id, normalise(body), preset=False, at=int(time.time()))
    name = text((body or {}).get("name") if isinstance(body, dict) else None)
    if not name:
        body = {**(body if isinstance(body, dict) else {}), "name": COPY.format(name=row["name"])}
    return create(hermes_home, body)


def delete(hermes_home: Path, workflow_id: str) -> bool:
    """Deletes a workflow, or refuses when a project names it — naming those projects.

    A deleted preset is remembered as deleted rather than forgotten: seeding puts back what is
    missing, and nothing brings back what the user took away.
    """
    row = _row(hermes_home, workflow_id)
    if row is None:
        return False
    named = _projects_naming(hermes_home, workflow_id)
    if named:
        raise Refused(
            f'The workflow "{row["name"]}" can\'t be deleted: it is still named by {named}.'
        )
    conn = connect(db_path(hermes_home))
    try:
        conn.execute("UPDATE workflows SET deleted = 1, at = ? WHERE id = ?", (int(time.time()), workflow_id))
    finally:
        conn.close()
    return True


def _projects_naming(hermes_home: Path, workflow_id: str) -> str:
    """The projects that name a workflow, as a sentence reads them: their names, else their ids."""
    from . import sessions

    conn = connect(db_path(hermes_home))
    try:
        ids = [
            str(row[0])
            for row in conn.execute(
                "SELECT project_id FROM project_afk WHERE workflow_id = ? ORDER BY project_id",
                (workflow_id,),
            )
        ]
    finally:
        conn.close()
    if not ids:
        return ""
    names = sessions.project_names(hermes_home)
    return ", ".join(names.get(one) or one for one in ids)


def migrate(
    hermes_home: Path,
    project_id: str,
    build_skill: Optional[str],
    critique_skills: Iterable[str],
) -> Dict[str, Any]:
    """The workflow a project's old skill columns described, written once, and the project's pick.

    Build with the skill it built by, Test, Review with the skills it reviewed by and shipping on
    Review: exactly what the columns meant, so nothing changes shape under the user on upgrade. The id
    is the project's, so two reads racing each other write one row, and the project's pick is set
    before the row is read again — a project migrates once, not once per read.
    """
    stages = from_skills(build_skill, critique_skills)
    workflow_id = f"migrated-{project_id}"
    _write(
        hermes_home,
        workflow_id,
        {"name": MIGRATED, "stages": stages},
        preset=False,
        replace=False,
    )
    conn = connect(db_path(hermes_home))
    try:
        conn.execute(
            "UPDATE project_afk SET workflow_id = ? WHERE project_id = ? AND workflow_id IS NULL",
            (workflow_id, project_id),
        )
    finally:
        conn.close()
    return get(hermes_home, workflow_id) or pick(hermes_home, project_id)


def from_skills(
    build_skill: Optional[str], critique_skills: Iterable[str]
) -> List[Dict[str, Any]]:
    """The stages a project's old build and critique skills were: Build, Test, Review.

    Three, not the default preset's four: the columns described a build and the review that
    followed it, and the two skill lists are all a project ever said about its work.
    """
    build = [name for name in [text(build_skill)] if name]
    review = names(critique_skills)
    return [
        _stage(_BT, build),
        _stage(_TEST, check=GATE),
        _stage(_REVIEW, review, ships=True),
    ]


def any_steps(hermes_home: Path) -> bool:
    """Whether any workflow the library holds applies a skill, so a sweep has choices worth judging.

    Reading the skill catalog walks a directory tree, and a sweep only needs it to judge a step: a
    library whose workflows name nothing skips the walk on every home, every wake. A store that can't
    answer reads as yes, since a check that can't run is no reason to stop judging.
    """
    try:
        conn = connect(db_path(hermes_home))
        try:
            _seed(conn)
            rows = conn.execute("SELECT body FROM workflows WHERE deleted = 0").fetchall()
        finally:
            conn.close()
    except Exception:
        logger.debug("memento: couldn't read the workflow library", exc_info=True)
        return True
    return any(steps_of((read_body(row[0]) or {"stages": []})["stages"]) for row in rows)


def _write(
    hermes_home: Path,
    workflow_id: str,
    body: Dict[str, Any],
    preset: bool,
    at: Optional[int] = None,
    replace: bool = True,
) -> Dict[str, Any]:
    """Stores one workflow body under an id, answering the entry it wrote.

    ``replace`` is what makes a migration safe to race: the row it would write is only written when
    no row of that id is there yet, so two reads of one project can't leave two of its workflows.
    """
    when = at if at is not None else int(time.time())
    if replace:
        statement = """INSERT INTO workflows (id, name, body, preset, version, deleted, at)
                       VALUES (?, ?, ?, ?, ?, 0, ?)
                       ON CONFLICT(id) DO UPDATE SET name = excluded.name,
                         body = excluded.body, version = excluded.version, at = excluded.at,
                         deleted = 0"""
    else:
        statement = """INSERT OR IGNORE INTO workflows (id, name, body, preset, version, deleted, at)
                       VALUES (?, ?, ?, ?, ?, 0, ?)"""
    conn = connect(db_path(hermes_home))
    try:
        conn.execute(
            statement,
            (workflow_id, body["name"], json.dumps(body), 1 if preset else 0, _version(), when),
        )
    finally:
        conn.close()
    return _entry(workflow_id, body["name"], body, preset, when)
