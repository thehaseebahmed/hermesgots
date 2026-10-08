"""Theseus mode: a session run end to end by the vendored ``tha-theseus`` skill (``skills/``).

The skill is a Node CLI that keeps a run in ``.theseus/`` inside the session's worktree and, with
``serve --headless``, an API the human approves on. The plugin never reimplements it: it starts the
server on demand, reads the run with ``status --json --full`` and passes the app's actions to the
server's own routes, so every approval is recorded as the skill records it (source ``viewer``).

Code and visual reviews are model calls made through ``ctx.llm`` (``theseus_review``), recorded with
``--isolation model --via <model>``, so the reviewer is a different model from the builder and
shares nothing with it.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

SKILL = Path(__file__).parent / "skills" / "tha-theseus"
SCRIPT = SKILL / "scripts" / "theseus.js"
MIN_NODE = 20
CLI_TIMEOUT_S = 60
HTTP_TIMEOUT_S = 20
STATE_TTL_S = 3.0
MAX_CONTEXT_CHARS = 60000
TOOL = "theseus_review"
GATES = {"review": ("a", "b"), "visual": ("look", "behave")}
IMAGE_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif"}

# Fixed text, so the prompt cache holds across a session's turns.
INSTRUCTIONS = """This session is a Theseus run: the user decides, you build in small checkpoints that each pass four gates. Follow the tha-theseus skill. Read {skill}/SKILL.md first (api.md, gates.md and checkpoints.md sit next to it) and run its CLI as `node {script} <command>`, called `theseus` in the skill.
How it works on this host:
- Work only in your worktree. Start the run there with `theseus init`. The user sees it in Memento and approves the plan, the checkpoints and each checkpoint there. Never run `theseus serve`: Memento serves it.
- Settle requirements with the user in chat, asking with the clarify tool. After that nobody answers for the user, so wait for them with `theseus wait --timeout 120` and run it again each time it times out.
- Reviews are done by the theseus_review tool, which asks another model and records its verdict itself. Call it with gate `coverage` once the checkpoints are loaded (the user can't approve them until it is clean; on findings a fresh planner revises the list, you load it again and call it again), then once per reviewer a checkpoint needs (`a`, `b`; `look`, `behave` for visual). Never run `theseus coverage --verdict`, `theseus record ... review` or `visual --reviewer` yourself. `visual --skip` and `--carry` are still yours to record.
- Everything runs in Auto: you are never asked to approve a command, and only the user approves checkpoints.
- When the user confirms the run is complete, ship it with open_pull_request."""

THESEUS_BLOCK = (
    "Theseus session: review verdicts are recorded by the theseus_review tool, not by hand. "
    "Call it for the gate and reviewer instead."
)
_MANUAL_RECORD = re.compile(r"theseus(?:\.js)?\s+record\s+\S+\s+(?:review|visual)\b")
_MANUAL_COVERAGE = re.compile(r"theseus(?:\.js)?\s+coverage\b[^|;&]*--(?:verdict|findings)\b")

ACTIONS = {
    "confirm_plan": "/api/approve-implementation-plan",
    "approve_checkpoints": "/api/approve-checkpoints",
}

# The plugin context, kept by register() so the review tool can reach ctx.llm.
ctx: Any = None


class TheseusError(Exception):
    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


# --- the skill and the host --------------------------------------------------------------------


@lru_cache(maxsize=1)
def vendored() -> Dict[str, Any]:
    try:
        return json.loads((SKILL.parent / "VENDORED.json").read_text())
    except (OSError, ValueError):
        return {}


@lru_cache(maxsize=1)
def node() -> Optional[Dict[str, Any]]:
    """The ``node`` on the host and its version, or None when there isn't one."""
    binary = shutil.which("node")
    if not binary:
        return None
    try:
        out = subprocess.run([binary, "--version"], capture_output=True, text=True, timeout=10).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    match = re.match(r"v(\d+)\.(\d+)\.(\d+)", out.strip())
    if not match:
        return None
    return {"path": binary, "version": out.strip().lstrip("v"), "major": int(match.group(1))}


def available() -> Optional[str]:
    """Why Theseus can't run on this host, or None when it can."""
    if not SCRIPT.exists():
        return "This copy of the plugin has no Theseus skill."
    found = node()
    if not found:
        return f"Theseus needs Node {MIN_NODE} or newer on the Hermes host, and there is none."
    if found["major"] < MIN_NODE:
        return f"Theseus needs Node {MIN_NODE} or newer; the host has {found['version']}."
    return None


def llm_gate() -> Dict[str, bool]:
    """Whether the host config lets this plugin pick the provider and model of a review call
    (``plugins.entries.memento.llm.allow_*_override``). Reviews on the user's own model need neither."""
    allowed = {"model": False, "provider": False}
    if getattr(ctx, "llm", None) is None:
        return allowed
    try:
        from hermes_cli.config import load_config

        entry = ((load_config().get("plugins") or {}).get("entries") or {}).get("memento") or {}
        llm = entry.get("llm") or {}
        allowed = {
            "model": bool(llm.get("allow_model_override")),
            "provider": bool(llm.get("allow_provider_override")),
        }
    except Exception:
        logger.debug("memento: couldn't read the plugin's llm trust flags", exc_info=True)
    return allowed


def info() -> Dict[str, Any]:
    manifest = vendored()
    reason = available()
    found = node()
    return {
        "skill": (manifest.get("commit") or "")[:12] or None,
        "api": manifest.get("api"),
        "node": found["version"] if found else None,
        "ready": reason is None,
        "reason": reason,
        "reviewers": {"llm": getattr(ctx, "llm", None) is not None, **llm_gate()},
    }


def instructions() -> str:
    return INSTRUCTIONS.format(skill=SKILL, script=SCRIPT)


# --- the CLI and the server --------------------------------------------------------------------


def _cli(cwd: str, *args: str, timeout: int = CLI_TIMEOUT_S) -> subprocess.CompletedProcess:
    reason = available()
    if reason:
        raise TheseusError(reason, 501)
    return subprocess.run(
        [node()["path"], str(SCRIPT), *args],
        cwd=cwd,
        capture_output=True,
        text=True,
        timeout=timeout,
    )


def _run_dir(cwd: str) -> Path:
    return Path(cwd) / ".theseus"


_cache: Dict[str, Any] = {}
_cache_guard = threading.Lock()


def state(cwd: str, fresh: bool = False) -> Optional[Dict[str, Any]]:
    """The run's snapshot (``status --json --full``), or None when the session has no run yet.
    Kept for a few seconds, since the app and the sidebar ask often."""
    if not cwd or not (_run_dir(cwd) / "current" / "run.json").exists():
        return None
    with _cache_guard:
        hit = _cache.get(cwd)
        if hit and not fresh and time.monotonic() - hit[0] < STATE_TTL_S:
            return hit[1]
    result = _cli(cwd, "status", "--json", "--full")
    if result.returncode != 0:
        return None
    try:
        snap = json.loads(result.stdout)
    except ValueError:
        return None
    with _cache_guard:
        _cache[cwd] = (time.monotonic(), snap)
    return snap


def light(cwd: str) -> Optional[Dict[str, Any]]:
    """Just the run and its checkpoints, read from the files (no process), for the sidebar's poll."""
    base = _run_dir(cwd) / "current"
    try:
        run = json.loads((base / "run.json").read_text())
        saved = json.loads((base / "checkpoints.json").read_text())
        checkpoints = saved.get("checkpoints") or []
        coverage = saved.get("coverage")
    except (OSError, ValueError, AttributeError):
        return None
    if not isinstance(run, dict):
        return None
    if run.get("brief") and not run.get("plan"):
        run["plan"] = run["brief"]
    if run.get("planRequired") is None and run.get("briefRequired") is not None:
        run["planRequired"] = run["briefRequired"]
    return {
        "run": run,
        "checkpoints": checkpoints if isinstance(checkpoints, list) else [],
        "review": coverage,
    }


def _forget(cwd: str) -> None:
    with _cache_guard:
        _cache.pop(cwd, None)


def stage(snap: Optional[Dict[str, Any]]) -> str:
    """Where the run is, in the words the app shows: discovery, planning, plan (waiting for the
    user), checkpoints (waiting), building, approval (a checkpoint waits), closing and done."""
    if not snap:
        return "discovery"
    run = snap.get("run") or {}
    checkpoints = snap.get("checkpoints") or []
    status = run.get("status") or "open"
    if status in ("completed", "abandoned"):
        return "done"
    if status in ("completing", "abandoning"):
        return "closing"
    plan = run.get("plan") or {}
    if not checkpoints:
        if run.get("planRequired"):
            if plan.get("status") == "pending":
                return "plan"
            if plan.get("status") != "confirmed":
                return "discovery"
        return "planning"
    active = [c for c in checkpoints if c.get("status") in ("building", "awaiting-approval")]
    if any(c.get("status") == "awaiting-approval" for c in active):
        return "approval"
    if not active and any(c.get("status") == "pending" and not c.get("approved") for c in checkpoints):
        # The user can't approve the list until the coverage review is clean, so until then the
        # agent is still planning (a reviewer checks it, a planner revises it).
        return "checkpoints" if _coverage_clean(snap) else "planning"
    return "building"


def _coverage_clean(snap: Dict[str, Any]) -> bool:
    """Whether the planned checkpoints may be approved. The full snapshot says so itself; from the
    files alone (no process) it's the review's newest verdict, which can't tell a list reloaded
    after a pass from a current one (the skill still refuses that approval, with its own reason)."""
    full = snap.get("coverage")
    if isinstance(full, dict) and full.get("state"):
        return full["state"] in ("pass", "off")
    run = snap.get("run") or {}
    planned = [c for c in snap.get("checkpoints") or [] if c.get("origin") == "plan"]
    if (run.get("plan") or {}).get("status") != "confirmed" or not planned:
        return True
    if not any(not c.get("approved") for c in planned):
        return True
    verdict = ((snap.get("review") or {}).get("reviewers") or {}).get("coverage")
    return isinstance(verdict, dict) and verdict.get("findings") == 0


def waiting_stage(record: Dict[str, Any]) -> Optional[str]:
    """Which stage of a Theseus session waits on the user, for the sidebar and the project screen."""
    if record.get("mode") != "theseus" or not record.get("path"):
        return None
    found = stage(light(record["path"]))
    return found if found in ("plan", "checkpoints", "approval", "closing") else None


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _alive(pid: Any) -> bool:
    try:
        os.kill(int(pid), 0)
        return True
    except (OSError, ValueError, TypeError):
        return False


def _server(cwd: str) -> Dict[str, Any]:
    """The run's headless API server: its address and token, started if it isn't up."""
    file = _run_dir(cwd) / "server.json"

    def read() -> Optional[Dict[str, Any]]:
        try:
            info = json.loads(file.read_text())
        except (OSError, ValueError):
            return None
        return info if _alive(info.get("pid")) else None

    found = read()
    if found:
        return found
    result = _cli(cwd, "serve", "--headless", "--port", str(_free_port()))
    if result.returncode != 0:
        raise TheseusError((result.stderr or result.stdout).strip() or "Theseus couldn't start.", 409)
    for _ in range(40):
        found = read()
        if found:
            return found
        time.sleep(0.25)
    raise TheseusError("Theseus didn't come up.", 502)


def _call(cwd: str, method: str, route: str, body: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    server = _server(cwd)
    request = urllib.request.Request(
        f"{server.get('api') or 'http://127.0.0.1:%s' % server['port']}{route}",
        data=json.dumps(body or {}).encode() if method == "POST" else None,
        method=method,
        headers={"x-theseus-token": server["token"], "content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT_S) as response:
            return json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as error:
        try:
            message = json.loads(error.read()).get("error")
        except (ValueError, AttributeError):
            message = None
        # Theseus refuses with 409 and a sentence for the human; show it as it is.
        raise TheseusError(message or f"Theseus answered {error.code}.", 409 if error.code == 409 else 502)
    except (urllib.error.URLError, OSError) as error:
        raise TheseusError(f"Theseus isn't answering: {error}", 502)
    finally:
        _forget(cwd)


# --- what the app does ---------------------------------------------------------------------------

SETTING_KEYS = ("autonomy", "granularity", "visual", "reviewers")


def act(cwd: str, action: str, body: Dict[str, Any]) -> Dict[str, Any]:
    """Passes one of the user's actions to the run's server, which records it as the user's."""
    if not cwd:
        raise TheseusError("This session has no worktree yet.", 409)
    if action in ACTIONS:
        return _call(cwd, "POST", ACTIONS[action])
    text = body.get("text")
    cp = body.get("cp")
    if action == "approve":
        if not isinstance(cp, str) or not cp:
            raise TheseusError("cp is required.", 400)
        return _call(cwd, "POST", f"/api/approve/{urllib.request.quote(cp, safe='')}")
    if action in ("request_changes", "feedback", "revise_plan"):
        if not isinstance(text, str) or not text.strip():
            raise TheseusError("text is required.", 400)
        payload: Dict[str, Any] = {"text": text.strip()}
        if action == "revise_plan":
            payload["plan"] = True
        elif isinstance(cp, str) and cp:
            payload["cp"] = cp
        return _call(cwd, "POST", "/api/feedback", payload)
    if action == "settings":
        payload = {key: body[key] for key in SETTING_KEYS if isinstance(body.get(key), str)}
        if not payload:
            raise TheseusError("No setting given.", 400)
        return _call(cwd, "POST", "/api/settings", payload)
    if action == "close":
        if body.get("decision") not in ("confirm", "keep"):
            raise TheseusError("decision must be confirm or keep.", 400)
        return _call(cwd, "POST", "/api/close", {"decision": body["decision"]})
    raise TheseusError(f"Unknown action {action!r}.", 400)


def evidence_file(cwd: str, cp: str, name: str) -> Optional[Path]:
    """A screenshot from a checkpoint's evidence, only ever from inside the evidence folder."""
    if not re.fullmatch(r"[A-Za-z0-9._-]+", cp or "") or not re.fullmatch(r"[A-Za-z0-9._ -]+", name or ""):
        return None
    if Path(name).suffix.lower() not in IMAGE_TYPES:
        return None
    path = _run_dir(cwd) / "current" / "evidence" / cp / name
    return path if path.is_file() else None


def media_type(path: Path) -> str:
    return IMAGE_TYPES.get(path.suffix.lower(), "application/octet-stream")


# --- reviewers -------------------------------------------------------------------------------------


def clean_models(value: Any) -> Dict[str, List[Dict[str, Optional[str]]]]:
    """The reviewer models a session chose: up to two per gate, each a model on a provider (the
    user's own provider when none is named). A missing slot reviews on the user's active model."""
    models: Dict[str, List[Dict[str, Optional[str]]]] = {"review": [], "visual": []}
    if not isinstance(value, dict):
        return models
    for gate in models:
        entries = value.get(gate)
        for entry in (entries if isinstance(entries, list) else [])[:2]:
            if not isinstance(entry, dict):
                raise ValueError("A reviewer is a provider and a model.")
            fields: Dict[str, Optional[str]] = {}
            for key in ("provider", "model"):
                raw = entry.get(key)
                if raw is None or raw == "":
                    fields[key] = None
                elif isinstance(raw, str) and len(raw) <= 200 and re.fullmatch(r"[\w./:@+ -]+", raw):
                    fields[key] = raw.strip()
                else:
                    raise ValueError(f"{key} isn't a valid name.")
            models[gate].append(fields)
    return models


def _slot(gate: str, reviewer: str) -> int:
    return GATES[gate].index(reviewer)


def _gather(cwd: str, snap: Dict[str, Any], cp: str, gate: str, reviewer: str, since: bool) -> List[Any]:
    """What a reviewer is given, and nothing else: for code the diff, the architecture docs and the
    learnings; for visual the reference and the captures."""
    run = snap.get("run") or {}
    parts: List[Any] = []
    if gate == "review":
        diff = _cli(cwd, "diff", cp, *(["--since-review"] if since else []))
        learnings = _cli(cwd, "learnings")
        docs = []
        budget = MAX_CONTEXT_CHARS
        for rel in run.get("arch") or []:
            try:
                text = (Path(cwd) / rel).read_text(errors="replace")[:budget]
            except OSError:
                continue
            budget -= len(text)
            docs.append(f"### {rel}\n{text}")
            if budget <= 0:
                break
        parts.append(f"Code review (gate 3) of checkpoint {cp}.\n\n## Diff\n{diff.stdout[:MAX_CONTEXT_CHARS]}")
        parts.append("## Architecture docs\n" + ("\n\n".join(docs) or "none"))
        parts.append("## Learnings\n" + (learnings.stdout.strip() or "none"))
        previous = _previous_findings(snap, cp, reviewer)
        if since and previous:
            parts.append("## Your previous findings\n" + previous)
        return parts
    role = "appearance" if reviewer == "look" else "interaction"
    parts.append(
        f"Visual review (gate 2) of checkpoint {cp} as the {role} reviewer. Reference: "
        f"{run.get('reference') or 'not given'}. Every capture below is named for what it shows."
    )
    folder = _run_dir(cwd) / "current" / "evidence" / cp
    files = sorted(f for f in (folder.iterdir() if folder.is_dir() else []) if f.suffix.lower() in IMAGE_TYPES)
    if not files:
        raise TheseusError(f"{cp} has no screenshots in its evidence yet; capture the reference and the build first.", 409)
    for file in files[:12]:
        parts.append({"type": "text", "text": f"Capture: {file.name}"})
        parts.append({"type": "image", "data": file.read_bytes(), "mime_type": media_type(file)})
    return parts


def _coverage_parts(cwd: str, snap: Dict[str, Any]) -> List[Any]:
    """What the coverage reviewer is given: the confirmed plan and the planned checkpoints, as the
    skill prints them, and the findings of its earlier rounds."""
    given = _cli(cwd, "coverage")
    if given.returncode != 0:
        raise TheseusError((given.stderr or given.stdout).strip() or "Theseus has nothing to review yet.", 409)
    parts = ["Coverage review of the planned checkpoints against the confirmed plan.\n\n" + given.stdout[:MAX_CONTEXT_CHARS]]
    history = ((snap.get("coverage") or {}).get("evidence") or {}).get("history") or []
    if history and history[-1].get("items"):
        parts.append(
            "## Your previous findings\n"
            + "\n".join(f"{i + 1}. {item}" for i, item in enumerate(history[-1]["items"]))
        )
    return parts


def _previous_findings(snap: Dict[str, Any], cp: str, reviewer: str) -> str:
    for entry in snap.get("checkpoints") or []:
        if entry.get("id") != cp:
            continue
        history = ((entry.get("evidence") or {}).get("review") or {}).get("history") or []
        mine = [h for h in history if h.get("reviewer") == reviewer]
        if mine:
            return "\n".join(f"{i + 1}. {item}" for i, item in enumerate(mine[-1].get("items") or []))
    return ""


def _ask(model: Dict[str, Optional[str]], parts: List[Any], system: str) -> Any:
    llm = getattr(ctx, "llm", None)
    if llm is None:
        raise TheseusError(
            "This Hermes has no ctx.llm, so Theseus can't ask a second model to review. Update Hermes.", 501
        )
    options: Dict[str, Any] = {"temperature": 0.0, "max_tokens": 6000, "purpose": "theseus.review"}
    for key in ("provider", "model"):
        if model.get(key):
            options[key] = model[key]
    images = any(isinstance(part, dict) and part.get("type") == "image" for part in parts)
    try:
        if images:
            blocks = [
                {"type": "text", "text": part} if isinstance(part, str) else part for part in parts
            ]
            return llm.complete_structured(
                instructions="Review the inputs and reply in the format your instructions give.",
                input=blocks,
                system_prompt=system,
                **options,
            )
        user = "\n\n".join(part for part in parts if isinstance(part, str))
        return llm.complete(
            messages=[{"role": "system", "content": system}, {"role": "user", "content": user}], **options
        )
    except TheseusError:
        raise
    except Exception as error:
        name = type(error).__name__
        if "Trust" in name or "Override" in name or "Denied" in name:
            raise TheseusError(
                f"{error} Allow it in the Hermes config under plugins.entries.memento.llm "
                "(allow_model_override, allow_provider_override), or leave the reviewer on your own model.",
                403,
            )
        raise TheseusError(f"The reviewer's model call failed: {error}", 502)


def review(cwd: str, gate: str, cp: str, reviewer: str, models: Dict[str, Any], since: bool = False) -> Dict[str, Any]:
    """Runs one reviewer: asks its model, saves the reply and records it as a model review."""
    coverage = gate == "coverage"
    if coverage:
        reviewer = "coverage"
    elif gate not in GATES or reviewer not in GATES[gate]:
        raise TheseusError(f"{gate} reviewers are {', '.join(GATES[gate]) if gate in GATES else 'unknown'}.", 400)
    snap = state(cwd, fresh=True)
    if not snap:
        raise TheseusError("This session has no Theseus run yet. Start it with theseus init.", 409)
    brief = (SKILL / "reviewer.md").read_text()
    # The coverage review is one reviewer; it runs on the first code reviewer's model.
    chosen = models.get("review" if coverage else gate) or []
    slot = 0 if coverage else _slot(gate, reviewer)
    model = chosen[slot] if slot < len(chosen) else {}
    parts = _coverage_parts(cwd, snap) if coverage else _gather(cwd, snap, cp, gate, reviewer, since)
    folder = _run_dir(cwd)
    reply = ""
    for attempt in range(2):
        retry = [] if attempt == 0 else [
            "Your last reply wasn't in the required format. Reply with exactly the VERDICT, FINDINGS, "
            "numbered findings and SUMMARY block, and nothing else."
        ]
        result = _ask(model, [*parts, *retry], brief)
        reply = (getattr(result, "text", "") or "").strip()
        via = "/".join(x for x in (getattr(result, "provider", None), getattr(result, "model", None)) if x) or "model"
        file = folder / ("review-coverage.txt" if coverage else f"review-{cp}-{reviewer}.txt")
        file.write_text(reply)
        command = (
            ["coverage"] if coverage else ["record", cp, gate, "--reviewer", reviewer]
        ) + ["--verdict", str(file), "--isolation", "model", "--via", via]
        done = _cli(cwd, *command)
        if done.returncode == 0:
            _forget(cwd)
            return {"recorded": True, "via": via, "reply": reply, "output": done.stdout.strip()}
        problem = (done.stderr or done.stdout).strip()
        if "verdict" not in problem.lower() and "FINDINGS" not in problem:
            raise TheseusError(problem or "Theseus refused the review.", 409)
    raise TheseusError(f"The reviewer's reply couldn't be recorded: {problem}", 502)


# --- the tool --------------------------------------------------------------------------------------

SCHEMA = {
    "name": TOOL,
    "description": (
        "Theseus reviews: asks another model, saves its reply and records the verdict. Gate "
        "coverage checks the planned checkpoints against the confirmed plan (no checkpoint or "
        "reviewer needed; the user can't approve the list until it is clean). Code review (gate 3) "
        "takes reviewer a or b; visual review (gate 2) takes look (appearance) or behave "
        "(interaction). Returns the reviewer's verdict and findings."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "checkpoint": {"type": "string", "description": "The checkpoint id, e.g. CP1."},
            "gate": {"type": "string", "enum": ["coverage", "review", "visual"]},
            "reviewer": {"type": "string", "enum": ["a", "b", "look", "behave"]},
            "since_review": {
                "type": "boolean",
                "description": "Re-review: give the reviewer only the changes since the last review.",
            },
        },
        "required": ["gate"],
    },
}


def handle(args: Any, task_id: Optional[str] = None, session_id: Optional[str] = None, **_: Any) -> str:
    """The tool: reviews a checkpoint of the Theseus session the call belongs to."""
    from . import sessions

    args = args if isinstance(args, dict) else {}
    path, home = sessions._paths()
    record = None
    for key in (task_id, session_id):
        if key and path.exists():
            record = sessions.record_for(path, home, key)
            if record:
                break
    if not record or record["mode"] != "theseus" or not record["path"]:
        return json.dumps({"error": "This isn't a Theseus session."})
    try:
        result = review(
            record["path"],
            str(args.get("gate")),
            str(args.get("checkpoint") or ""),
            str(args.get("reviewer") or ""),
            record.get("theseus", {}).get("models") or {},
            bool(args.get("since_review")),
        )
    except TheseusError as error:
        return json.dumps({"error": str(error)})
    except (OSError, subprocess.SubprocessError) as error:
        return json.dumps({"error": f"Theseus couldn't run: {error}"})
    return json.dumps(result)


def register(plugin_ctx: Any) -> bool:
    """Registers the review tool and keeps the context for ctx.llm."""
    global ctx
    ctx = plugin_ctx
    register_tool = getattr(plugin_ctx, "register_tool", None)
    if not callable(register_tool):
        return False
    try:
        return register_tool(name=TOOL, toolset="memento", schema=SCHEMA, handler=handle, emoji="🔍") is not False
    except Exception:
        logger.warning("memento: couldn't register the theseus_review tool", exc_info=True)
        return False


def equip(agent: Any) -> None:
    """Adds the tool to an agent the API server built (like ``ship.equip``)."""
    names = getattr(agent, "valid_tool_names", None)
    tools = getattr(agent, "tools", None)
    if not isinstance(tools, list) or not isinstance(names, set) or TOOL in names:
        return
    try:
        from tools.registry import registry
    except ImportError:
        return
    if registry.get_entry(TOOL) is None:
        return
    tools.append({"type": "function", "function": SCHEMA})
    names.add(TOOL)


def wire(adapter: Any) -> bool:
    original = getattr(adapter, "_create_agent", None)
    if not callable(original):
        return False

    def create_agent(*args: Any, **kwargs: Any) -> Any:
        agent = original(*args, **kwargs)
        try:
            equip(agent)
        except Exception:
            logger.debug("memento: couldn't add the theseus_review tool to an agent", exc_info=True)
        return agent

    adapter._create_agent = create_agent
    return True


def blocks_record(tool: Any, args: Dict[str, Any]) -> bool:
    """Whether a terminal call records a reviewer's verdict by hand, which only the tool may do."""
    command = args.get("command") if isinstance(args, dict) else None
    if tool != "terminal" or not isinstance(command, str):
        return False
    if _MANUAL_COVERAGE.search(command):
        return True
    return bool(_MANUAL_RECORD.search(command)) and "--reviewer" in command
