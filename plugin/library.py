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

from . import sessions

logger = logging.getLogger(__name__)

MAX_PATH = 4000


class LibraryError(Exception):
    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


def _library_dir(hermes_home: Path, record: Dict[str, Any]) -> Tuple[Path, Path]:
    """The session's library folder and the project folder that holds it.

    The record carries the folder; a row written before it did resolves it from the project, the
    way ``sessions.save_plan`` resolves the plans folder.
    """
    folder = record.get("files_dir")
    if folder:
        path = Path(folder)
        return path.parent.parent, path
    project = sessions._project(hermes_home / "projects.db", record["project_id"])
    root = Path(sessions._project_folders(project)[0])
    return root, root / sessions.FILES_DIR / sessions._branch_slug(record.get("branch"))


def _unique(dest_dir: Path, name: str) -> Path:
    """A path in ``dest_dir`` that replaces nothing: a second ``chart.png`` becomes ``chart-2.png``."""
    stem, dot, ext = name.rpartition(".")
    if not dot or not stem:
        stem, dot, ext = name, "", ""
    for n in range(1, 1000):
        candidate = dest_dir / (name if n == 1 else f"{stem}-{n}{dot}{ext}")
        if not candidate.exists():
            return candidate
    raise LibraryError("Too many files with that name.", 409)


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
        raise LibraryError("No such file.", 404)
    root, dest_dir = _library_dir(hermes_home, record)
    dest_dir.mkdir(parents=True, exist_ok=True)
    # The project's folder is often itself a repo: keep files/ out of its git status, like plans/.
    sessions._exclude_from_git(str(root), sessions.FILES_DIR)
    name = _unique(dest_dir, source.name)
    try:
        shutil.move(str(source), str(name))
    except OSError as error:
        raise LibraryError(f"Couldn't move the file: {error.strerror or error}.") from None
    return {"name": name.name, "path": str(name)}


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
    record = None
    for key in (task_id, session_id):
        if key and path.exists():
            record = sessions.record_for(path, home, key)
            if record:
                break
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
    """Makes every agent the API server builds carry the tool when this profile registered it, since
    a saved ``platform_toolsets.api_server`` would otherwise leave the plugin's toolset out."""
    original = getattr(adapter, "_create_agent", None)
    if not callable(original):
        return False

    def create_agent(*args: Any, **kwargs: Any) -> Any:
        agent = original(*args, **kwargs)
        try:
            equip(agent)
        except Exception:
            logger.debug("memento: couldn't add the add_to_library tool to an agent", exc_info=True)
        return agent

    adapter._create_agent = create_agent
    return True


def equip(agent: Any) -> None:
    names = getattr(agent, "valid_tool_names", None)
    tools = getattr(agent, "tools", None)
    if not isinstance(tools, list) or not isinstance(names, set) or TOOL in names:
        return
    try:
        from tools.registry import registry
    except ImportError:
        return
    # Only where this profile loaded the plugin: anywhere else the call would be an unknown tool.
    if registry.get_entry(TOOL) is None:
        return
    tools.append({"type": "function", "function": SCHEMA})
    names.add(TOOL)
