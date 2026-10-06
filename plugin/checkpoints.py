"""A project session's checkpoints: Hermes's snapshots of each of its worktrees, read-only.

Hermes snapshots the folder the agent is about to change, once per turn, into a shadow git store
under the profile home (``tools/checkpoint_manager.py``; what ``/rollback`` lists). It keys them by
folder, and every project session works in its own worktree per repo, so a session's checkpoints are
its worktrees'. They're off unless ``checkpoints.enabled`` is set in config.yaml.
"""

from __future__ import annotations

import contextlib
import logging
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Tuple

logger = logging.getLogger(__name__)

FIELDS = ("hash", "short_hash", "timestamp", "reason", "files_changed", "insertions", "deletions")
# A diff past this is cut at a file boundary rather than sent whole to a phone.
MAX_DIFF_CHARS = 1_000_000
DEFAULT_MAX_SNAPSHOTS = 20


@contextlib.contextmanager
def _scoped(hermes_home: Path) -> Iterator[None]:
    # Hermes resolves the store and config.yaml from the request's profile, which to_thread doesn't see.
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override

    token = set_hermes_home_override(hermes_home)
    try:
        yield
    finally:
        reset_hermes_home_override(token)


def _settings() -> Tuple[bool, int]:
    """Whether the gateway takes checkpoints, and how many it keeps per folder."""
    try:
        from gateway.run import _checkpoint_agent_kwargs, _load_gateway_config

        kwargs = _checkpoint_agent_kwargs(_load_gateway_config())
        return bool(kwargs["checkpoints_enabled"]), int(kwargs["checkpoint_max_snapshots"])
    except Exception:
        logger.debug("memento: couldn't read the checkpoint settings", exc_info=True)
        return False, DEFAULT_MAX_SNAPSHOTS


def _manager(max_snapshots: int):
    from tools.checkpoint_manager import CheckpointManager

    # Listing and diffing don't check `enabled`; it only gates taking new ones.
    return CheckpointManager(enabled=False, max_snapshots=max_snapshots)


def _list(manager: Any, path: str) -> List[Dict[str, Any]]:
    try:
        rows = manager.list_checkpoints(path)
    except Exception:
        logger.debug("memento: couldn't list checkpoints", exc_info=True)
        return []
    return [{field: row.get(field) for field in FIELDS} for row in rows if row.get("hash")]


def read(hermes_home: Path, record: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """``{ enabled, repos: [{ name, branch, checkpoints }] }``, newest first in each repo."""
    with _scoped(hermes_home):
        enabled, max_snapshots = _settings()
        repos = []
        if record:
            manager = _manager(max_snapshots)
            for repo in record.get("repos", []):
                if not repo.get("path"):
                    continue
                repos.append(
                    {
                        "name": repo.get("name"),
                        "branch": repo.get("branch"),
                        "checkpoints": _list(manager, repo["path"]),
                    }
                )
    return {"enabled": enabled, "repos": repos}


def _truncate(diff: str) -> Tuple[str, bool]:
    if len(diff) <= MAX_DIFF_CHARS:
        return diff, False
    cut = diff.rfind("\ndiff --git ", 0, MAX_DIFF_CHARS)
    return diff[: cut + 1 if cut > 0 else MAX_DIFF_CHARS], True


def diff(
    hermes_home: Path, record: Optional[Dict[str, Any]], repo_name: Any, commit: Any
) -> Optional[Dict[str, Any]]:
    """What changed in the repo's worktree since the checkpoint, or None when the session has no such
    checkpoint. Only a listed checkpoint is diffed, so a session can't reach another folder's."""
    if not record or not isinstance(repo_name, str) or not isinstance(commit, str):
        return None
    repo = next((r for r in record.get("repos", []) if r.get("name") == repo_name), None)
    if not repo or not repo.get("path"):
        return None
    with _scoped(hermes_home):
        _, max_snapshots = _settings()
        manager = _manager(max_snapshots)
        listed = _list(manager, repo["path"])
        found = next((c for c in listed if commit in (c["hash"], c["short_hash"])), None)
        if found is None:
            return None
        result = manager.diff(repo["path"], found["hash"])
    if not result.get("success"):
        raise RuntimeError(result.get("error") or "Couldn't compare the checkpoint.")
    text, truncated = _truncate(result.get("diff") or "")
    return {"checkpoint": found, "repo": repo_name, "diff": text, "truncated": truncated}
