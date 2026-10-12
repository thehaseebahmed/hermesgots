"""The dev servers a session started: owned, ported and swept by the plugin.

Concurrent sessions on one host each start a dev server (the mock, Vite) and collide: same
default port, a neighbour's server mistaken for their own, or a pattern-kill that takes another
session's process down. ``servers.py`` gives each session's servers a port nobody else holds
(bind to zero, never a chosen number), records them in ``memento.db`` and kills them by process
group when the session resolves, is closed or goes stale — with the ``serve`` tool
(``ship.py``'s pattern) so the agent never starts one by hand.

Killing uses PIDs recorded with the process's kernel start time, never a command-line pattern:
the number plus the start time identifies the process, so a restarted gateway can still reap its
orphans without ever signalling a recycled PID.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
import socket
import subprocess
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from contextlib import suppress

from . import sessions
from .store import connect, db_path

logger = logging.getLogger(__name__)

MAX_NAME = 32
MAX_COMMAND = 500
# Readiness wait and stop grace, in seconds.
READY_S = 15
STOP_GRACE_S = 5
# Bind-to-zero can race another process onto the port between the probe close and the child's
# listen; one retry covers the practical case without spinning.
PORT_ATTEMPTS = 2
# A server older than this is swept as forgotten even if its session never resolved.
STALE_S = 24 * 3600
SWEEP_INTERVAL_S = 300
SIGTERM_GRACE_S = 5

SERVER_FIELDS = ("session_id", "name", "command", "cwd", "port", "pid", "start_time", "url", "log")

# Live Popen handles, so a running child is never GC'd unreaped and stop can wait on it.
# Keyed like the table; a gateway restart finds no handle and kills by the recorded pid.
_popen_handles: Dict[Tuple[str, str], subprocess.Popen] = {}


class ServerError(Exception):
    def __init__(self, message: str):
        super().__init__(message)


def _paths() -> Tuple[Path, Path]:
    from hermes_constants import get_hermes_home

    return db_path(Path(get_hermes_home())), Path(get_hermes_home())


def _log_dir(hermes_home: Path, session_id: str) -> Path:
    # Beside memento.db, outside the plugin's folder: `hermes plugins update` never touches it.
    return hermes_home / "memento" / "servers" / session_id


def _text(value: Any, name: str, limit: int) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ServerError(f"{name} is required.")
    value = value.strip()
    if len(value) > limit:
        raise ServerError(f"{name} is too long.")
    return value


# --- process identity ---------------------------------------------------------------


def _pid_exists(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _pid_start_time(pid: int) -> Optional[int]:
    """The process's kernel start ticks, or None off Linux or for a dead PID."""
    try:
        with open(f"/proc/{pid}/stat", "rb") as handle:
            # Field 22 is the start time; comm can contain spaces, so split past it.
            return int(handle.read().rsplit(b")", 1)[1].split()[19])
    except (OSError, ValueError, IndexError):
        return None


def _alive(row: Dict[str, Any]) -> bool:
    pid = row["pid"]
    if not isinstance(pid, int):
        return False
    if not _pid_exists(pid):
        return False
    # Start-time guard: never claim a recycled PID as ours.
    if isinstance(row.get("start_time"), int) and _pid_start_time(pid) != row["start_time"]:
        return False
    return True


def _listening(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=1):
            return True
    except OSError:
        return False


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


# --- the command, with the port injected --------------------------------------------


def _portless_error() -> ServerError:
    return ServerError(
        "Give the command a port: a {port} placeholder, or port_env / port_flag. "
        "Without one it would take its default port and collide with other sessions."
    )


def plan_command(command: str, port_env: Any, port_flag: Any) -> Tuple[str, Dict[str, str], Optional[str]]:
    """The command as run, its extra env and the flag that will carry the port.

    Exactly one mechanism may be given; the port's value is substituted at spawn time.
    """
    mechanisms = [bool(port_env), bool(port_flag), "{port}" in command]
    if sum(mechanisms) != 1:
        raise _portless_error()
    if port_env:
        env_name = _text(port_env, "port_env", 64)
        if not env_name.replace("_", "").isalnum():
            raise ServerError("port_env must be an environment variable name.")
        return command, {env_name: ""}, None
    if port_flag:
        return command, {}, _text(port_flag, "port_flag", 64)
    return command, {}, None


