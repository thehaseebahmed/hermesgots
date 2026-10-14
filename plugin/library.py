"""Filing a session's generated files in the project library: the agent's ``library_add`` tool.

The screenshots, images, charts, reports and markdown a session makes for the user belong in the
session's library folder (``<project>/files/<worktree>/``, beside ``plans/``), not in the worktree,
so they stay out of the branch's diff and the app's Library can link them later. The agent calls
this tool with a file's path and the folder to file it in; the tool creates the folder if it needs
to, moves the file there and answers with its new path. Folders and file names are kebab-case
slugs, folders named after the flow or change the files belong to (``library-tab``,
``library-tab-tree-view``), so the library reads as a tree of what was done. A name that isn't a
slug, or a file of that name already in the folder, is an error: the agent fixes the name and
calls again — nothing is renamed for it.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from . import attachments, sessions, tools_common

logger = logging.getLogger(__name__)

MAX_PATH = 4000
# A library walk answers with at most this many files, so one project's library can't flood the app.
MAX_FILES = 500
# Folders and file names are kebab-case slugs: lowercase words joined by single hyphens. Folders are
# named after the flow or change the files belong to (library-tab, library-tab-tree-view), so one
# project's library reads as a tree of what was done, not a pile of file types.
SLUG = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
# A file name is a slug plus one extension (dashboard-light.png); the extension is kept as filed.
EXTENSION = re.compile(r"^\.[a-z0-9]{1,8}$")

# The naming rule, for the errors: what a slug is and what it should mean.
SLUG_RULE = (
    "kebab-case: lowercase words joined by single hyphens, no spaces, capitals, underscores "
    "or path separators"
)
FOLDER_NAMING = (
    "name the folder after the flow or change the files belong to — library-tab for work on "
    "the library tab, library-tab-tree-view for a follow-up change to it — not the file type"
)


class LibraryError(Exception):
    """A file that can't be filed in the library: the tool answers with the message."""


def _slug(value: str, what: str, naming: str) -> str:
    """One kebab-case slug, or an error the agent can act on.

    Bad names are rejected with the nearest correction rather than rewritten silently, so the
    agent files where it meant to and learns the rule for the next call.
    """
    if not SLUG.match(value):
        # The nearest correction: word boundaries (spaces, capitals, punctuation) become hyphens.
        spaced = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "-", value)
        correction = re.sub(r"[^a-z0-9]+", "-", spaced.lower()).strip("-")
        suggestion = f" Call again with {what} '{correction}'." if correction else ""
        raise ValueError(f"{value!r} is not a slug ({SLUG_RULE}); {naming}.{suggestion}")
    return value


def _file_name(name: str) -> str:
    """A file name that is a slug with one extension: the stem is a slug, the extension kept.

    A bad stem (spaces, capitals, extra dots) is an error naming the file, since only the agent
    can rename it on disk before it calls again.
    """
    stem, dot, extension = name.rpartition(".")
    if not dot or not stem or not SLUG.match(stem) or not EXTENSION.match(f".{extension}"):
        raise ValueError(
            f"{name!r} is not a slug with an extension ({SLUG_RULE}), like "
            f"dashboard-light.png. Rename the file on disk to kebab-case, keeping its extension, "
            f"then call again with its new path."
        )
    return name


def library_root(project: Any) -> Path:
    """A project's library folder (``<primary folder>/files/``): the only place the tool files."""
    return Path(sessions._project_folders(project)[0]) / sessions.FILES_DIR


def _library_dir(hermes_home: Path, record: Dict[str, Any]) -> Tuple[Path, Path]:
    """The session's library folder and the project folder that holds it.

    Both resolve from the project's primary folder, so the folder stored on the record (schema
    v15) and a row written before it always agree.
    """
    project = sessions._project(hermes_home / "projects.db", record["project_id"])
    files = library_root(project)
    root = files.parent
    folder = record.get("files_dir")
    if folder:
        return root, Path(folder)
    return root, files / sessions._branch_slug(record.get("branch"))


def folder_and_worktree(hermes_home: Path, record: Dict[str, Any]) -> Tuple[Path, str]:
    """The project's library root and the session's worktree name, for listing its files."""
    root, folder = _library_dir(hermes_home, record)
    return root / sessions.FILES_DIR, folder.name


def _folder(folder: Any) -> str:
    """The one-level folder to file a file in: a kebab-case slug, so the library reads as a tree
    of flows. Bad names are rejected with the correction, never rewritten."""
    if not isinstance(folder, str) or not folder.strip():
        raise ValueError("folder is required.")
    name = folder.strip()
    if len(name) > attachments.MAX_NAME:
        raise ValueError(f"folder must be at most {attachments.MAX_NAME} characters.")
    return _slug(name, "folder", FOLDER_NAMING)


def file(
    hermes_home: Path,
    record: Dict[str, Any],
    path_str: Any,
    folder: Any,
    cwd: Optional[str] = None,
) -> Dict[str, Any]:
    """Moves ``path_str`` into ``folder`` under the session's library, making the folder if it
    needs to. A file of the same name already there is an error; nothing is renamed."""
    if not isinstance(path_str, str) or not path_str.strip():
        raise ValueError("path is required.")
    if len(path_str) > MAX_PATH:
        raise ValueError("path is too long.")
    name = _folder(folder)
    source = Path(path_str)
    if not source.is_absolute():
        source = Path(cwd or record["path"]) / source
    if not source.is_file():
        raise LibraryError("No such file.")
    _file_name(source.name)
    root, dest_dir = _library_dir(hermes_home, record)
    dest_dir = dest_dir / name
    dest_dir.mkdir(parents=True, exist_ok=True)
    # The project's folder is often itself a repo: keep files/ out of its git status, like plans/.
    sessions._exclude_from_git(str(root), sessions.FILES_DIR)
    dest = dest_dir / source.name
    if dest.exists():
        raise LibraryError(
            f"{source.name} is already in {name}. Rename the file on disk — a distinguishing "
            f"suffix or a more specific name — then call library_add again with its new path; "
            f"nothing was moved."
        )
    try:
        shutil.move(str(source), str(dest))
    except OSError as error:
        raise LibraryError(f"Couldn't move the file: {error.strerror or error}.") from None
    return {"name": dest.name, "path": str(dest)}


