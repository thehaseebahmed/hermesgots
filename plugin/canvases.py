"""A canvas: one HTML document a bot writes, the versions it was written as, and the checks a write
has to pass before it becomes one (ADR 0113).

The host owns everything a canvas is. Its record lives in ``canvases`` (title, the session it is
edited in, the chat that session belongs to, its newest version and its placement) and every write
is a row of ``canvas_versions``, the newest ``KEEP_VERSIONS`` kept. A canvas is changed only from its
own session: ``canvas_write`` and ``canvas_read`` are equipped there and nowhere else, and the canvas
is found from a run's session by walking the chat's compression lineage (``sessions.chat_session``),
so a chat that has been compacted still reaches its canvas.

The scan is hygiene, not the defence — the sandbox the page is drawn in is (ADR 0114). It refuses a
write whole, naming why: past ``MAX_BYTES``, holding what looks like a secret, not a complete
document, or reaching outside itself for anything it loads.
"""

from __future__ import annotations

import json
import logging
import re
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import chats, events, outbox, sessions, tools_common, triage
from .store import connect

logger = logging.getLogger(__name__)

# A document a phone has to hold in memory and draw; the cap is the whole write or nothing.
MAX_BYTES = 256 * 1024
KEEP_VERSIONS = 20
# How much of a prompt becomes a canvas's title — and so its chat's.
TITLE_CHARS = 60

TOOL_WRITE = "canvas_write"
TOOL_READ = "canvas_read"

# Set by register() and _wire_api_server, and what `ready` answers with.
ctx: Any = None
adapter: Any = None
_registered = False
_wired = False