def _run_command(command: str, env: Dict[str, str], port_flag: Optional[str], port: int) -> Tuple[str, Dict[str, str]]:
    """The command as run and its extra env, with the port's value substituted in."""
    env = {key: str(port) for key in env}
    rendered = command.replace("{port}", str(port))
    if port_flag:
        rendered = f"{rendered} {port_flag} {port}"
    return rendered, env


# --- rows ----------------------------------------------------------------------------


def _row(record: Any) -> Dict[str, Any]:
    return dict(zip(SERVER_FIELDS, record))


def _read(path: Path, session_id: str, name: str) -> Optional[Dict[str, Any]]:
    conn = connect(path)
    try:
        row = conn.execute(
            f"SELECT {', '.join(SERVER_FIELDS)} FROM session_servers WHERE session_id = ? AND name = ?",
            (session_id, name),
        ).fetchone()
    finally:
        conn.close()
    return _row(row) if row else None


def _read_all(path: Path, session_id: Optional[str] = None) -> List[Dict[str, Any]]:
    conn = connect(path)
    try:
        if session_id:
            rows = conn.execute(
                f"SELECT {', '.join(SERVER_FIELDS)} FROM session_servers WHERE session_id = ?",
                (session_id,),
            ).fetchall()
        else:
            rows = conn.execute(f"SELECT {', '.join(SERVER_FIELDS)} FROM session_servers").fetchall()
    finally:
        conn.close()
    return [_row(row) for row in rows]


def _write(path: Path, row: Dict[str, Any]) -> None:
    conn = connect(path)
    try:
        conn.execute(
            """INSERT INTO session_servers (session_id, name, command, cwd, port, pid, start_time, url, log)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT (session_id, name) DO UPDATE SET
                 command = excluded.command, cwd = excluded.cwd, port = excluded.port,
                 pid = excluded.pid, start_time = excluded.start_time,
                 url = excluded.url, log = excluded.log""",
            tuple(row[field] for field in SERVER_FIELDS),
        )
    finally:
        conn.close()


def _forget(path: Path, session_id: str, name: str) -> None:
    conn = connect(path)
    try:
        conn.execute("DELETE FROM session_servers WHERE session_id = ? AND name = ?", (session_id, name))
    finally:
        conn.close()


# --- lifecycle ------------------------------------------------------------------------


def _stop_row(path: Path, row: Dict[str, Any], grace: int = STOP_GRACE_S) -> Dict[str, Any]:
    """Kills one row's process group, reaps it and clears the row. Never raises."""
    result = {"name": row["name"], "pid": row["pid"], "stopped": False}
    pid = row["pid"]
    proc = _popen_handles.pop((row["session_id"], row["name"]), None)
    if isinstance(pid, int) and _alive(row):
        try:
            os.killpg(pid, signal.SIGTERM)
        except OSError:
            try:
                os.kill(pid, signal.SIGTERM)
            except OSError:
                logger.debug("memento: server %s pid %s vanished before stop", row["name"], pid)
        deadline = time.monotonic() + grace
        while time.monotonic() < deadline and _pid_exists(pid):
            time.sleep(0.1)
        if _pid_exists(pid) and _alive(row):
            try:
                os.killpg(pid, signal.SIGKILL)
            except OSError:
                pass
    if proc is not None:
        with suppress(Exception):
            proc.wait(timeout=1)
    _forget(path, row["session_id"], row["name"])
    result["stopped"] = True
    return result


def _spawn(command: str, cwd: str, env: Dict[str, str], log_path: Path) -> subprocess.Popen:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log = log_path.open("a", encoding="utf-8")
    try:
        return subprocess.Popen(
            ["/bin/sh", "-c", command],
            cwd=cwd,
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=subprocess.STDOUT,
            env={**os.environ, **env},
            start_new_session=True,
        )
    finally:
        log.close()


