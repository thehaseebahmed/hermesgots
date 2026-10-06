"""Hermes's checkpoints for one of its Projects, read-only, for Memento's diff viewer.

Hermes snapshots a working directory before a turn's first file change (``checkpoints.enabled``)
into one shared git store, ``$HERMES_HOME/checkpoints/store``: a ref per directory
(``refs/hermes/<hash>``) and ``projects/<hash>.json`` naming it. This reads that layout with git
rather than through ``tools.checkpoint_manager``, whose helpers change between releases and whose
diff restages the directory into Hermes's own index.

It never takes Hermes's store lock: Hermes skips a snapshot when the lock is busy, so holding it
would cost the agent a checkpoint. Reading while Hermes writes is safe for git; a checkpoint pruned
meanwhile just reads as not found.

A checkpoint's changes are what happened after it: up to the next checkpoint, or to the files as they
are now for the newest one. That's what rolling back to it would undo.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable, Dict, Iterator, List, Optional, Tuple

GIT_TIMEOUT_S = 30
# Hermes keeps 20 per directory unless configured otherwise.
MAX_PER_FOLDER = 50
MAX_FILE_PATCH = 200_000
MAX_TOTAL_PATCH = 2_000_000
HASH_RE = re.compile(r"^[0-9a-f]{40}([0-9a-f]{24})?$")
# Inherited from the gateway's environment, these would point git somewhere else.
GIT_LEAK_VARS = (
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_NAMESPACE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CEILING_DIRECTORIES",
)
DEFAULT_MAX_FILE_MB = 10
DIFF_FLAGS = ["--no-color", "--no-ext-diff", "--no-textconv", "-M"]


class CheckpointError(Exception):
    def __init__(self, message: str, status: int = 500):
        super().__init__(message)
        self.status = status


def _config(hermes_home: Path) -> Dict[str, Any]:
    """The profile's ``checkpoints`` section (the legacy ``checkpoints: true`` too)."""
    try:
        import yaml

        config = yaml.safe_load((hermes_home / "config.yaml").read_text(encoding="utf-8")) or {}
    except (ImportError, OSError, ValueError):
        return {}
    section = config.get("checkpoints") if isinstance(config, dict) else None
    if isinstance(section, bool):
        return {"enabled": section}
    return section if isinstance(section, dict) else {}


def _size_cap(hermes_home: Path) -> int:
    """Hermes leaves files over ``max_file_size_mb`` (10 by default, 0 for none) out of checkpoints."""
    try:
        megabytes = float(_config(hermes_home).get("max_file_size_mb", DEFAULT_MAX_FILE_MB))
    except (TypeError, ValueError):
        megabytes = DEFAULT_MAX_FILE_MB
    return int(megabytes * 1024 * 1024)


def _real(path: str) -> str:
    return os.path.realpath(os.path.expanduser(path))


def _inside(folder: str, path: str) -> bool:
    return path == folder or path.startswith(folder.rstrip(os.sep) + os.sep)