class CanvasError(ValueError):
    """A write or a read the canvas rules refuse; ``status`` is what a route answers."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


# --- the scan ------------------------------------------------------------------------------------

# The plugin's own list, since Hermes's redaction patterns aren't a public surface. Each entry is the
# name a refusal gives the reader and the shape of the secret it recognises; the first match wins, so
# a narrower pattern stands before the broader one that would also catch it.
SECRETS = (
    ("private key", re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----")),
    ("Anthropic key", re.compile(r"sk-ant-[A-Za-z0-9_-]{16,}")),
    ("Stripe key", re.compile(r"(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}")),
    ("OpenAI key", re.compile(r"sk-(?:proj-)?[A-Za-z0-9_-]{20,}")),
    ("GitHub token", re.compile(r"(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})")),
    ("AWS access key", re.compile(r"(?:AKIA|ASIA)[0-9A-Z]{16}")),
    ("Slack token", re.compile(r"xox[abposr]-[A-Za-z0-9-]{10,}")),
    ("Google API key", re.compile(r"AIza[0-9A-Za-z_-]{35}")),
    ("Google OAuth token", re.compile(r"ya29\.[0-9A-Za-z_-]{20,}")),
    ("JSON Web Token", re.compile(r"eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}")),
    ("bearer token", re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/-]{20,}=*")),
    # A URL that carries its own password: the page would be handing one out with every copy of it.
    ("credential in a URL", re.compile(r"(?i)\b[a-z][a-z0-9+.-]*://[^\s:@/]+:[^\s:@/]{3,}@")),
    # A value assigned to something named like a secret, camelCase and snake_case alike, which is
    # how a key is written when it isn't one of the shapes above.
    (
        "secret assignment",
        re.compile(
            r"(?i)(?:api[_-]?key|secret[A-Za-z0-9_]*|password|passwd|token[A-Za-z0-9_]*"
            r"|access[_-]?key)\b\s*[:=]\s*[\"'][^\"'\s]{12,}[\"']"
        ),
    ),
)

_COMMENT_OPEN = "<!--"
_COMMENT_CLOSE = "-->"
_HEAD = re.compile(r"(?is)<head\b")
_DOCTYPE = re.compile(r"(?is)^\ufeff?\s*<!doctype html")
_LANG = re.compile(r"(?is)<html\b[^>]*\blang\s*=\s*[\"']?[A-Za-z]")
_TITLE = re.compile(r"(?is)<title\b[^>]*>\s*\S")
_VIEWPORT = re.compile(
    r"(?is)<meta\b[^>]*\bname\s*=\s*[\"']viewport[\"'][^>]*\bcontent\s*=\s*[\"'][^\"']*width\s*=\s*device-width"
)
_BASE = re.compile(r"(?is)<base\b")
_REFRESH = re.compile(r"(?is)<meta\b[^>]*\bhttp-equiv\s*=\s*[\"']?refresh")
_FRAME = re.compile(r"(?is)<(?:iframe|object|embed)\b")
_SCRIPT_SRC = re.compile(r"(?is)<script\b[^>]*\bsrc\s*=")
# What a page loads from somewhere else. A link the reader could tap is not one of these: the frame
# can't follow it (ADR 0114), and refusing every `http://` would refuse a document that merely says
# where something came from.
_REMOTE = re.compile(
    r"(?is)(?:\b(?:src|srcset|poster|formaction|action)\s*=\s*[\"']?\s*(?:https?:)?//"
    r"|<link\b[^>]*\bhref\s*=\s*[\"']?\s*(?:https?:)?//"
    r"|url\(\s*[\"']?\s*(?:https?:)?//)"
)


def _markup(html: str) -> str:
    """The document as its markup, with every comment cut out and the pieces joined by a space.

    A tag named in a comment is not a tag, and the app finds the page's head by the same rule — so a
    comment that says ``<head>`` can't stand in for one, on either side.
    """
    pieces: List[str] = []
    at = 0
    while True:
        opened = html.find(_COMMENT_OPEN, at)
        if opened == -1:
            pieces.append(html[at:])
            return " ".join(pieces)
        pieces.append(html[at:opened])
        closed = html.find(_COMMENT_CLOSE, opened + len(_COMMENT_OPEN))
        if closed == -1:
            # An unterminated comment: nothing after it is markup.
            return " ".join(pieces)
        at = closed + len(_COMMENT_CLOSE)


def scan(html: Any) -> None:
    """Refuses a document that can't be a canvas, naming why; returns nothing when it can.

    The size is read as UTF-8 bytes, which is what a device holds and what a version weighs. Secrets
    are looked for in the whole file — a comment is drawn to anyone who opens the page — while the
    standards are read off its markup, where a tag in a comment is no tag at all.
    """
    if not isinstance(html, str) or not html.strip():
        raise CanvasError("A canvas needs a document.")
    size = len(html.encode("utf-8"))
    if size > MAX_BYTES:
        raise CanvasError(
            f"A canvas is capped at 256 KB; this one is {-(-size // 1024)} KB. Send less."
        )
    for name, pattern in SECRETS:
        if pattern.search(html):
            raise CanvasError(
                f"The canvas holds what looks like a {name}. A canvas is drawn by anyone who opens "
                "it, so a secret can't go in one: take it out and write it again."
            )
    markup = _markup(html)
    missing = [
        words
        for words, found in (
            ("a doctype", _DOCTYPE.search(markup)),
            ("an <html lang>", _LANG.search(markup)),
            ("a <head>", _HEAD.search(markup)),
            ("a <title>", _TITLE.search(markup)),
            ("a viewport meta tag", _VIEWPORT.search(markup)),
        )
        if not found
    ]
    if missing:
        raise CanvasError(
            "A canvas is a whole document: it needs " + ", ".join(missing) + ". Write it again."
        )
    for name, pattern in (
        ("<base>", _BASE),
        ("a meta refresh", _REFRESH),
        ("an <iframe>, <object> or <embed>", _FRAME),
        ("a <script src>", _SCRIPT_SRC),
        ("a URL it loads from outside itself", _REMOTE),
    ):
        if pattern.search(markup):
            raise CanvasError(
                f"The canvas holds {name}, which a canvas can't use: everything it loads has to be "
                "written into the document."
            )


# --- the record ----------------------------------------------------------------------------------

_COLUMNS = ("id", "title", "session_id", "chat_id", "version", "pinned", "hidden", "at", "created_at")
_RECORD = ", ".join(_COLUMNS)


def _row(row: Any) -> Dict[str, Any]:
    record = dict(zip(_COLUMNS, row))
    record["pinned"] = bool(record["pinned"])
    record["hidden"] = bool(record["hidden"])
    return record


def _record(conn: sqlite3.Connection, canvas_id: str) -> Optional[Dict[str, Any]]:
    """One canvas's record over a connection the caller holds."""
    row = conn.execute(f"SELECT {_RECORD} FROM canvases WHERE id = ?", (canvas_id,)).fetchone()
    return _row(row) if row else None


def record(path: Path, canvas_id: str) -> Optional[Dict[str, Any]]:
    """One canvas's record, or None when no canvas is that one."""
    if not canvas_id or not path.exists():
        return None
    conn = connect(path)
    try:
        return _record(conn, canvas_id)
    finally:
        conn.close()


def listing(path: Path) -> List[Dict[str, Any]]:
    """Every canvas this bot has, the one written to last first."""
    if not path.exists():
        return []
    conn = connect(path)
    try:
        rows = conn.execute(f"SELECT {_RECORD} FROM canvases ORDER BY at DESC").fetchall()
    finally:
        conn.close()
    return [_row(row) for row in rows]