def start(
    path: Path,
    hermes_home: Path,
    session_id: str,
    name: str,
    command: str,
    cwd: str,
    port_env: Any = None,
    port_flag: Any = None,
) -> Dict[str, Any]:
    """Starts (or returns) the session's server ``name`` on a port nobody else holds."""
    name = _text(name, "name", MAX_NAME)
    command = _text(command, "command", MAX_COMMAND)
    planned, env, flag = plan_command(command, port_env, port_flag)
    existing = _read(path, session_id, name)
    if existing and _alive(existing):
        return {"status": "running", **_shape(existing)}
    for _ in range(PORT_ATTEMPTS):
        port = _free_port()
        rendered, spawn_env = _run_command(planned, env, flag, port)
        log = _log_dir(hermes_home, session_id) / f"{name}.log"
        try:
            proc = _spawn(rendered, cwd, spawn_env, log)
        except OSError as error:
            raise ServerError(f"Couldn't run the command: {error}") from None
        deadline = time.monotonic() + READY_S
        while time.monotonic() < deadline:
            if proc.poll() is not None:
                break
            if _listening(port):
                row = {
                    "session_id": session_id,
                    "name": name,
                    "command": command,
                    "cwd": cwd,
                    "port": port,
                    "pid": proc.pid,
                    "start_time": _pid_start_time(proc.pid),
                    "url": f"http://127.0.0.1:{port}",
                    "log": str(log),
                }
                _popen_handles[(session_id, name)] = proc
                _write(path, row)
                return {"status": "started", **_shape(row)}
            time.sleep(0.2)
        _stop_row(path, {"session_id": session_id, "name": name, "pid": proc.pid, "start_time": _pid_start_time(proc.pid)})
        if proc.poll() is None and _listening(port):
            # The listener came up after the deadline; the port is held, so keep it.
            row = {
                "session_id": session_id,
                "name": name,
                "command": command,
                "cwd": cwd,
                "port": port,
                "pid": proc.pid,
                "start_time": _pid_start_time(proc.pid),
                "url": f"http://127.0.0.1:{port}",
                "log": str(log),
            }
            _popen_handles[(session_id, name)] = proc
            _write(path, row)
            return {"status": "started", **_shape(row)}
        tail = _log_tail(log)
        raise ServerError(
            f"The command didn't start listening on port {port} within {READY_S}s"
            + (f":\n{tail}" if tail else "")
        )
    raise ServerError("Couldn't get a free port.")


def _shape(row: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "name": row["name"],
        "port": row["port"],
        "pid": row["pid"],
        "url": row["url"],
        "log": row["log"],
        "command": row["command"],
    }


def _log_tail(log: Path, lines: int = 15) -> str:
    try:
        text = log.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return ""
    return "\n".join(text[-lines:])


def stop(path: Path, session_id: str, name: str) -> Dict[str, Any]:
    """Stops the session's server ``name``."""
    row = _read(path, session_id, name)
    if not row:
        return {"name": name, "stopped": False, "reason": "not running"}
    return _stop_row(path, row)


def stop_all(path: Path, session_id: str) -> List[Dict[str, Any]]:
    """Stops every server the session started; a session-level close or resolution."""
    return [_stop_row(path, row) for row in _read_all(path, session_id)]


def status(path: Path, session_id: str) -> Dict[str, Any]:
    """This session's servers, and the ports other sessions currently hold."""
    mine = [_shape(row) for row in _read_all(path, session_id) if _alive(row)]
    held = sorted(
        {row["port"] for row in _read_all(path) if row["session_id"] != session_id and _alive(row)}
    )
    return {"servers": mine, "ports_in_use": held}


