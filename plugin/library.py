"""Filing a session's generated files in the project library: the agent's ``library_add`` tool.

The screenshots, images, charts, reports and markdown a session makes for the user belong in the
session's library folder (``<project>/files/<worktree>/``, beside ``plans/``), not in the worktree,
so they stay out of the branch's diff and the app's Library can link them later. The agent calls
this tool with a file's path and the folder to file it in; the tool creates the folder if it needs
to, moves the file there and answers with its new path. A file of that name already in the folder
is an error: the agent renames it and calls again.
"""

from __future__ import annotations

import json
import logging
import shutil
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from . import attachments, sessions, tools_common

logger = logging.getLogger(__name__)

MAX_PATH = 4000
# A library walk answers with at most this many files, so one project's library can't flood the app.
MAX_FILES = 500


class LibraryError(Exception):
    """A file that can't be filed in the library: the tool answers with the message."""


def _library_dir(hermes_home: Path, record: Dict[str, Any]) -> Tuple[Path, Path]:
    """The session's library folder and the project folder that holds it.

    Both resolve from the project's primary folder, so the folder stored on the record (schema
    v15) and a row written before it always agree.
    """
    project = sessions._project(hermes_home / "projects.db", record["project_id"])
    root = Path(sessions._project_folders(project)[0])
    folder = record.get("files_dir")
    if folder:
        return root, Path(folder)
    return root, root / sessions.FILES_DIR / sessions._branch_slug(record.get("branch"))


def worktree(record: Dict[str, Any]) -> str:
    """The session's worktree name: the folder under the project's ``files/`` its files live in."""
    folder = record.get("files_dir")
    return Path(folder).name if folder else sessions._branch_slug(record.get("branch"))


def _folder(folder: Any) -> str:
    """The one-level folder to file a file in. Bad names are rejected, never rewritten, so the
    agent corrects itself instead of silently filing somewhere else."""
    if not isinstance(folder, str) or not folder.strip():
        raise ValueError("folder is required.")
    name = folder.strip()
    if len(name) > attachments.MAX_NAME or "/" in name or "\\" in name or name.startswith("."):
        raise ValueError("folder must be a single folder name (no path separators).")
    return name


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
    root, dest_dir = _library_dir(hermes_home, record)
    dest_dir = dest_dir / name
    dest_dir.mkdir(parents=True, exist_ok=True)
    # The project's folder is often itself a repo: keep files/ out of its git status, like plans/.
    sessions._exclude_from_git(str(root), sessions.FILES_DIR)
    dest = dest_dir / source.name
    if dest.exists():
        raise LibraryError(f"{source.name} is already in {name}; rename the file and call again.")
    try:
        shutil.move(str(source), str(dest))
    except OSError as error:
        raise LibraryError(f"Couldn't move the file: {error.strerror or error}.") from None
    return {"name": dest.name, "path": str(dest)}


def entries(root: Path) -> List[Dict[str, Any]]:
    """Every file under a library root as ``{ worktree, folder, name, path, size, at }``.

    The tool writes ``files/<worktree>/<folder>/<file>``; a file with no folder was filed before
    folders existed and keeps ``folder: None``. Capped at ``MAX_FILES``, so a huge library answers
    with what it has rather than an enormous list.
    """
    found: List[Dict[str, Any]] = []
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        parts = path.relative_to(root).parts
        if len(parts) < 2:
            continue
        try:
            stat = path.stat()
        except OSError:
            continue
        found.append(
            {
                "worktree": parts[0],
                "folder": "/".join(parts[1:-1]) or None,
                "name": parts[-1],
                "path": str(path),
                "size": stat.st_size,
                "at": int(stat.st_mtime),
            }
        )
        if len(found) >= MAX_FILES:
            break
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
                    "to your current directory."
                ),
            },
            "folder": {
                "type": "string",
                "description": (
                    "The folder to file it in under the session's library (e.g. screenshots, "
                    "reports): one level, no path separators. A file of the same name already "
                    "there is an error — rename the file and call again."
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