class _Store:
    def __init__(self, hermes_home: Path):
        self.path = hermes_home / "checkpoints" / "store"
        self.git = shutil.which("git")
        self.size_cap = _size_cap(hermes_home)

    def exists(self) -> bool:
        return (self.path / "HEAD").exists() and self.git is not None

    def env(self, extra: Optional[Dict[str, str]] = None) -> Dict[str, str]:
        env = {k: v for k, v in os.environ.items() if k not in GIT_LEAK_VARS}
        # The store is Hermes's, not the user's: none of their git config applies to it.
        env.update(
            GIT_DIR=str(self.path),
            GIT_CONFIG_GLOBAL=os.devnull,
            GIT_CONFIG_SYSTEM=os.devnull,
            GIT_CONFIG_NOSYSTEM="1",
            GIT_TERMINAL_PROMPT="0",
        )
        env.update(extra or {})
        return env

    def run(
        self, args: List[str], env: Optional[Dict[str, str]] = None, cwd: Optional[str] = None
    ) -> Tuple[int, str]:
        try:
            result = subprocess.run(
                [self.git or "git", *args],
                capture_output=True,
                env=env or self.env(),
                cwd=cwd or str(self.path),
                stdin=subprocess.DEVNULL,
                timeout=GIT_TIMEOUT_S,
            )
        except subprocess.TimeoutExpired as error:
            raise CheckpointError("git took too long reading the checkpoints.", 504) from error
        except OSError as error:
            raise CheckpointError(f"Couldn't run git: {error}") from error
        return result.returncode, result.stdout.decode("utf-8", errors="replace")

    def out(self, args: List[str], **kwargs: Any) -> str:
        code, stdout = self.run(args, **kwargs)
        return stdout if code == 0 else ""

    def folders(self) -> Dict[str, str]:
        """Each checkpointed directory's ref, by its real path."""
        found: Dict[str, str] = {}
        for meta_path in (self.path / "projects").glob("*.json"):
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8-sig"))
            except (OSError, ValueError):
                continue
            workdir = meta.get("workdir") if isinstance(meta, dict) else None
            if isinstance(workdir, str) and workdir:
                found[_real(workdir)] = f"refs/hermes/{meta_path.stem}"
        return found

    def _oversize(self, workdir: str, path: str) -> bool:
        if self.size_cap <= 0:
            return False
        try:
            return os.lstat(os.path.join(workdir, path)).st_size > self.size_cap
        except OSError:
            return False

    @contextmanager
    def now(self, workdir: str, ref: str) -> Iterator[Callable[[List[str]], Tuple[int, str]]]:
        """Runs git with the directory as it is now staged in a throwaway index and object folder.

        Hermes's own objects are borrowed as alternates, so only files changed since the checkpoint are
        written, and only to the throwaway folder.
        """
        with tempfile.TemporaryDirectory(prefix="memento-checkpoint-") as scratch:
            objects = os.path.join(scratch, "objects")
            os.mkdir(objects)
            env = self.env(
                {
                    "GIT_WORK_TREE": workdir,
                    "GIT_INDEX_FILE": os.path.join(scratch, "index"),
                    "GIT_OBJECT_DIRECTORY": objects,
                    "GIT_ALTERNATE_OBJECT_DIRECTORIES": str(self.path / "objects"),
                }
            )
            if self.run(["read-tree", ref], env=env, cwd=workdir)[0] != 0:
                raise CheckpointError("Couldn't read the folder's current files.")
            # Files too big for a checkpoint stay as the checkpoint has them, and are never hashed.
            listed = self.out(
                ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
                env=env,
                cwd=workdir,
            )
            skip = [
                path for path in set(listed.split("\0")) if path and self._oversize(workdir, path)
            ]
            spec = os.path.join(scratch, "pathspec")
            with open(spec, "w", encoding="utf-8") as out:
                out.write("\0".join([".", *(f":(exclude,literal){path}" for path in skip)]))
            add = ["add", "-A", f"--pathspec-from-file={spec}", "--pathspec-file-nul"]
            if self.run(add, env=env, cwd=workdir)[0] != 0:
                raise CheckpointError("Couldn't read the folder's current files.")
            yield lambda args: self.run(args, env=env, cwd=workdir)


def _project_folders(projects_db: Path, project_id: str) -> List[str]:
    from hermes_cli import projects_db as pdb

    if not projects_db.exists():
        raise CheckpointError("Project not found.", 404)
    with pdb.connect_closing(db_path=projects_db) as conn:
        project = pdb.get_project(conn, project_id)
    if project is None or project.id != project_id:
        raise CheckpointError("Project not found.", 404)
    return [_real(folder.path) for folder in project.folders]


def _project_refs(store: _Store, folders: List[str]) -> Dict[str, str]:
    """Checkpointed directories in one of the project's folders (a repo inside it, usually)."""
    return {
        workdir: ref
        for workdir, ref in store.folders().items()
        if os.path.isdir(workdir) and any(_inside(folder, workdir) for folder in folders)
    }


def _shortstat(text: str) -> Dict[str, int]:
    stat = {}
    for key, pattern in (
        ("files_changed", r"(\d+) files? changed"),
        ("insertions", r"(\d+) insertion"),
        ("deletions", r"(\d+) deletion"),
    ):
        match = re.search(pattern, text)
        stat[key] = int(match.group(1)) if match else 0
    return stat