def version_of(path: Path, canvas_id: str) -> Optional[Dict[str, Any]]:
    """The newest version's document and the tools it declared, or None before the first write."""
    if not canvas_id or not path.exists():
        return None
    conn = connect(path)
    try:
        row = conn.execute(
            """SELECT version, html, tools, at FROM canvas_versions
               WHERE canvas_id = ? ORDER BY version DESC LIMIT 1""",
            (canvas_id,),
        ).fetchone()
    finally:
        conn.close()
    if row is None:
        return None
    return {
        "version": row[0],
        "html": row[1],
        "tools": json.loads(row[2]) if row[2] else [],
        "written_at": row[3],
    }


def current(path: Path, canvas_id: str) -> Dict[str, Any]:
    """A canvas as the app draws it: its record, and the newest document with its tools."""
    found = record(path, canvas_id)
    if found is None:
        raise CanvasError("There is no such canvas.", 404)
    return {
        **found,
        **(
            version_of(path, canvas_id)
            or {"version": 0, "html": "", "tools": [], "written_at": found["at"]}
        ),
    }


def title_of(prompt: Any) -> str:
    """The title a prompt gives a new canvas, which is the chat's title too."""
    return triage.one_line(prompt, TITLE_CHARS) or "Canvas"


def _tools(raw: Any) -> Optional[str]:
    """A declared consent list as it is stored: names, deduplicated, in the order they were asked."""
    if raw is None:
        return None
    if not isinstance(raw, list) or not all(isinstance(name, str) and name for name in raw):
        raise CanvasError("tools must be a list of tool names.")
    return json.dumps(list(dict.fromkeys(raw)))