def sweep(path: Path, hermes_home: Path, now: Optional[float] = None) -> int:
    """One pass: forget dead rows, kill the servers of sessions that ended, drop stale ones."""
    now = time.time() if now is None else now
    stopped = 0
    for row in _read_all(path):
        if not _alive(row):
            _forget(path, row["session_id"], row["name"])
            continue
        ended = not _session_open(path, hermes_home, row["session_id"])
        stale = (now - (row.get("start_time") or 0)) > STALE_S if row.get("start_time") else False
        if ended or stale:
            _stop_row(path, row)
            stopped += 1
    return stopped


def _session_open(path: Path, hermes_home: Path, session_id: str) -> bool:
    """A session is open while its workspace record exists; resolution removes it."""
    try:
        return bool(sessions.record_for(path, hermes_home, session_id))
    except Exception:
        # Can't tell: leave the server alone rather than kill a live session's.
        return True


def recover(path: Path, hermes_home: Path) -> int:
    """After a gateway restart: stop every server this install's sessions left behind.

    A dev server belongs to its session's turns, which died with the restart; the next
    turn starts a fresh one. Rows whose PID was recycled onto a stranger are dropped
    without signalling.
    """
    stopped = 0
    for row in _read_all(path):
        pid = row["pid"]
        if isinstance(pid, int) and _pid_exists(pid) and not _alive(row):
            logger.info(
                "memento: server %s pid %s was recycled; dropping the record", row["name"], pid
            )
        _stop_row(path, row)
        stopped += 1
    return stopped


async def run(hermes_home: Path) -> None:
    """Every few minutes, for this profile's home."""
    path = db_path(hermes_home)
    while True:
        await asyncio.sleep(SWEEP_INTERVAL_S)
        try:
            done = await asyncio.to_thread(sweep, path, hermes_home)
            if done:
                logger.info("memento: swept %d forgotten server(s)", done)
        except Exception:
            logger.warning("memento: sweeping servers failed", exc_info=True)


# --- the serve tool (ship.py's pattern) ------------------------------------------------


TOOL = "serve"
SCHEMA = {
    "name": TOOL,
    "description": (
        "Start, stop or check this session's dev servers (the mock, Vite, anything that "
        "listens). start picks a port no other session holds and runs command in this "
        "session's worktree, so never choose a port or start a server with the terminal "
        "yourself. Give the command exactly one way to take the port: a {port} placeholder, "
        "port_env (an env var carrying it) or port_flag (a flag appended with it). It "
        "answers { url, port, pid, log } once the port is listening. stop kills a server "
        "you started; status lists yours and the ports other sessions hold."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["start", "stop", "status"],
                "description": "start, stop or status.",
            },
            "name": {
                "type": "string",
                "description": 'The server\'s short label, like "mock" or "vite".',
            },
            "command": {
                "type": "string",
                "description": (
                    "The shell command that runs the server, relative to cwd. Include "
                    "{port} where the port goes, or use port_env / port_flag instead."
                ),
            },
            "cwd": {
                "type": "string",
                "description": (
                    "Folder to run in, relative to the session's worktree (default: the "
                    "worktree itself)."
                ),
            },
            "port_env": {
                "type": "string",
                "description": "An env var the port is exported under, e.g. PORT.",
            },
            "port_flag": {
                "type": "string",
                "description": 'A flag the port is appended to, e.g. "--port".',
            },
        },
        "required": ["action"],
    },
}