def _list_folder(store: _Store, workdir: str, ref: str) -> List[Dict[str, Any]]:
    log = store.out(["log", ref, "--format=%H%x1f%at%x1f%s", "-n", str(MAX_PER_FOLDER)])
    commits = [line.split("\x1f", 2) for line in log.splitlines() if line.count("\x1f") == 2]
    if not commits:
        return []
    with store.now(workdir, ref) as git_now:
        newest = _shortstat(git_now(["diff", "--cached", "--shortstat", commits[0][0]])[1])
    rows = []
    for i, (sha, at, reason) in enumerate(commits):
        following = commits[i - 1][0] if i else None
        stat = (
            newest
            if following is None
            else _shortstat(store.out(["diff", "--shortstat", sha, following]))
        )
        rows.append(
            {
                "id": sha,
                "folder": workdir,
                "created_at": int(at),
                "reason": reason,
                "next": following,
                **stat,
            }
        )
    return rows


def list_for_project(hermes_home: Path, project_id: str) -> Dict[str, Any]:
    folders = _project_folders(hermes_home / "projects.db", project_id)
    store = _Store(hermes_home)
    rows: List[Dict[str, Any]] = []
    if store.exists():
        for workdir, ref in _project_refs(store, folders).items():
            rows.extend(_list_folder(store, workdir, ref))
    rows.sort(key=lambda row: row["created_at"], reverse=True)
    return {"enabled": _config(hermes_home).get("enabled") is True, "checkpoints": rows}


def _numstat(text: str) -> List[Dict[str, Any]]:
    """``--numstat -z`` records: ``added\\tdeleted\\tpath`` or, for a rename, ``…\\t\\0old\\0new``."""
    fields = text.split("\0")
    files, i = [], 0
    while i < len(fields) and fields[i]:
        added, deleted, path = fields[i].split("\t", 2)
        old = None
        if not path:
            old, path = fields[i + 1], fields[i + 2]
            i += 2
        i += 1
        binary = added == "-"
        files.append(
            {
                "path": path,
                "old_path": old,
                "insertions": None if binary else int(added),
                "deletions": None if binary else int(deleted),
                "binary": binary,
            }
        )
    return files


def _chunks(patch: str) -> List[str]:
    return re.split(r"^(?=diff --git )", patch, flags=re.M)[1:]


def _status(chunk: str, old_path: Optional[str]) -> str:
    header = chunk.split("\n@@", 1)[0]
    if re.search(r"^new file mode", header, re.M):
        return "added"
    if re.search(r"^deleted file mode", header, re.M):
        return "deleted"
    return "renamed" if old_path else "modified"


def _with_patches(files: List[Dict[str, Any]], patch: str) -> List[Dict[str, Any]]:
    chunks = _chunks(patch)
    # Both come from one diff queue, so they line up; if not, show the list without patches.
    if len(chunks) != len(files):
        chunks = [""] * len(files)
    budget = MAX_TOTAL_PATCH
    for file, chunk in zip(files, chunks):
        hunks = chunk[chunk.find("\n@@") + 1 :] if "\n@@" in chunk else ""
        file["status"] = _status(chunk, file["old_path"])
        file["truncated"] = len(hunks) > min(MAX_FILE_PATCH, budget)
        file["patch"] = None if file["truncated"] or not hunks else hunks
        budget -= len(file["patch"] or "")
    return files


def diff(hermes_home: Path, project_id: str, checkpoint_id: str) -> Dict[str, Any]:
    if not HASH_RE.match(checkpoint_id):
        raise CheckpointError("Checkpoint not found.", 404)
    folders = _project_folders(hermes_home / "projects.db", project_id)
    store = _Store(hermes_home)
    if not store.exists():
        raise CheckpointError("Checkpoint not found.", 404)
    for workdir, ref in _project_refs(store, folders).items():
        # Only a checkpoint in one of this project's folders, never another directory's.
        if store.run(["merge-base", "--is-ancestor", checkpoint_id, ref])[0] != 0:
            continue
        following = store.out(["rev-list", "--reverse", f"{checkpoint_id}..{ref}"]).split()
        base = {"id": checkpoint_id, "folder": workdir, "next": following[0] if following else None}
        if following:
            span = [checkpoint_id, following[0]]
            numstat = store.out(["diff", *DIFF_FLAGS, "--numstat", "-z", *span])
            patch = store.out(["diff", *DIFF_FLAGS, *span])
        else:
            with store.now(workdir, ref) as git_now:
                numstat = git_now(
                    ["diff", *DIFF_FLAGS, "--cached", "--numstat", "-z", checkpoint_id]
                )[1]
                patch = git_now(["diff", *DIFF_FLAGS, "--cached", checkpoint_id])[1]
        return {**base, "files": _with_patches(_numstat(numstat), patch)}
    raise CheckpointError("Checkpoint not found.", 404)