def write(
    path: Path,
    canvas_id: str,
    html: Any,
    title: Optional[Any] = None,
    tools: Any = None,
) -> Dict[str, Any]:
    """Stores a write as the canvas's next version, and answers the canvas as it now is.

    A write is one version: the whole document, scanned, stored, and the record's version moved on
    in the same transaction. Only the newest ``KEEP_VERSIONS`` are kept, and an older one going is
    the oldest version's row — never the newest, which is what a canvas is. A title writes the
    canvas's and its chat's together, so a rename is one name.
    """
    scan(html)
    declared = _tools(tools)
    named = title_of(title) if isinstance(title, str) and title.strip() else None
    now = int(time.time() * 1000)
    conn = connect(path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        # Read under the write lock: two writes racing here would otherwise both take the same
        # number, and the second would fail on the versions' primary key.
        found = _record(conn, canvas_id)
        if found is None:
            raise CanvasError("There is no such canvas.", 404)
        number = found["version"] + 1
        conn.execute(
            """INSERT INTO canvas_versions (canvas_id, version, html, tools, at)
               VALUES (?, ?, ?, ?, ?)""",
            (canvas_id, number, html, declared, now),
        )
        conn.execute(
            """UPDATE canvases SET version = ?, at = ?, title = COALESCE(?, title)
               WHERE id = ?""",
            (number, now, named, canvas_id),
        )
        conn.execute(
            """DELETE FROM canvas_versions
               WHERE canvas_id = ? AND version <= ?""",
            (canvas_id, number - KEEP_VERSIONS),
        )
        conn.execute("COMMIT")
    except BaseException:
        if conn.in_transaction:
            conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()
    if named:
        # The version is stored either way: a chat this can't rename is a title that lags, not a
        # write that failed.
        try:
            chats.set_title(path, found["chat_id"], named)
        except Exception:
            logger.debug("gots: couldn't rename %s's chat", canvas_id, exc_info=True)
    events.note("canvas", found["session_id"], path, True)
    return {
        **found,
        "title": named or found["title"],
        "version": number,
        "html": html,
        "tools": json.loads(declared) if declared else [],
        "written_at": now,
        "at": now,
    }


def _insert(path: Path, found: Dict[str, Any]) -> None:
    conn = connect(path)
    try:
        conn.execute(
            """INSERT INTO canvases (id, title, session_id, chat_id, version, pinned, hidden, at,
                                     created_at)
               VALUES (?, ?, ?, ?, 0, 0, 0, ?, ?)""",
            (
                found["id"],
                found["title"],
                found["session_id"],
                found["chat_id"],
                found["at"],
                found["at"],
            ),
        )
    finally:
        conn.close()


def _drop(path: Path, canvas_id: str) -> None:
    """Takes a record back whose first run never got queued, with the versions it wrote."""
    conn = connect(path)
    try:
        conn.execute("DELETE FROM canvases WHERE id = ?", (canvas_id,))
        conn.execute("DELETE FROM canvas_versions WHERE canvas_id = ?", (canvas_id,))
    finally:
        conn.close()


def create(
    path: Path,
    *,
    request_profile: Optional[str],
    bot_id: Optional[str],
    prompt: Any,
    body: Any,
) -> Dict[str, Any]:
    """A canvas from a prompt: its record, its chat and the run that builds it, in that order.

    The chat is the one the app makes for a thread — ``triage.open_thread``'s record, keyed by the
    session the canvas is edited in, carrying ``canvasId`` so no list or card ever draws it, titled
    with the canvas's own name and marked ``titleEdited`` so Hermes's auto-title never replaces it.
    The prompt is queued on that session as its first turn, so the canvas is built with the app
    closed, and a failure anywhere takes the record back rather than leaving a canvas with no run.
    """
    if not isinstance(prompt, str) or not prompt.strip():
        raise CanvasError("A canvas needs a prompt to build it from.")
    if not isinstance(body, dict) or not isinstance(body.get("input"), list) or not body["input"]:
        raise CanvasError("body must be the run request that builds the canvas.")
    run = body
    now = int(time.time() * 1000)
    canvas_id = str(uuid.uuid4())
    title = title_of(prompt)
    chat_id, session_id = triage.open_thread(
        path,
        bot_id,
        chats.pick(run.get("provider"), run.get("model")),
        opener=prompt,
        title=title,
        canvas_id=canvas_id,
    )
    found = {
        "id": canvas_id,
        "title": title,
        "session_id": session_id,
        "chat_id": chat_id,
        "at": now,
    }
    _insert(path, found)
    try:
        # The canvas row is in first: the run this queues may write to it the moment it starts.
        item = triage.queue_first_turn(path, request_profile, chat_id, session_id, prompt, [], body)
    except Exception:
        _drop(path, canvas_id)
        raise
    events.note("canvas", session_id, path, True)
    return {
        **found,
        "version": 0,
        "pinned": False,
        "hidden": False,
        "html": "",
        "tools": [],
        "written_at": now,
        "item": item,
    }


def canvas_of_session(path: Path, home: Path, session_id: Optional[str]) -> Optional[str]:
    """The canvas a run's session edits, or None when that session isn't a canvas's.

    A run may be keyed on a session compression moved the chat on to, so the chat is found from the
    root the walk answers and its record names the canvas. A store this can't read is no canvas:
    the caller then equips nothing, which is the safe way to be wrong.
    """
    if not isinstance(session_id, str) or not session_id:
        return None
    try:
        root = sessions.chat_session(home, session_id)
        value = (chats.by_session(path, root) or {}).get("value")
        found = value.get("canvasId") if isinstance(value, dict) else None
    except Exception:
        logger.debug("gots: couldn't resolve a canvas for %s", session_id, exc_info=True)
        return None
    return found if isinstance(found, str) and found else None


def _session_canvas(session_id: Optional[str]) -> Optional[str]:
    """The canvas the calling run edits, read from this profile's own store.

    Never raises: it is asked on every tool call of a session and inside the agent wrapper, and a
    store or a home this can't read is no canvas rather than a turn that dies.
    """
    return _tool_canvas(session_id)[0]


def _call_canvas(
    task_id: Optional[str], session_id: Optional[str]
) -> tuple[Optional[str], Optional[Path]]:
    """The canvas a tool call edits and the store it lives in, from either id Hermes gives it.

    A hook and a tool are handed a task id that is the run's own, which is not always the session's
    (``sessions.record_for_call`` copes the same way), so both are asked rather than the first one.
    """
    canvas_id, path = _tool_canvas(task_id)
    if canvas_id is None and session_id != task_id:
        canvas_id, path = _tool_canvas(session_id)
    return canvas_id, path


def _canvas_of_call(task_id: Optional[str], session_id: Optional[str]) -> Optional[str]:
    """The canvas a tool call edits, from either id Hermes gives it."""
    return _call_canvas(task_id, session_id)[0]


def _tool_canvas(session_id: Optional[str]) -> tuple[Optional[str], Optional[Path]]:
    """The canvas a run edits and the store it lives in, resolved once for the tool that asks."""
    try:
        path, home = sessions._paths()
    except Exception:
        logger.debug("gots: couldn't find the store a canvas lives in", exc_info=True)
        return None, None
    return canvas_of_session(path, home, session_id), path


# --- the tools -----------------------------------------------------------------------------------

WRITE_SCHEMA = {
    "name": TOOL_WRITE,
    "description": (
        "Canvas sessions only: writes the canvas's whole HTML document as its next version. The "
        "document must be complete — doctype, html lang, a title and a viewport meta — hold no "
        "secret and load nothing from outside itself, or the write is refused whole and the canvas "
        "keeps the version it had."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "html": {"type": "string", "description": "The whole document, from <!doctype html>."},
            "title": {"type": "string", "description": "The canvas's name, when it changes."},
            "tools": {
                "type": "array",
                "items": {"type": "string"},
                "description": "The host tools this version's page may call, if any.",
            },
        },
        "required": ["html"],
    },
}

