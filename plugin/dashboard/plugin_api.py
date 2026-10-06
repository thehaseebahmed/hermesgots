"""Memento dashboard plugin backend, mounted at /api/plugins/memento/ on the dashboard."""

from __future__ import annotations

import re
import sqlite3
from pathlib import Path
from typing import Any, Dict

from fastapi import APIRouter

from hermes_constants import get_hermes_home

router = APIRouter()

PLUGIN_DIR = Path(__file__).resolve().parent.parent


def _version() -> str:
    try:
        text = (PLUGIN_DIR / "plugin.yaml").read_text(encoding="utf-8")
    except OSError:
        return "0.0.0"
    match = re.search(r"^version:\s*[\"']?([^\"'\s]+)", text, re.M)
    return match.group(1) if match else "0.0.0"


def _ledger() -> Dict[str, Any]:
    path = Path(get_hermes_home()) / "cron" / "executions.db"
    if not path.exists():
        return {"exists": False, "runs": 0, "jobs": 0}
    # Read-only, so a status page can never lock the scheduler out.
    with sqlite3.connect(f"{path.as_uri()}?mode=ro", uri=True, timeout=2) as conn:
        runs, jobs = conn.execute("SELECT COUNT(*), COUNT(DISTINCT job_id) FROM executions").fetchone()
    return {"exists": True, "runs": runs, "jobs": jobs}


def _chats() -> Dict[str, Any]:
    # Same file as ../chats.py; this module loads on its own, so it can't import that one.
    path = Path(get_hermes_home()) / "memento" / "memento.db"
    if not path.exists():
        return {"exists": False, "chats": 0}
    with sqlite3.connect(f"{path.as_uri()}?mode=ro", uri=True, timeout=2) as conn:
        (chats,) = conn.execute("SELECT COUNT(*) FROM chats WHERE deleted = 0").fetchone()
    return {"exists": True, "chats": chats}


def _enabled() -> bool | None:
    try:
        from hermes_cli.plugins_cmd import _get_disabled_set, _get_enabled_set
    except ImportError:
        return None
    return "memento" in _get_enabled_set() and "memento" not in _get_disabled_set()


@router.get("/status")
def status() -> Dict[str, Any]:
    try:
        ledger = _ledger()
    except sqlite3.Error as error:
        ledger = {"exists": True, "runs": None, "jobs": None, "error": str(error)}
    try:
        chats = _chats()
    except sqlite3.Error as error:
        chats = {"exists": True, "chats": None, "error": str(error)}
    return {
        "name": "memento",
        "version": _version(),
        "enabled": _enabled(),
        "ledger": ledger,
        "chats": chats,
        "routes": [
            "/api/plugins/memento/info",
            "/api/plugins/memento/cron/runs",
            "/api/plugins/memento/chats",
            "/api/plugins/memento/projects",
            "/api/plugins/memento/github",
            "/api/plugins/memento/github/repos",
            "/api/plugins/memento/runs/live",
            "/api/plugins/memento/sessions/{session_id}/label",
            "/api/plugins/memento/sessions/{session_id}/context",
            "/api/plugins/memento/sessions/{session_id}/todos",
            "/api/plugins/memento/sessions/{session_id}/workspace",
            "/api/plugins/memento/sessions/{session_id}/workspace/remove",
            "/api/plugins/memento/sessions/{session_id}/mode",
            "/api/plugins/memento/sessions/{session_id}/pr",
        ],
    }
