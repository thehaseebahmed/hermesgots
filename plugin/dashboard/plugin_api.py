"""Memento dashboard plugin backend, mounted at /api/plugins/memento/ on the dashboard."""

from __future__ import annotations

import importlib.util
import re
import sqlite3
import sys
import types
from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

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


def _link() -> Any:
    """``../link.py``, loaded under a stand-in package: Hermes imports this file on its own, so it
    can't import its siblings, and link.py only needs the package for ``VERSION``."""
    package = "hermes_dashboard_plugin_memento_pkg"
    loaded = sys.modules.get(f"{package}.link")
    if loaded:
        return loaded
    stub = types.ModuleType(package)
    stub.__path__ = [str(PLUGIN_DIR)]  # type: ignore[attr-defined]
    stub.VERSION = _version()  # type: ignore[attr-defined]
    sys.modules[package] = stub
    spec = importlib.util.spec_from_file_location(f"{package}.link", PLUGIN_DIR / "link.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _home() -> Path:
    return Path(get_hermes_home())


def _link_state() -> Dict[str, Any]:
    link = _link()
    home = _home()
    state = link.load_state(home)
    record = link.record(home, state, process_env=False) if state.get("token") else None
    return {
        "profile": link.profile_name(home),
        "linked": bool(state.get("token")) and not state.get("revoked"),
        "revoked": bool(state.get("revoked")),
        "site": state.get("site") or "",
        "url": link.default_url(home, state),
        "name": record["name"] if record else None,
        "has_key": bool(link.env_value(home, "API_SERVER_KEY")),
        "env": {
            key: link.shown_env(key, value)
            for key, value in link.env_changes(home, state.get("url") or "", state.get("origins") or []).items()
        }
        if state.get("token") and state.get("url")
        else {},
    }


class LinkBody(BaseModel):
    code: str
    site: str
    url: str


@router.get("/link")
def link_status() -> Dict[str, Any]:
    return _link_state()


@router.post("/link")
def link_profile(body: LinkBody) -> Dict[str, Any]:
    link = _link()
    home = _home()
    try:
        state = link.load_state(home)
        site = body.site.strip().rstrip("/")
        if not re.match(r"^https?://", site):
            raise link.LinkError("Enter the address you open Memento at.")
        if not link.is_linked(state):
            state = link.claim(home, state, body.code, site)
        url = link.set_url(home, state, body.url)
        link.publish(home, state, process_env=False, force=True)
        link.check_in(home, process_env=False)
    except link.LinkError as error:
        raise HTTPException(status_code=400, detail=str(error)) from None
    return {**_link_state(), "warning": link.http_warning(url)}


@router.post("/link/env")
def link_env() -> Dict[str, Any]:
    """Adds the ``.env`` lines the linked profile still needs (the tab shows them first)."""
    link = _link()
    home = _home()
    state = link.load_state(home)
    if not state.get("token") or not state.get("url"):
        raise HTTPException(status_code=409, detail="Link this profile first.")
    link.apply_env(home, link.env_changes(home, state["url"], state.get("origins") or []))
    link.publish(home, state, process_env=False, force=True)
    return _link_state()


@router.post("/unlink")
def unlink_profile() -> Dict[str, Optional[Any]]:
    link = _link()
    problem = link.unlink(_home()) if link.load_state(_home()).get("token") else None
    return {**_link_state(), "warning": problem}


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
            "/api/plugins/memento/sessions/{session_id}/prs",
        ],
    }