READ_SCHEMA = {
    "name": TOOL_READ,
    "description": (
        "Canvas sessions only: reads the canvas's newest version — its document, its number and the "
        "tools that version declared — so a change starts from what is there now."
    ),
    "parameters": {"type": "object", "properties": {}},
}


def handle_write(args: Any, task_id: Optional[str] = None, session_id: Optional[str] = None, **_: Any) -> str:
    """The tool: writes the canvas whose session made the call."""
    args = args if isinstance(args, dict) else {}
    canvas_id, path = _call_canvas(task_id, session_id)
    if not canvas_id or path is None:
        return json.dumps({"error": f"{TOOL_WRITE} only works in a canvas's session."})
    try:
        found = write(path, canvas_id, args.get("html"), args.get("title"), args.get("tools"))
    except CanvasError as error:
        return json.dumps({"error": str(error)})
    return json.dumps(
        {"id": found["id"], "title": found["title"], "version": found["version"], "written": True}
    )


def handle_read(args: Any, task_id: Optional[str] = None, session_id: Optional[str] = None, **_: Any) -> str:
    """The tool: the canvas's newest version, as it stands."""
    canvas_id, path = _call_canvas(task_id, session_id)
    if not canvas_id or path is None:
        return json.dumps({"error": f"{TOOL_READ} only works in a canvas's session."})
    try:
        found = current(path, canvas_id)
    except CanvasError as error:
        return json.dumps({"error": str(error)})
    return json.dumps(
        {
            "id": found["id"],
            "title": found["title"],
            "version": found["version"],
            "tools": found["tools"],
            "html": found["html"],
        }
    )


# A canvas is edited by its session and nowhere else: work that leaves the host, files itself in a
# project's library or takes a task is not a canvas's.
BLOCKED_TOOLS = {"pull_request", "library_add", "afk_gate"}


def before_tool(**kwargs: Any) -> Optional[Dict[str, str]]:
    """The ``pre_tool_call`` hook: keeps a canvas's session to the canvas's own tools."""
    if kwargs.get("tool_name") not in BLOCKED_TOOLS:
        return None
    if not _canvas_of_call(kwargs.get("task_id"), kwargs.get("session_id")):
        return None
    return {
        "action": "block",
        "message": (
            f"This is a canvas's session: change the canvas with {TOOL_WRITE} and {TOOL_READ} only. "
            "It can't ship a pull request, file a library item or take a task."
        ),
    }


def register(plugin_ctx: Any) -> bool:
    """Keeps the context and registers the canvas's two tools."""
    global ctx, _registered
    ctx = plugin_ctx
    register_tool = getattr(plugin_ctx, "register_tool", None)
    if not callable(register_tool):
        return False
    took = True
    for tool, schema, handler in (
        (TOOL_WRITE, WRITE_SCHEMA, handle_write),
        (TOOL_READ, READ_SCHEMA, handle_read),
    ):
        try:
            if register_tool(name=tool, toolset="gots", schema=schema, handler=handler, emoji="🖼️") is False:
                took = False
        except Exception:
            logger.warning("gots: couldn't register the %s tool", tool, exc_info=True)
            took = False
    _registered = took
    return took


def wire(api_adapter: Any) -> bool:
    """Gives a canvas's agents its two tools, and only them: every other session would carry two
    tools it can't use."""
    global adapter, _wired
    adapter = api_adapter
    def is_canvas(session: Optional[str]) -> bool:
        return _session_canvas(session) is not None

    took = tools_common.wire_tool(api_adapter, TOOL_WRITE, WRITE_SCHEMA, TOOL_WRITE, when=is_canvas)
    if not tools_common.wire_tool(api_adapter, TOOL_READ, READ_SCHEMA, TOOL_READ, when=is_canvas):
        took = False
    _wired = took
    return took


def ready() -> bool:
    """Whether a canvas can be worked on this host: its tools registered and wired into the agents
    the API server builds, so a canvas's session is given them."""
    return _registered and _wired
