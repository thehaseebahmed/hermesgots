"""Filing a session's generated files in the project library: the agent's ``add_to_library`` tool.

The screenshots, images, charts, reports and markdown a session makes for the user belong in the
session's library folder (``<project>/files/<worktree>/``, beside ``plans/``), not in the worktree,
so they stay out of the branch's diff and the app's Library can link them later. The agent calls
this tool with a file's path; the tool creates the folder if it needs to, moves the file there and
answers with its new path.

"""

from __future__ import annotations

import json
import logging
import shutil
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from . import attachments, sessions, tools_common

logger = logging.getLogger(__name__)

MAX_PATH = 4000


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


def file(
    hermes_home: Path,
    record: Dict[str, Any],
    path_str: Any,
    cwd: Optional[str] = None,
) -> Dict[str, Any]:
    """Moves ``path_str`` into the session's library folder, making the folder if it needs to."""
    if not isinstance(path_str, str) or not path_str.strip():
        raise ValueError("path is required.")
    if len(path_str) > MAX_PATH:
        raise ValueError("path is too long.")
    source = Path(path_str)
    if not source.is_absolute():
        source = Path(cwd or record["path"]) / source
    if not source.is_file():
        raise LibraryError("No such file.")
    root, dest_dir = _library_dir(hermes_home, record)
    dest_dir.mkdir(parents=True, exist_ok=True)
    # The project's folder is often itself a repo: keep files/ out of its git status, like plans/.
    sessions._exclude_from_git(str(root), sessions.FILES_DIR)
    try:
        # The claim creates the name empty and exclusively, so two racing calls can't pick one.
        dest = attachments.claim(dest_dir, source.name)
    except OSError as error:
        raise LibraryError(f"Couldn't file {source.name}: {error}.") from None
    try:
        shutil.move(str(source), str(dest))
    except OSError as error:
        dest.unlink(missing_ok=True)  # the claim is ours; don't leave an empty file behind
        raise LibraryError(f"Couldn't move the file: {error.strerror or error}.") from None
    return {"name": dest.name, "path": str(dest)}


TOOL = "add_to_library"
SCHEMA = {
    "name": TOOL,
    "description": (
        "File a generated file in the session's library so the user can find it later: the tool "
        "creates the session's library folder if it needs to, moves the file there and answers "
        "with its new path. Use it for every file you generate for the user — screenshots, "
        "images, charts, reports, markdown — instead of leaving them in the worktree, and return "
        "an image's new path in a MEDIA:<path> tag so the user sees it. Source edits stay in the "
        "worktree."
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
        },
        "required": ["path"],
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
        result = file(home, record, args.get("path"), sessions._cwd(task_id or session_id or ""))
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
        logger.warning("memento: couldn't register the add_to_library tool", exc_info=True)
        return False


def wire(adapter: Any) -> bool:
    """Wires the tool into every agent the API server builds."""
    return tools_common.wire_tool(adapter, TOOL, SCHEMA, "add_to_library")


def equip(agent: Any) -> None:
    tools_common.equip_tool(agent, TOOL, SCHEMA)