def handle(args: Any, task_id: Optional[str] = None, session_id: Optional[str] = None, **_: Any) -> str:
    """The tool: serves the session the call belongs to (its task id is Memento's session id)."""
    args = args if isinstance(args, dict) else {}
    path, home = sessions._paths()
    action = args.get("action")
    if action == "status":
        # Needs no workspace: the ports other sessions hold are the point.
        return json.dumps(status(path, session_id or task_id or ""))
    record = None
    for key in (task_id, session_id):
        if key and path.exists():
            record = sessions.record_for(path, home, key)
            if record:
                break
    if not record:
        return json.dumps({"error": "This session has no worktree to run a server in."})
    session = record["session_id"]
    try:
        if action == "start":
            root = record["path"] or ""
            if not root:
                raise ServerError("This session's worktree isn't set up.")
            cwd = args.get("cwd") or ""
            folder = os.path.normpath(os.path.join(root, str(cwd))) if cwd else root
            if not (folder == root or folder.startswith(root + os.sep)):
                raise ServerError("cwd must sit inside the session's worktree.")
            if not os.path.isdir(folder):
                raise ServerError(f"{cwd} doesn't exist in the worktree.")
            result = start(
                path,
                home,
                session,
                args.get("name"),
                args.get("command"),
                folder,
                args.get("port_env"),
                args.get("port_flag"),
            )
        elif action == "stop":
            name = args.get("name")
            if not isinstance(name, str) or not name.strip():
                raise ServerError("name is required to stop a server.")
            result = stop(path, session, name.strip())
        else:
            raise ServerError("action must be start, stop or status.")
    except ServerError as error:
        return json.dumps({"error": str(error)})
    return json.dumps(result)


def register(ctx: Any) -> bool:
    """Registers the tool with Hermes, for every surface's agents of this profile."""
    register_tool = getattr(ctx, "register_tool", None)
    if not callable(register_tool):
        return False
    try:
        return register_tool(
            name=TOOL, toolset="memento", schema=SCHEMA, handler=handle, emoji="🛰️"
        ) is not False
    except Exception:
        logger.warning("memento: couldn't register the serve tool", exc_info=True)
        return False


def wire(adapter: Any) -> bool:
    """Makes every agent the API server builds carry the tool when this profile registered it."""
    original = getattr(adapter, "_create_agent", None)
    if not callable(original):
        return False

    def create_agent(*args: Any, **kwargs: Any) -> Any:
        agent = original(*args, **kwargs)
        try:
            equip(agent)
        except Exception:
            logger.debug("memento: couldn't add the serve tool to an agent", exc_info=True)
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


# --- the pre_tool_call guards ------------------------------------------------------------


# A terminal command that starts a known dev server by hand, on its default port, instead of serve.
_HAND_STARTED = (
    "pnpm mock",
    "pnpm dev",
    "npm run dev",
    "npm run mock",
    "yarn dev",
    "node scripts/mock-hermes.mjs",
    "mock-hermes.mjs",
    "vite",
    "vite dev",
)
# A kill by pattern rather than by pid: the documented way sessions kill each other's servers.
_PATTERN_KILLS = ("pkill -f", "pkill ", "killall ")


def hand_started(command: str) -> Optional[str]:
    """The first known dev-server start in a terminal command, or None.

    Only a command with no port plumbing counts: a hand-written ``PORT=39xxx pnpm mock`` or
    ``vite --port 39xxx --strictPort`` already picks its own port and isn't the collision.
    """
    if not isinstance(command, str):
        return None
    for started in _HAND_STARTED:
        if started in command:
            break
    else:
        return None
    for plumbed in ("PORT=", "--port", "-p ", " {", "{port}"):
        if plumbed in command:
            return None
    return started


def pattern_kill_target(command: str, path: Path, hermes_home: Path, session_id: str) -> Optional[Dict[str, Any]]:
    """A live server another session owns that a pattern-kill in the command would hit, or None.

    The blocking guard's answer: only a *different* session's server blocks — killing your own
    with a pattern is sloppy but yours to kill. A pattern that matches nothing is free too.
    """
    if not isinstance(command, str) or not any(kill in command for kill in _PATTERN_KILLS):
        return None
    pattern = command.rsplit("f ", 1)[-1] if " -f" in command else command.rsplit("kill ", 1)[-1]
    pattern = pattern.strip().strip("\"'`")
    if not pattern or " " in pattern:
        # Not a single-word pattern we can check; leave it to the human approval flow.
        return None
    for row in _read_all(path):
        if row["session_id"] == session_id or not _alive(row):
            continue
        if pattern in (row.get("command") or "") or pattern in (row.get("log") or ""):
            return row
    return None