def entries(root: Path) -> List[Dict[str, Any]]:
    """Every file under a library root as ``{ worktree, folder, name, path, size, at }``.

    The tool writes ``files/<worktree>/<folder>/<file>``; a file with no folder was filed before
    folders existed and keeps ``folder: None``. Capped at ``MAX_FILES``, so a huge library answers
    with what it has rather than an enormous list. ``os.walk`` gives the directory split from the
    directory entry itself, so each file is statted once.
    """
    found: List[Dict[str, Any]] = []
    for current, _, names in os.walk(root):
        parts = Path(current).relative_to(root).parts
        # A file directly under files/ belongs to no session's library folder.
        if not parts:
            continue
        for name in names:
            path = Path(current) / name
            try:
                stat = path.stat()
            except OSError:
                continue
            found.append(
                {
                    "worktree": parts[0],
                    "folder": "/".join(parts[1:]) or None,
                    "name": name,
                    "path": str(path),
                    "size": stat.st_size,
                    # Epoch ms, like every other time the app reads (formatRelative works in ms).
                    "at": int(stat.st_mtime * 1000),
                }
            )
            if len(found) >= MAX_FILES:
                return found
    return found


def tree(root: Path, worktree: Optional[str] = None) -> List[Dict[str, Any]]:
    """The library under ``root`` as ``[{ name, files: [...] }]``, grouped by folder — a file with
    no folder (filed before folders existed) groups under its worktree's name — each folder's
    files newest first. With ``worktree``, only that session's files."""
    groups: Dict[str, List[Dict[str, Any]]] = {}
    for entry in entries(root):
        if worktree is not None and entry["worktree"] != worktree:
            continue
        groups.setdefault(entry["folder"] or entry["worktree"], []).append(entry)
    return [
        {"name": name, "files": sorted(files, key=lambda entry: entry["at"], reverse=True)}
        for name, files in sorted(groups.items())
    ]


def library_roots(hermes_home: Path) -> List[Path]:
    """Every project's library folder (``<primary folder>/files/``): the only place the tool files."""
    projects_db = hermes_home / "projects.db"
    if not projects_db.exists():
        return []
    from hermes_cli import projects_db as pdb

    with pdb.connect_closing(db_path=projects_db) as conn:
        projects = pdb.list_projects(conn, include_archived=True)
    return [library_root(project) for project in projects]


def holds(hermes_home: Path, path: Path) -> bool:
    """Whether ``path`` sits under a project's library folder."""
    return any(path.is_relative_to(root) for root in library_roots(hermes_home))


TOOL = "library_add"
SCHEMA = {
    "name": TOOL,
    "description": (
        "File a generated file in the session's library so the user can find it later: the tool "
        "creates the folder under the session's library if it needs to, moves the file there and "
        "answers with its new path. Use it for every file you generate for the user — "
        "screenshots, images, charts, reports, markdown — instead of leaving them in the "
        "worktree, and return an image's new path in a MEDIA:<path> tag so the user sees it. "
        "Source edits stay in the worktree."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": (
                    "The file to file in the session's library: its path, absolute or relative "
                    "to your current directory. Its name must be kebab-case with its extension "
                    "(dashboard-light.png); rename it on disk first if it isn't."
                ),
            },
            "folder": {
                "type": "string",
                "description": (
                    "The folder to file it in under the session's library. Name it after the "
                    "flow or change the files belong to — library-tab for work on the library "
                    "tab, library-tab-tree-view for a follow-up change to it — not the file "
                    "type (not screenshots or reports). One level, kebab-case: lowercase words "
                    "joined by single hyphens. A file of the same name already there is an "
                    "error — rename the file and call again."
                ),
            },
        },
        "required": ["path", "folder"],
    },
}


def handle(args: Any, task_id: Optional[str] = None, session_id: Optional[str] = None, **_: Any) -> str:
    """The tool: files a file in the library of the session the call belongs to (its task id is
    Memento's session id)."""
    args = args if isinstance(args, dict) else {}
    path, home = sessions._paths()
    record = sessions.record_for_call(path, home, task_id, session_id)
    if not record:
        return json.dumps({"error": "This session has no library to file in."})
    try:
        result = file(
            home,
            record,
            args.get("path"),
            args.get("folder"),
            sessions._cwd(task_id or session_id or ""),
        )
    except (ValueError, LibraryError) as error:
        return json.dumps({"error": str(error)})
    return json.dumps(result)


def register(ctx: Any) -> bool:
    """Registers the tool with Hermes, for every surface's agents of this profile."""
    register_tool = getattr(ctx, "register_tool", None)
    if not callable(register_tool):
        return False
    try:
        return register_tool(
            name=TOOL, toolset="memento", schema=SCHEMA, handler=handle, emoji="🗂️"
        ) is not False
    except Exception:
        logger.warning("memento: couldn't register the library_add tool", exc_info=True)
        return False


def wire(adapter: Any) -> bool:
    """Wires the tool into every agent the API server builds."""
    return tools_common.wire_tool(adapter, TOOL, SCHEMA, "library_add")


def equip(agent: Any) -> None:
    tools_common.equip_tool(agent, TOOL, SCHEMA)
