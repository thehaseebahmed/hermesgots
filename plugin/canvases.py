"""A canvas: one HTML document a bot writes, the versions it was written as, and the checks a write
has to pass before it becomes one (ADR 0113).

The host owns everything a canvas is. Its record lives in ``canvases`` (title, the session it is
is edited in, the chat that session belongs to, its current version, its placement and the picture
its tile draws — a write may name one, which is what the list shows in place of the canvas's mark)
and every
write is a row of ``canvas_versions``, the newest ``KEEP_VERSIONS`` kept. A canvas is changed only
from its own session: ``canvas_write``, ``canvas_edit`` and ``canvas_read`` are equipped there and
nowhere else, and the canvas is found from a run's session by walking the chat's compression lineage
(``sessions.chat_session``), so a chat that has been compacted still reaches its canvas.
``canvas_list``, ``canvas_data_read`` and ``canvas_data_write`` reach every session — a session
with no canvas of its own is exactly who has to look one up, and a chat that wants a canvas's data
shouldn't have to become that canvas's session — while ``canvas_write``, ``canvas_edit`` and
``canvas_read`` are equipped in the canvas's own session and nowhere else. The two data tools name
a canvas by its title or its id (``resolve``), and all three answer ``names``, never a record's
picture.

The user's own decisions about a canvas — its name, whether it is pinned to the sidebar and whether
it is archived out of the list — are the host's record too (``update``), so every device draws the same
list and a name written there renames the chat with it. A canvas the user deletes is gone whole
(``delete``): its versions, data and grants, its chat as a tombstone, and the Hermes session it was
made in.

A version is the whole document. A small change is a list of find-and-replace pairs applied as one
version (``edit``), undo moves the record's pointer back one without deleting anything, and a read
answers the version the pointer names — so the agent always edits what the user is looking at.

The scan is hygiene, not the defence — the sandbox the page is drawn in is (ADR 0114). It refuses a
write whole, naming why: past ``MAX_BYTES``, holding what looks like a secret, not a complete
document, reaching outside itself for anything it loads, or asking for a library this host doesn't
carry — the last one naming the library and every name it would have answered.

A canvas also keeps data of its own: JSON documents in collections (``data``, ``put_doc``,
``remove_doc``), written by the page through the host's call route and by the agent through
``canvas_data_read`` and ``canvas_data_write``. The data is the canvas's, not a version's — a
write or an undo never touches it — so a page keeps its state through a version the user walks
back, and the whole of it is capped at ``DATA_BYTES`` because every open and every device's copy
carries it.

A page calls a tool on the host only when the version it is drawn from declared that tool, and only
once the user has answered for it: ``may_call`` reads the version's list and the canvas's own grant
row, and answers one of the verdicts ``page_calls`` names. The grant is the canvas's rather than a
version's — a page written again is no reason to ask again — while the version's list is what
decides what its page may call, so a tool the newest version stopped declaring is refused before
anybody is asked (ADR 0114).
"""

from __future__ import annotations

import json
import logging
import re
import sqlite3
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable, Dict, Iterator, List, Optional

from . import (
    chats,
    cleanup,
    events,
    mcp,
    mcp_call,
    outbox,
    page_calls,
    new_chats,
    sessions,
    tools_common,
)
from .store import connect

logger = logging.getLogger(__name__)

# A document a phone has to hold in memory and draw; the cap is the whole write or nothing.
MAX_BYTES = 256 * 1024
KEEP_VERSIONS = 20
# How much of a prompt becomes a canvas's title — and so its chat's.
TITLE_CHARS = 60
# The whole of a canvas's data. It rides every open and every device's copy of the page, so the cap
# is the canvas's rather than one document's, and a write past it is refused whole.
DATA_BYTES = 1024 * 1024
# What one document weighs beside its content: the keys, the clock and the punctuation a read of the
# data carries for it. Counting only the content would let a page keep a hundred thousand one-byte
# documents and hand every open an answer many times the cap.
DOC_BYTES = 64
# A collection and a document id are names the page sends, so they stay short and readable: what a
# key and a URL can carry without becoming a page of their own.
NAME_CHARS = 64
# A version's declared tools are the options sheet's rows: every one is a switch, so a version that
# declared thousands would be a list nobody could read and a dialog nobody could answer.
TOOLS_MAX = 50
# A start's files are one queued turn's attachments, and the queue keeps `outbox.MAX_FILES` of
# them; a longer list is refused rather than trimmed without a word.

# A chat id a start may name. Its session is `gots-<chat id>`, and the upload route saves a file
# under a session id of the app's own shape — up to 128 letters, digits, dots, dashes and
# underscores — so this leaves room for the prefix inside that length. Dots are out: a session is a
# folder, and `.` and `..` are not names in one.
CHAT_ID = re.compile(r"[A-Za-z0-9_-]{1,120}")
# A tool's name rides a stored grant, an option row and a dialog's title, so it stays a name.
TOOL_NAME_CHARS = 64
# The picture a canvas's tile draws. It rides every device's list as the page rides one screen, so it
# is one inline image — never a URL, since a list that fetched one would be a list reaching outside
# itself — and a picture past the cap is refused rather than trimmed.
IMAGE_CHARS = 192 * 1024

TOOL_LIST = "canvas_list"
TOOL_WRITE = "canvas_write"
TOOL_EDIT = "canvas_edit"
TOOL_READ = "canvas_read"
TOOL_DATA_READ = "canvas_data_read"
TOOL_DATA_WRITE = "canvas_data_write"

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
# An image the frame may load from outside (ADR 0134): an `<img>`'s `src` or `srcset`, or a
# `<picture>`'s `<source srcset>`, every URL of which is `https://`. The policy's `img-src https:`
# lets those in; a plain `http:` or scheme-relative URL is still refused, and so is every other load
# from outside — a script, a stylesheet, a font or background in CSS, a poster, a form's target.
_IMAGE_TAG = re.compile(r"(?is)<(img|source)\b[^>]*>")
_IMAGE_ATTRIBUTE = re.compile(
    r"(?is)\b(src|srcset)\s*=\s*(?:\"([^\"]*)\"|'([^']*)'|([^\s>]+))"
)
_HTTPS = re.compile(r"(?i)^https://")
_ANY_REMOTE = re.compile(r"(?i)^(?:https?:)?//")


def _remote_image(tag: str, name: str, value: str) -> bool:
    """Whether one attribute of an `<img>` or `<source>` names only images over https."""
    name = name.lower()
    if name == "src":
        return tag == "img" and bool(_HTTPS.match(value.strip()))
    candidates = [part.strip().split()[0] for part in value.split(",") if part.strip()]
    remote = [url for url in candidates if _ANY_REMOTE.match(url)]
    return bool(remote) and all(_HTTPS.match(url) for url in remote)


def _without_remote_images(markup: str) -> str:
    """The markup with the https images it may load cut out, so what is left is read for loads."""

    def tag(found: "re.Match[str]") -> str:
        kind = found.group(1).lower()
        return _IMAGE_ATTRIBUTE.sub(
            lambda attribute: " "
            if _remote_image(kind, attribute.group(1), next(v for v in attribute.groups()[1:] if v is not None))
            else attribute.group(0),
            found.group(0),
        )

    return _IMAGE_TAG.sub(tag, markup)



def _markup(html: str) -> str:
    """The document as its markup, with every comment cut out and the pieces joined by a space.

    A tag named in a comment is not a tag, and the app reads the page by the same rule — so a comment
    that says ``<head>`` can't stand in for one, on either side. ``<!-->`` and ``<!--->`` are
    complete comments rather than openers, and a ``<!--`` inside a script's or a style's own text is
    that element's text: the app's walk (`commentSpans`) reads both the same way.
    """
    pieces: List[str] = []
    lower = html.lower()
    at = 0
    while True:
        opened = html.find(_COMMENT_OPEN, at)
        if opened == -1:
            pieces.append(html[at:])
            return " ".join(pieces)
        pieces.append(html[at:opened])
        if html.startswith("<!-->", opened):
            at = opened + 5
            continue
        if html.startswith("<!--->", opened):
            at = opened + 6
            continue
        if _raw_text_at(lower, opened):
            pieces.append(_COMMENT_OPEN)
            at = opened + len(_COMMENT_OPEN)
            continue
        closed = html.find(_COMMENT_CLOSE, opened + len(_COMMENT_OPEN))
        if closed == -1:
            # An unterminated comment: nothing after it is markup.
            return " ".join(pieces)
        at = closed + len(_COMMENT_CLOSE)


def _raw_text_at(lower: str, at: int) -> bool:
    """Whether ``at`` falls inside a ``<script>`` or a ``<style>`` element's own text."""
    for opened_by, closed_by in (("<script", "</script"), ("<style", "</style")):
        opened = lower.rfind(opened_by, 0, at)
        if opened == -1:
            continue
        if lower.rfind(closed_by, 0, at) < opened:
            return True
    return False


# The libraries this build carries, as the app's catalogue writes them (`libraries.json`, generated by
# `build-canvas-catalogue.mjs` and committed). The host needs the names alone — the app holds each
# source — so this is the table a page's ask is answered against. Read once when it works and tried
# again when it doesn't: a file this install can't read leaves the rule unenforced rather than taking
# every canvas route down, or refusing a write the app would have drawn.
LIBRARIES_FILE = Path(__file__).parent / "canvas" / "libraries.json"


_LIBRARIES: Optional[Dict[str, Any]] = None


def _libraries() -> Dict[str, Any]:
    """The library names this build carries, in the guide's order, with what each of them defines.

    Read once when it works, and tried again on the next write when it doesn't: a file caught half
    written, or read while the disk hiccups, must not leave the rule off for the life of the process
    — that would be a page refused nothing and drawn with a hole, which is the failure this table
    exists to stop.
    """
    global _LIBRARIES
    if _LIBRARIES is not None:
        return _LIBRARIES
    try:
        found = json.loads(LIBRARIES_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        logger.warning("gots: couldn't read %s", LIBRARIES_FILE.name, exc_info=True)
        return {}
    if not isinstance(found, dict):
        logger.warning("gots: %s is not a table of libraries", LIBRARIES_FILE.name)
        return {}
    # An empty table is no table: caching it would leave the rule off for the life of the process,
    # which is the one failure this module exists to prevent.
    if found:
        _LIBRARIES = found
    return found


# A page's ask for a library, as the app reads it (`libraryAsks` in `canvas-document.ts`): an empty
# `<script>` naming one, other attributes allowed on either side of the name — a quoted `>` included
# — and either quote style. One grammar in two languages, held together by
# `tests/fixtures/canvas-library-asks.json`, which both suites read: a host that refused a tag the
# app would have answered would be the wrong failure.
#
# Read by walking the markup rather than by a backtracking pattern: the tag grammar is ambiguous
# enough that a page of unterminated `<script` openers — which the 256 KB cap admits — took minutes
# of a plugin thread, on every write.
_ASK_ATTRIBUTE = re.compile(
    r"""data-canvas-lib\s*=\s*(?:"([^"]*)"|'([^']*)')""", re.IGNORECASE
)
_ASK_BODY = re.compile(r"\s*</script\s*>", re.IGNORECASE)


def _tag_end(markup: str, at: int) -> int:
    """Where the tag opened at ``at`` closes: its first ``>`` outside a quoted value, or -1."""
    quote = ""
    for index in range(at, len(markup)):
        character = markup[index]
        if quote:
            if character == quote:
                quote = ""
        elif character in "\"'":
            quote = character
        elif character == ">":
            return index
        elif character == "<":
            return -1
    return -1


def _ask_name(tag: str) -> Optional[str]:
    """The name a tag asks for, or None when it carries no quoted ``data-canvas-lib``."""
    found = _ASK_ATTRIBUTE.search(tag)
    if not found:
        return None
    return found.group(1) if found.group(1) is not None else found.group(2)


def _library_asks(markup: str) -> List[str]:
    """The library names a document's markup asks for, in the order it asks them.

    ``markup`` is what ``_markup`` answers — so a commented-out ask is no ask, as it is for the app,
    which cuts the same comments before it plans a page's sources. Only an empty ``<script>`` is an
    ask: a script with content in it is the page's own code, not a placeholder for a library.
    """
    names: List[str] = []
    lowered = markup.lower()
    at = 0
    while True:
        start = lowered.find("<script", at)
        if start == -1:
            return names
        after = start + len("<script")
        # `<scriptx` is another tag's name, not a script's.
        if after < len(markup) and markup[after] not in " \t\r\n/>":
            at = after
            continue
        close = _tag_end(markup, after)
        if close == -1:
            return names
        name = _ask_name(markup[start : close + 1])
        body = _ASK_BODY.match(markup, close + 1) if name is not None else None
        if body:
            names.append(name)
            at = body.end()
            continue
        at = close + 1


def _and(names: List[str], quoted: bool = False) -> str:
    """Names as a sentence names them: ``a``, ``a and b``, ``a, b and c`` — in quotes where the
    sentence is naming what the document asked for rather than what this host carries."""
    spelled = [f'"{name}"' for name in names] if quoted else list(names)
    if len(spelled) <= 1:
        return "".join(spelled)
    return ", ".join(spelled[:-1]) + " and " + spelled[-1]


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
        if pattern.search(_without_remote_images(markup) if pattern is _REMOTE else markup):
            raise CanvasError(
                f"The canvas holds {name}, which a canvas can't use: everything it loads has to be "
                "written into the document."
            )
    # The libraries the page asks its host for. A name this build doesn't carry is a page that draws
    # a hole its reader can't see the reason for — the app drops an ask it has no source for — so it
    # is refused where it is written, naming the name and every one that would have been answered.
    # An unreadable table is no rule: the app still draws such a page, and a host can't refuse what
    # it can't say it carries.
    carried = _libraries()
    unknown = list(dict.fromkeys(name for name in _library_asks(markup) if name not in carried))
    if carried and unknown:
        raise CanvasError(
            f"The canvas asks for the {'library' if len(unknown) == 1 else 'libraries'} "
            f"{_and(unknown, quoted=True)}, "
            f"which this host doesn't carry: it carries {_and(list(carried))}. Ask for one of those "
            "instead."
        )


# --- the guide's advice ---------------------------------------------------------------------------

# A form's submit is cancelled in place by the sandbox's guard, so a form whose answer hangs off
# nothing in the document is a button that does nothing. A click handler on the button is the answer
# the guide gives, so it counts: the rule is about the page having somewhere to go, not about which
# event it chose.
_FORM = re.compile(r"(?is)<form\b")
_FORM_HANDLER = re.compile(
    r"(?i)addEventListener\(\s*[\"'](?:submit|click)[\"']|\bonsubmit\s*=|\bonclick\s*="
)
# A canvas opens at 390px in one hand, so a width the page carries on the element itself is a width
# the phone has to scroll sideways. Only an inline `style` is read: a `<style>` block is where the
# guide's own breakpoints live (`min-width: 768px`), and a rule that fires on the advice it ships with
# is worse than no rule at all.
_INLINE_STYLE = re.compile(r"(?is)\bstyle\s*=\s*(?:\"([^\"]*)\"|'([^']*)')")
_FIXED_WIDTH = re.compile(r"(?i)(?<![-a-z])(?:min-)?width\s*:\s*(\d{3,4})px")
PHONE_WIDTH = 390


def warnings(html: Any) -> List[str]:
    """The guide's own rules, as advice the answer to a write carries: empty when the page keeps them.

    Advice and never a gate: the version is stored either way, because the scan is what refuses and
    this is only what the guide would have said. So nothing here raises — a page the rules can't be
    read out of is a page answered without advice, which is no reason to lose a write.

    Only rules a bot can act on, and only ones that never overrule the user: a named look, brand or
    palette is the design (the guide says so first), so nothing here judges a colour. What is left is
    a page that can't work — a form whose answer goes nowhere, and a width the phone must scroll.
    """
    text = html if isinstance(html, str) else ""
    try:
        markup = _markup(text)
        said: List[str] = []
        if _FORM.search(markup) and not _FORM_HANDLER.search(text):
            said.append(
                "The page has a <form> and nothing handling its submit or a click inside it, and "
                "its submit is cancelled in place: handle the button's click."
            )
        wide = next(
            (
                int(px)
                for style in _INLINE_STYLE.findall(markup)
                for px in _FIXED_WIDTH.findall(style[0] or style[1])
                if int(px) > PHONE_WIDTH
            ),
            None,
        )
        if wide is not None:
            said.append(
                f"The page sets a {wide}px width on an element, past the {PHONE_WIDTH}px phone it "
                "opens on: let it fill the screen instead."
            )
        return said
    except Exception:
        logger.debug("gots: couldn't read a canvas for the guide's warnings", exc_info=True)
        return []


# --- the record ----------------------------------------------------------------------------------

_COLUMNS = (
    "id",
    "title",
    "session_id",
    "chat_id",
    "version",
    "pinned",
    "archived",
    "image",
    "at",
    "created_at",
)
_RECORD = ", ".join(_COLUMNS)


def _row(row: Any) -> Dict[str, Any]:
    record = dict(zip(_COLUMNS, row))
    record["pinned"] = bool(record["pinned"])
    record["archived"] = bool(record["archived"])
    return record


def _record(conn: sqlite3.Connection, canvas_id: str) -> Optional[Dict[str, Any]]:
    """One canvas's record over a connection the caller holds."""
    row = conn.execute(f"SELECT {_RECORD} FROM canvases WHERE id = ?", (canvas_id,)).fetchone()
    return _row(row) if row else None


def _exists(conn: sqlite3.Connection, canvas_id: str) -> bool:
    """Whether this store has that canvas, without its record — and so without its picture.

    A data write only asks that the canvas is there, and a record carries the tile's picture, up to
    192 KB: reading it to answer "does this exist" copies the picture on a path that holds the write
    lock, so every other writer waits behind a row nobody needed.
    """
    row = conn.execute("SELECT 1 FROM canvases WHERE id = ?", (canvas_id,)).fetchone()
    return row is not None


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
    """Every canvas this bot has, the one written to last first.

    The clock is milliseconds and two writes can share one, so the rowid breaks the tie: a list
    ordered by the clock alone would fall back to insertion order and put the older canvas first.
    """
    if not path.exists():
        return []
    conn = connect(path)
    try:
        rows = conn.execute(f"SELECT {_RECORD} FROM canvases ORDER BY at DESC, rowid DESC").fetchall()
    finally:
        conn.close()
    return [_row(row) for row in rows]


# --- the names -----------------------------------------------------------------------------------

# What a canvas is called and where it sits in a list, and nothing of what it holds: a record's
# picture rides the record, and no name is read by parsing up to ``IMAGE_CHARS`` of one.
_NAME_COLUMNS = ("id", "title", "archived", "at")
_NAMES = ", ".join(_NAME_COLUMNS)


def _name_row(row: Any) -> Dict[str, Any]:
    name = dict(zip(_NAME_COLUMNS, row))
    name["archived"] = bool(name["archived"])
    return name


def names(path: Path) -> List[Dict[str, Any]]:
    """Every canvas this bot has, as a name — its id, its title, whether it is archived and the
    clock the list is ordered by — the one written to last first.

    The list reads this rather than ``listing``: a record's picture is up to 192 KB a row and names
    nothing, so a name is never parsed out of one. The rowid breaks an `at` tie, as in ``listing``.
    """
    if not path.exists():
        return []
    conn = connect(path)
    try:
        rows = conn.execute(f"SELECT {_NAMES} FROM canvases ORDER BY at DESC, rowid DESC").fetchall()
    finally:
        conn.close()
    return [_name_row(row) for row in rows]


def _answers_to(named: str, canvas_id: str, title: Optional[str]) -> bool:
    """Whether ``named`` names the canvas that is ``canvas_id`` and ``title``.

    The one rule for what a name answers to: the store's key exactly, since a title can never
    shadow an id, and the title without case, since a caller that knows a canvas's name doesn't
    know its capitals. ``resolve`` asks it of every canvas's names, and a canvas's own session asks
    ``resolve`` as well — so a name means the same canvas in every session, or none.
    """
    return named == canvas_id or (title is not None and named.casefold() == title.casefold())


def resolve(path: Path, name: Any) -> str:
    """The id of the canvas a caller named, by its id first and then its title without case.

    An id is the store's key and a title is not, so the key answers first and a title can never
    shadow one. A title is matched casefold over ``names``: one canvas answering is the canvas,
    several are refused with their ids — a title is not unique, and a guess that writes to the
    wrong canvas has nothing to undo it — and none is refused with what was looked for. Both
    refusals point at ``canvas_list``, which names every canvas this bot has.
    """
    if not isinstance(name, str) or not name.strip():
        raise CanvasError(
            f"A canvas is named by its title or its id; {name!r} is not a name. "
            f"{TOOL_LIST} names every canvas this bot has."
        )
    every = names(path)
    matched = [found for found in every if _answers_to(name, found["id"], found["title"])]
    keyed = next((found for found in matched if found["id"] == name), None)
    if keyed is not None:
        return keyed["id"]
    if len(matched) == 1:
        return matched[0]["id"]
    if matched:
        ids = ", ".join(found["id"] for found in matched)
        raise CanvasError(
            f'{len(matched)} canvases are called "{name}": {ids}. Name one of them by its id. '
            f"{TOOL_LIST} lists them."
        )
    raise CanvasError(
        f'No canvas is called "{name}", by its title or its id. {TOOL_LIST} names every canvas '
        "this bot has."
    )


def _version(conn: sqlite3.Connection, canvas_id: str, number: int) -> Optional[Dict[str, Any]]:
    """One version's document and the tools it declared, over a connection the caller holds."""
    row = conn.execute(
        "SELECT version, html, tools, at FROM canvas_versions WHERE canvas_id = ? AND version = ?",
        (canvas_id, number),
    ).fetchone()
    if row is None:
        return None
    return {
        "version": row[0],
        "html": row[1],
        "tools": json.loads(row[2]) if row[2] else [],
        "written_at": row[3],
    }


def _empty_version(found: Dict[str, Any]) -> Dict[str, Any]:
    """A canvas nothing has been written to yet: no document, no tools, and its record's clock."""
    return {"version": 0, "html": "", "tools": [], "written_at": found["at"]}


def _greatest_below(conn: sqlite3.Connection, canvas_id: str, version: int) -> Optional[int]:
    """The greatest stored version under ``version``, or None when nothing is stored below it."""
    row = conn.execute(
        "SELECT MAX(version) FROM canvas_versions WHERE canvas_id = ? AND version < ?",
        (canvas_id, version),
    ).fetchone()
    return row[0] if row and row[0] is not None else None


def _answer(
    conn: sqlite3.Connection,
    found: Dict[str, Any],
    version: Dict[str, Any],
    can_undo: bool,
) -> Dict[str, Any]:
    """A canvas as the app draws it: its record, the version the record points at, whether a
    version sits under that one to undo to, and the user's answers for the tools it declares.

    The grants ride every one-canvas answer because they are the canvas's, not a version's: the
    page's calls are refused or allowed by them, and the options sheet that changes them reads the
    canvas it is changing (ADR 0114). They carry the host's clock for each answer, so a device can
    tell which of two answers it holds is the later one without comparing whole lists.
    """
    return {
        **found,
        **version,
        "can_undo": can_undo,
        "grants": _grants(conn, found["id"]),
    }


@contextmanager
def _writing(path: Path) -> Iterator[sqlite3.Connection]:
    """A connection inside the store's write lock: committed on a clean exit, rolled back and closed
    however the block ends.

    Every write in this module takes the lock the same way, and reads what the write is built on
    inside it: two writers racing would otherwise both take the same version number, or both fit
    under the data's cap when only one of them does.
    """
    conn = connect(path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        yield conn
        conn.execute("COMMIT")
    except BaseException:
        if conn.in_transaction:
            conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()


def _page(conn: sqlite3.Connection, canvas_id: str) -> Dict[str, Any]:
    """A canvas's record and the version it points at, over a connection the caller holds."""
    found = _record(conn, canvas_id)
    if found is None:
        raise CanvasError("There is no such canvas.", 404)
    version = _version(conn, canvas_id, found["version"]) or _empty_version(found)
    # A canvas at its first version, or one whose older versions were trimmed, has nothing to undo:
    # the read of what sits under the pointer is on this same connection.
    under = _greatest_below(conn, canvas_id, version["version"])
    return _answer(conn, found, version, under is not None)


def page(path: Path, canvas_id: str) -> Dict[str, Any]:
    """A canvas's page alone — its record and the version it points at — and not its data.

    What a read of the page itself answers, which is what ``canvas_read`` is asked for: the agent
    has the data tools for the canvas's documents, so a page read never parses them.
    """
    if not canvas_id or not path.exists():
        raise CanvasError("There is no such canvas.", 404)
    conn = connect(path)
    try:
        return _page(conn, canvas_id)
    finally:
        conn.close()


def current(path: Path, canvas_id: str) -> Dict[str, Any]:
    """A canvas as the app draws it, answered from one connection: its record, the version the
    record points at, whether there is a version under it to undo to, and the data it keeps."""
    if not canvas_id or not path.exists():
        raise CanvasError("There is no such canvas.", 404)
    conn = connect(path)
    try:
        # The data beside the page, on this same connection: a page that keeps state needs it the
        # moment it opens, and no version has ever touched it.
        return {**_page(conn, canvas_id), "data": _documents(conn, canvas_id)}
    finally:
        conn.close()


def title_of(prompt: Any) -> str:
    """A canvas's title as the store keeps it — one line, at most ``TITLE_CHARS`` — or ``Canvas``.

    The chat's title too, both on a canvas's first run and on a rename, so the two never disagree.
    """
    return new_chats.one_line(prompt, TITLE_CHARS) or "Canvas"


def _tool_name(name: Any) -> str:
    """``name`` as a tool the store may keep, or a 400 naming it.

    A declared name is an option row, a consent dialog and a grant, so a name that isn't a tool on a
    server would be a page's row nothing can ever call: it is refused where it is written, by the
    one rule that says what a tool's name is (``mcp_call.split``), and so is the canvas's own data,
    which the call route answers before consent is consulted.
    """
    if not isinstance(name, str) or not name:
        raise CanvasError("A tool is named <server>.<tool>; this one is not a name at all.")
    try:
        server, _tool = mcp_call.split(name)
    except mcp.McpError:
        raise CanvasError(f"A tool is named <server>.<tool>; {name!r} is not one.")
    if server == "data":
        raise CanvasError(
            f"The canvas's own data is reached with canvas.data.*, not a tool; {name!r} is not "
            "something a version declares."
        )
    if len(name) > TOOL_NAME_CHARS:
        raise CanvasError(
            f"A tool's name is at most {TOOL_NAME_CHARS} characters; {name!r} is {len(name)}."
        )
    return name


def _image(raw: Any) -> str:
    """``raw`` as the picture a canvas's tile draws, or a 400 naming why.

    A picture is a data URL — an inline image the list already holds, never something a device has to
    fetch — and an empty string clears it, which is how a canvas goes back to its own mark.
    """
    if not isinstance(raw, str):
        raise CanvasError("A canvas's image is an inline picture, as a data URL.")
    if not raw:
        return ""
    if len(raw) > IMAGE_CHARS:
        raise CanvasError(
            f"A canvas's image is at most {IMAGE_CHARS // 1024} KB; this one is "
            f"{(len(raw) + 1023) // 1024} KB."
        )
    if not raw.startswith("data:image/") or ";base64," not in raw:
        raise CanvasError("A canvas's image is an inline picture, as a data URL.")
    return raw


def declarable(name: Any) -> bool:
    """Whether a version may declare ``name``: ``_tool_name``'s rule, asked as a question."""
    try:
        _tool_name(name)
    except CanvasError:
        return False
    return True


def _tools(raw: Any) -> Optional[str]:
    """A declared consent list as it is stored: names, deduplicated, in the order they were asked.

    Every name is held to the one rule for a tool's name, and the list to ``TOOLS_MAX``: a version's
    list is what its page may call, and each name becomes an option row, a dialog and a grant, so a
    name nothing could ever call — or a list no sheet could draw — is refused here rather than
    stored as a promise the app can't keep.
    """
    if raw is None:
        return None
    if not isinstance(raw, list):
        raise CanvasError("tools must be a list of tool names.")
    if len(raw) > TOOLS_MAX:
        raise CanvasError(
            f"A version declares at most {TOOLS_MAX} tools; this one declares {len(raw)}."
        )
    return json.dumps(list(dict.fromkeys(_tool_name(name) for name in raw)))


def _apply(html: str, edits: List[Any]) -> str:
    """The document with every find and replace pair applied in order.

    Each ``find`` has to match exactly once: a pair matching none or several writes nothing at all,
    since a page that landed half-way is a change nobody asked for. A refusal names the pair by its
    1-based place and how many the edit holds.
    """
    for index, pair in enumerate(edits, start=1):
        if not isinstance(pair, dict):
            raise CanvasError(f"Edit {index} of {len(edits)} is not a find and replace pair.")
        find, replace = pair.get("find"), pair.get("replace")
        if not isinstance(find, str) or not find:
            raise CanvasError(f"Edit {index} of {len(edits)} needs a find: the text to look for.")
        if not isinstance(replace, str):
            raise CanvasError(
                f'Edit {index} of {len(edits)} needs a replace: what stands in its place, or "" to '
                "cut it."
            )
        count = html.count(find)
        if count != 1:
            raise CanvasError(
                f'Edit {index} of {len(edits)}: "{find}" matches {count} times; an edit needs '
                "exactly one."
            )
        html = html.replace(find, replace, 1)
    return html


def write(
    path: Path,
    canvas_id: str,
    html: Any,
    title: Optional[Any] = None,
    tools: Any = None,
    image: Any = None,
) -> Dict[str, Any]:
    """Stores a write as the canvas's next version, and answers the canvas as it now is.

    A write is one version: the whole document, scanned, stored, and the record's version moved on
    in the same transaction. Only the newest ``KEEP_VERSIONS`` are kept, and an older one going is
    the oldest version's row — never the one the record points at, which is what a canvas is. A title
    writes the canvas's and its chat's together, so a rename is one name. A picture is the record's
    rather than the version's — it is what the list draws — and a write that names none leaves the
    one it had.
    """
    return _commit(path, canvas_id, html=html, title=title, tools=tools, image=image)


def edit(path: Path, canvas_id: str, edits: Any, tools: Any = None) -> Dict[str, Any]:
    """Changes a canvas by find and replace, stored as one version, and answers it as it now is.

    Every pair is applied in order to the version the user is looking at, and that version is read
    inside the transaction the edit writes in — so an undo landing between the two can't be reverted
    by an edit built from the version it walked off. The version carries the tools it declared
    forward unless this edit declares its own.
    """
    if not isinstance(edits, list) or not edits:
        raise CanvasError("edits must be a list of find and replace pairs.")
    return _commit(path, canvas_id, edits=edits, tools=tools)


def _commit(
    path: Path,
    canvas_id: str,
    *,
    html: Any = None,
    edits: Optional[List[Any]] = None,
    title: Optional[Any] = None,
    tools: Any = None,
    image: Any = None,
) -> Dict[str, Any]:
    """One version, written under the store's write lock, and the canvas as it now is.

    ``html`` is a write's whole document; ``edits`` are an edit's pairs, applied to the version the
    record points at, which is read on this connection under this transaction. Both answer the
    shape ``current`` does but for its ``data``: a version never touches a canvas's data.
    """
    named = title_of(title) if isinstance(title, str) and title.strip() else None
    pictured = _image(image) if image is not None else None
    with _writing(path) as conn:
        now = int(time.time() * 1000)
        # Read under the write lock: two writers racing here would otherwise both take the same
        # number, and the second would fail on the versions' primary key.
        found = _record(conn, canvas_id)
        if found is None:
            raise CanvasError("There is no such canvas.", 404)
        if edits is None:
            document = html
            declared = _tools(tools)
        else:
            # An edit is built from the version the record points at, read here rather than before
            # the transaction: an undo landing in between would otherwise be silently reverted.
            pointer = _version(conn, canvas_id, found["version"])
            if pointer is None or not pointer["html"]:
                raise CanvasError("This canvas has no document yet: write it with canvas_write first.")
            document = _apply(pointer["html"], edits)
            declared = _tools(tools) if tools is not None else json.dumps(pointer["tools"])
        scan(document)
        # The version above the one the record points at. An undo left the versions it walked off
        # stored and unreachable — there is no redo — and a write replaces that history rather than
        # sitting on top of it: otherwise a later undo would land on the page the user rejected.
        conn.execute(
            "DELETE FROM canvas_versions WHERE canvas_id = ? AND version > ?",
            (canvas_id, found["version"]),
        )
        number = found["version"] + 1
        conn.execute(
            """INSERT INTO canvas_versions (canvas_id, version, html, tools, at)
               VALUES (?, ?, ?, ?, ?)""",
            (canvas_id, number, document, declared, now),
        )
        conn.execute(
            """UPDATE canvases SET version = ?, at = ?, title = COALESCE(?, title),
                                 image = COALESCE(?, image)
               WHERE id = ?""",
            (number, now, named, pictured, canvas_id),
        )
        conn.execute(
            """DELETE FROM canvas_versions
               WHERE canvas_id = ? AND version <= ?""",
            (canvas_id, number - KEEP_VERSIONS),
        )
        # What sits under the version just written, read before the commit rather than after it.
        can_undo = _greatest_below(conn, canvas_id, number) is not None
        answer = _answer(
            conn,
            {
                **found,
                "title": named or found["title"],
                "version": number,
                "at": now,
                **({"image": pictured} if pictured is not None else {}),
            },
            {
                "version": number,
                "html": document,
                "tools": json.loads(declared) if declared else [],
                "written_at": now,
            },
            can_undo,
        )
    if named:
        # The version is stored either way: a chat this can't rename is a title that lags, not a
        # write that failed.
        try:
            chats.set_title(path, found["chat_id"], named)
        except Exception:
            logger.debug("gots: couldn't rename %s's chat", canvas_id, exc_info=True)
    events.note("canvas", found["session_id"], path, True)
    return answer


def undo(path: Path, canvas_id: str) -> Dict[str, Any]:
    """Moves a canvas's current version back one, and answers it as the app draws it.

    Undo is the pointer and nothing else: the versions above it stay stored but unreachable, since
    there is no redo, and the first version has nothing under it to walk back to. The answer is read
    on the connection the pointer was moved on, so it costs one connection rather than four, and it
    carries the canvas's data like every other one-canvas answer — the data is no version's, so an
    undo leaves every document where it was.
    """
    if not path.exists():
        raise CanvasError("There is no such canvas.", 404)
    with _writing(path) as conn:
        now = int(time.time() * 1000)
        found = _record(conn, canvas_id)
        if found is None:
            raise CanvasError("There is no such canvas.", 404)
        number = _greatest_below(conn, canvas_id, found["version"])
        if number is None:
            raise CanvasError("This canvas has no earlier version to undo to.", 409)
        conn.execute(
            "UPDATE canvases SET version = ?, at = ? WHERE id = ?", (number, now, canvas_id)
        )
        version = _version(conn, canvas_id, number) or _empty_version(found)
        can_undo = _greatest_below(conn, canvas_id, number) is not None
        answer = {
            **_answer(conn, {**found, "version": number, "at": now}, version, can_undo),
            "data": _documents(conn, canvas_id),
        }
    events.note("canvas", found["session_id"], path, True)
    return answer


def _flag(value: Any, field: str) -> bool:
    if not isinstance(value, bool):
        raise CanvasError(f"A canvas's {field} is true or false; this one is {value!r}.")
    return value


def update(path: Path, canvas_id: str, body: Any) -> Dict[str, Any]:
    """Changes a canvas's name and its place in the list, and answers its record as it now is.

    The three are the host's, not the app's: a device that pins a canvas and one that hides it
    write one record, so every device draws the same list. A title renames the chat too — a canvas
    and its thread are one name, as ``_commit`` writes them — and ``chats.set_title`` keeps
    ``titleEdited``, so Hermes's auto-title never takes the canvas's name away.

    The answer is the record alone: a name or a place is not the page, and a screen that changed one
    already holds the version it draws, so it keeps its document rather than reading 256 KB back.
    A body naming none of the three is nobody's change; a flag that isn't a boolean or a title that
    isn't a line of text is refused rather than stored, since a record the app can't draw is worse
    than a refusal it can show. The record's clock moves on the host's, taken under the write lock
    like every other write here, since the list is ordered by it.
    """
    if not any(field in body for field in ("title", "pinned", "archived", "image")):
        raise CanvasError("A canvas's update names what changes: a title, pinned, archived, or image.")
    changes: Dict[str, Any] = {}
    if "title" in body:
        if not isinstance(body["title"], str) or not body["title"].strip():
            raise CanvasError("A canvas's title is a line of text; this one is blank.")
        changes["title"] = title_of(body["title"])
    for field in ("pinned", "archived"):
        if field in body:
            changes[field] = _flag(body[field], field)
    if "image" in body:
        changes["image"] = _image(body["image"])
    with _writing(path) as conn:
        found = _record(conn, canvas_id)
        if found is None:
            raise CanvasError("There is no such canvas.", 404)
        now = int(time.time() * 1000)
        # COALESCE: a body changes only the fields it names, so a pin never clears a title.
        conn.execute(
            """UPDATE canvases
               SET title = COALESCE(?, title), pinned = COALESCE(?, pinned),
                   archived = COALESCE(?, archived), image = COALESCE(?, image), at = ?
               WHERE id = ?""",
            (
                changes.get("title"),
                changes.get("pinned"),
                changes.get("archived"),
                changes.get("image"),
                now,
                canvas_id,
            ),
        )
        answer = _record(conn, canvas_id) or found
        # Whether a version sits under the drawn one rides the answer: the record alone would read as
        # a canvas with nothing to undo, and the screen would lose its Undo until the next read.
        answer["can_undo"] = _greatest_below(conn, canvas_id, answer["version"]) is not None
    named = changes.get("title")
    if named:
        # A chat this can't rename is a title that lags, not an update that failed.
        try:
            chats.set_title(path, found["chat_id"], named)
        except Exception:
            logger.warning("gots: renamed %s but not its chat", canvas_id, exc_info=True)
    events.note("canvas", found["session_id"], path, True)
    return answer


def _erase(conn: sqlite3.Connection, canvas_id: str) -> None:
    conn.execute("DELETE FROM canvases WHERE id = ?", (canvas_id,))
    conn.execute("DELETE FROM canvas_versions WHERE canvas_id = ?", (canvas_id,))
    conn.execute("DELETE FROM canvas_docs WHERE canvas_id = ?", (canvas_id,))
    conn.execute("DELETE FROM canvas_grants WHERE canvas_id = ?", (canvas_id,))


def delete(
    path: Path, canvas_id: str, *, home: Path, db: Any = None
) -> Dict[str, Any]:
    """Takes a canvas out of the store, and ends the thread and the Hermes session it was made in.

    A canvas deleted on one device has to be gone on every one, so this is the host's record first:
    the row and its versions, documents and grants in one transaction. The event is noted as soon as
    it is — the record is gone and every device's list has to hear it — and the session's own end
    (``cleanup.end_session``: the chat as a tombstone, Hermes's session, the attachments folder)
    follows, so nothing a device waits on holds its row in the list.

    The session end is best effort and never fails the delete: a store this can't reach is a
    session left behind rather than a canvas the user still sees.
    """
    with _writing(path) as conn:
        found = _record(conn, canvas_id)
        if found is None:
            raise CanvasError("There is no such canvas.", 404)
        now = int(time.time() * 1000)
        _erase(conn, canvas_id)
    # A queued turn for this canvas would be posted to a session that is about to be gone.
    try:
        outbox.drop(path, found["session_id"])
    except Exception:
        logger.debug("gots: couldn't drop %s's queued turns", found["session_id"], exc_info=True)
    events.note("canvas", found["session_id"], path, True)
    cleanup.end_session(path, found["chat_id"], found["session_id"], home, db, now)
    return {"deleted": True, "id": canvas_id}


# --- the data ------------------------------------------------------------------------------------

# One order for every read, so a page's list of a collection is the same however its writes landed.
_DOCUMENTS = "SELECT collection, id, value, at FROM canvas_docs WHERE canvas_id = ?"


def _document(collection: str, doc_id: str, value: str, at: int) -> Dict[str, Any]:
    """One row of ``canvas_docs`` as the document it holds: a collection, an id, the document and
    the host's clock for it."""
    return {"collection": collection, "id": doc_id, "doc": json.loads(value), "at": at}


def _documents(
    conn: sqlite3.Connection,
    canvas_id: str,
    collection: Optional[str] = None,
    doc_id: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """A canvas's documents, ordered by collection then id, narrowed by whichever name is given.

    The narrowing is the read's own: a page or a bot asking for one document costs one point lookup
    on the table's primary key rather than a parse of everything the canvas keeps.
    """
    query, args = _DOCUMENTS, [canvas_id]
    if collection is not None:
        query += " AND collection = ?"
        args.append(collection)
    if doc_id is not None:
        query += " AND id = ?"
        args.append(doc_id)
    rows = conn.execute(query + " ORDER BY collection, id", args).fetchall()
    return [_document(*row) for row in rows]


def data(
    path: Path,
    canvas_id: str,
    collection: Optional[str] = None,
    doc_id: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """A canvas's documents — all of them, one collection's or one — ordered as the store keeps them.

    Read over a connection of its own, opened and closed like ``listing``. A canvas this store has
    never heard of is a 404, as it is for a write and for a read of the page: one rule for "there is
    no such canvas", whichever part of it was asked for.
    """
    if not canvas_id or not path.exists():
        raise CanvasError("There is no such canvas.", 404)
    if collection is not None:
        collection = _name(collection, "collection")
    if doc_id is not None:
        doc_id = _name(doc_id, "id")
    conn = connect(path)
    try:
        if not _exists(conn, canvas_id):
            raise CanvasError("There is no such canvas.", 404)
        return _documents(conn, canvas_id, collection, doc_id)
    finally:
        conn.close()


def _name(value: Any, what: str) -> str:
    """A collection or a document id as a page sends one: a short name, with no control character
    and no surrogate.

    The page names its own collections and documents, so these are checked rather than trusted: a
    name is what a JSON key and a URL can carry, and a newline or a NUL in one is a page writing
    something it didn't mean to. A surrogate code point is not text at all — it has no UTF-8 bytes —
    so a name holding one would fail where the store writes it rather than here.
    """
    if not isinstance(value, str) or not value:
        raise CanvasError(f"A document's {what} is a name of 1 to {NAME_CHARS} characters.")
    if len(value) > NAME_CHARS:
        raise CanvasError(
            f"A document's {what} is at most {NAME_CHARS} characters; this one is {len(value)}."
        )
    if any(ord(character) < 32 or ord(character) == 127 for character in value):
        raise CanvasError(f"A document's {what} can't hold a control character.")
    if any(0xD800 <= ord(character) <= 0xDFFF for character in value):
        raise CanvasError(
            f"A document's {what} can't hold a surrogate code point: it has no UTF-8 bytes, so the "
            "store could not keep it."
        )
    return value


def _json(doc: Any) -> str:
    """A document as it is stored, refusing what JSON can't carry rather than storing a surprise.

    ``allow_nan`` is off because ``NaN`` and ``Infinity`` are Python's and not JSON's: a page that
    read one back couldn't parse it.
    """
    try:
        return json.dumps(doc, allow_nan=False)
    except (TypeError, ValueError):
        raise CanvasError(
            "A document has to be JSON: a canvas's data is stored as JSON, so every value in a "
            "document has to be one."
        ) from None


def _stored_bytes(
    conn: sqlite3.Connection, canvas_id: str, collection: str, doc_id: str, value: str
) -> int:
    """A canvas's data in bytes, with one write counted in place of the row it replaces.

    Measured by SQLite rather than by walking every row here: each row counts its collection, its id,
    its JSON value as UTF-8 bytes, and ``DOC_BYTES`` for the envelope a read carries for it — so the
    cap bounds the answer a page is handed, not only the text inside it. A write onto a row already
    there counts that row once, as the document about to land, so an update that fits is never
    refused for the bytes it is about to release.
    """
    counted = conn.execute(
        """SELECT COALESCE(SUM(length(CAST(collection AS BLOB)) + length(CAST(id AS BLOB))
                              + length(CAST(value AS BLOB)) + ?), 0)
           FROM canvas_docs WHERE canvas_id = ? AND NOT (collection = ? AND id = ?)""",
        (DOC_BYTES, canvas_id, collection, doc_id),
    ).fetchone()[0]
    return (
        counted
        + DOC_BYTES
        + len(collection.encode("utf-8"))
        + len(doc_id.encode("utf-8"))
        + len(value.encode("utf-8"))
    )


def put_doc(path: Path, canvas_id: str, collection: Any, doc_id: Any, doc: Any) -> Dict[str, Any]:
    """Stores one document as the canvas's own, and answers it as it now is.

    A document is one row of its canvas's data: the last write wins, on the host's clock rather than
    anything the caller sent. The whole of the data is capped at ``DATA_BYTES``, read under the
    write lock with this write counted in, so two writers racing can't both fit under it — and a
    write past it is refused whole, leaving every document the canvas had where it was.
    """
    collection = _name(collection, "collection")
    doc_id = _name(doc_id, "id")
    value = _json(doc)
    with _writing(path) as conn:
        if not _exists(conn, canvas_id):
            raise CanvasError("There is no such canvas.", 404)
        # The clock is read under the lock, so `at` follows the order the writes landed in: two
        # racing writers can't store the later stamp first and be read as the older one.
        now = int(time.time() * 1000)
        size = _stored_bytes(conn, canvas_id, collection, doc_id, value)
        if size > DATA_BYTES:
            raise CanvasError(
                "A canvas's data is capped at 1 MB; this write would make it "
                f"{-(-size // 1024)} KB. Remove something first."
            )
        conn.execute(
            """INSERT INTO canvas_docs (canvas_id, collection, id, value, at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(canvas_id, collection, id)
               DO UPDATE SET value = excluded.value, at = excluded.at""",
            (canvas_id, collection, doc_id, value, now),
        )
    # The answer is the stored document read back, not the caller's object: what a page reads next
    # is exactly this, whatever it sent.
    return _document(collection, doc_id, value, now)


def remove_doc(path: Path, canvas_id: str, collection: Any, doc_id: Any) -> Dict[str, Any]:
    """Takes one document out of a canvas's data, and answers whether there was one.

    Removing a document that isn't there is no error: a page asks again for a remove whose answer
    came slowly, and the second ask is the one that lands. A canvas this store has never heard of
    is still a 404, since no page of it can be open.
    """
    collection = _name(collection, "collection")
    doc_id = _name(doc_id, "id")
    with _writing(path) as conn:
        if not _exists(conn, canvas_id):
            raise CanvasError("There is no such canvas.", 404)
        removed = conn.execute(
            "DELETE FROM canvas_docs WHERE canvas_id = ? AND collection = ? AND id = ?",
            (canvas_id, collection, doc_id),
        ).rowcount
    return {"collection": collection, "id": doc_id, "removed": removed > 0}


def put_call(path: Path, canvas_id: str, args: Any) -> Dict[str, Any]:
    """One ``data.put`` call, as the page's route and the agent's tool both make it.

    The document is the call's whole point, so the key's presence decides — a stored null is a value
    a page wrote — and a call naming none is refused here rather than storing a null nobody wrote.
    """
    args = args if isinstance(args, dict) else {}
    if "doc" not in args:
        raise CanvasError("A write call needs the doc to store, or remove: true to remove one.")
    return put_doc(path, canvas_id, args.get("collection"), args.get("id"), args["doc"])


def remove_call(path: Path, canvas_id: str, args: Any) -> Dict[str, Any]:
    """One ``data.remove`` call, as the page's route and the agent's tool both make it."""
    args = args if isinstance(args, dict) else {}
    return remove_doc(path, canvas_id, args.get("collection"), args.get("id"))


def write_call(path: Path, canvas_id: str, args: Any) -> Dict[str, Any]:
    """The agent's one write tool: a document to store, or ``remove: true`` to take one out."""
    args = args if isinstance(args, dict) else {}
    if args.get("remove") is True:
        return remove_call(path, canvas_id, args)
    return put_call(path, canvas_id, args)


# --- the tools a version declares -----------------------------------------------------------------

# One order for every read, so the app's list of a canvas's answers is the same whichever read
# asks for it, and two tools landed together are still two rows a reader can follow. The clock rides
# every row: it is how the app tells which of two answers it holds is the later one.
_GRANTS = "SELECT tool, allowed, at FROM canvas_grants WHERE canvas_id = ? ORDER BY tool"


def declares(tools: Any, tool: str) -> bool:
    """Whether a version's declared list holds ``tool``.

    A version's list is the whole of what its page may ask the host for: a name outside it is
    refused before the user is asked anything, which is why the list is stored with the words of
    that version rather than read off the page (ADR 0114).
    """
    return isinstance(tools, list) and tool in tools


def _grants(conn: sqlite3.Connection, canvas_id: str) -> List[Dict[str, Any]]:
    """A canvas's answers, one per tool, over a connection the caller holds."""
    rows = conn.execute(_GRANTS, (canvas_id,)).fetchall()
    return [{"tool": tool, "allowed": bool(allowed), "at": at} for tool, allowed, at in rows]


def _tools_of(conn: sqlite3.Connection, canvas_id: str, version: int) -> List[str]:
    """The tools one version declared, over a connection the caller holds.

    Its own column and no document: these are two reads on the consent path, and a version's page is
    up to 256 KB that says nothing about what it may call.
    """
    row = conn.execute(
        "SELECT tools FROM canvas_versions WHERE canvas_id = ? AND version = ?", (canvas_id, version)
    ).fetchone()
    return json.loads(row[0]) if row and row[0] else []


def may_call(path: Path, canvas_id: str, tool: str) -> str:
    """What a page's call to ``tool`` may do, as one of ``page_calls``' verdicts.

    The two facts that decide it are read here rather than by the route: the current version must
    declare the tool, and the canvas's grant for it must say the user allowed it. A tool never asked
    about is ``consent_required`` rather than refused, since the page's first call is what raises the
    question. A canvas that isn't there raises, so the route answers 404 as it does for its data.

    An answer is the user's for a tool and not for a verb, so granting it lets the page both read and
    change what it names; the call's own ``write`` flag is the act lock's business, not this one's.
    """
    if not canvas_id or not path.exists():
        raise CanvasError("There is no such canvas.", 404)
    conn = connect(path)
    try:
        found = _record(conn, canvas_id)
        if found is None:
            raise CanvasError("There is no such canvas.", 404)
        if not declares(_tools_of(conn, canvas_id, found["version"]), tool):
            return page_calls.NOT_DECLARED
        row = conn.execute(
            "SELECT allowed FROM canvas_grants WHERE canvas_id = ? AND tool = ?", (canvas_id, tool)
        ).fetchone()
    finally:
        conn.close()
    if row is None:
        return page_calls.CONSENT_REQUIRED
    return page_calls.ALLOWED if row[0] else page_calls.DENIED


def grant(path: Path, canvas_id: str, tool: Any, allow: Any) -> Dict[str, Any]:
    """Records the user's answer for one tool a canvas's page declares, and answers what it holds.

    A name that is not one is refused, and so is an answer for a tool this canvas never answered
    about and the version the user is looking at does not declare: an answer belongs to a question
    that version asked, and a name no page could ever call is no question at all. A row already
    recorded is another matter — the options list every answer the host holds, so a grant can be
    changed (at least revoked) after a later version stopped declaring its tool.

    The row outlives the version, so a page written again keeps the answers it was given, and the
    version's list is what still decides what may be called — a later version that stops declaring a
    tool can't call it, granted or not.

    The row comes back with every answer the canvas holds: the screen that asked draws the switch it
    flipped and the rest of its options without another read, and both are read in the one write's
    transaction, so the list is what that write left rather than what a later read happens to find.
    """
    if not isinstance(tool, str) or not tool:
        raise CanvasError("A grant names its tool: <server>.<tool>.")
    _tool_name(tool)
    if not isinstance(allow, bool):
        raise CanvasError("A grant says whether the page may call the tool: allow true or false.")
    with _writing(path) as conn:
        found = _record(conn, canvas_id)
        if found is None:
            raise CanvasError("There is no such canvas.", 404)
        answered = conn.execute(
            "SELECT 1 FROM canvas_grants WHERE canvas_id = ? AND tool = ?", (canvas_id, tool)
        ).fetchone()
        if answered is None and not declares(_tools_of(conn, canvas_id, found["version"]), tool):
            raise CanvasError(
                f"The version this canvas shows does not declare {tool!r}, so there is nothing to "
                "allow. Ask the bot to write a version that declares it."
            )
        # The host's clock, read under the lock, so the answers read in the order they were given.
        now = int(time.time() * 1000)
        conn.execute(
            """INSERT INTO canvas_grants (canvas_id, tool, allowed, at) VALUES (?, ?, ?, ?)
               ON CONFLICT(canvas_id, tool)
               DO UPDATE SET allowed = excluded.allowed, at = excluded.at""",
            (canvas_id, tool, 1 if allow else 0, now),
        )
        row = {"tool": tool, "allowed": allow, "at": now}
        return {"grant": row, "grants": _grants(conn, canvas_id)}


def _insert(path: Path, found: Dict[str, Any]) -> None:
    conn = connect(path)
    try:
        conn.execute(
            """INSERT INTO canvases (id, title, session_id, chat_id, version, pinned, archived, at,
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
    """Takes a record back whose first run never got queued, with everything that was its."""
    conn = connect(path)
    try:
        _erase(conn, canvas_id)
    finally:
        conn.close()


def _named_chat(path: Path, value: Any) -> Optional[str]:
    """The chat id a caller made for its canvas, as it named it; None for a caller that named none.

    A canvas's chat is an id the caller mints and hands back so the canvas opens on it, and its
    session is derived from it — so a value that isn't a name would become half a session and half a
    link. The name has to be one the upload route can save under, since a start's files are saved
    under ``gots-<chat id>`` before the canvas exists: a chat id outside that shape is a canvas whose
    own files could never reach it.

    A chat id a chat already holds is refused too. A canvas's chat is opened for it whole, so
    opening one on a live thread would retitle it, drop the model it was pinned to and mark it as a
    canvas's chat — a canvas needs a chat of its own, and the app mints one per canvas. Both are
    refused before anything is written, in the same voice as the rest of the create.
    """
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        raise CanvasError(
            "A canvas's chat is the id its caller made, as a string; this is not one."
        )
    if not CHAT_ID.fullmatch(value):
        raise CanvasError(
            f"A canvas's chat id is 1 to 120 letters, digits, dashes and underscores; {value!r} is "
            "not one. Its session is gots-<chat id>, and its files are saved there by the upload "
            "route, so the name has to be one that route keeps."
        )
    if chats.one(path, value) is not None:
        raise CanvasError(
            "A canvas needs a chat of its own, and this one is already a chat's. Start it on a "
            "chat you made for it."
        )
    return value


def _saved(files: Any, chat_id: Optional[str]) -> List[Dict[str, Any]]:
    """The records of the files a caller saved for a canvas, as the first turn's item keeps them.

    A caller that made the chat itself saved the files under that chat's session before it called —
    the session is named after the chat (`gots-<chat id>`) — so the records come in with the create
    and ride the first turn as any message's attachments do. A caller that saved none hands nothing
    — ``None`` or an empty list, which are the same start — and that is no files rather than a
    refusal; anything but a list is refused here, before the canvas, its chat or its run exists.

    The list is the queue's own list, so it is held to the queue's own rules: each record has to be
    an object, since ``outbox.clean_files`` keeps the objects and drops anything else without a word,
    and the list is at most ``outbox.MAX_FILES`` long, since the queue trims a longer one silently.
    The two mean anything together: files with no chat name a session no canvas can have.
    """
    if files is None or (isinstance(files, list) and not files):
        return []
    if not isinstance(files, list):
        raise CanvasError(
            "A canvas's files are the records its caller saved, as a list; this is not one."
        )
    if not chat_id:
        raise CanvasError(
            "A canvas's files are saved under the session its chat names; this start names no chat."
        )
    if len(files) > outbox.MAX_FILES:
        raise CanvasError(
            f"A start carries at most {outbox.MAX_FILES} files; this one carries {len(files)}."
        )
    if any(not isinstance(file, dict) for file in files):
        raise CanvasError(
            "A canvas's files are the records its caller saved, each an object; this list holds "
            "something else, which the queue would drop without a word."
        )
    return outbox.clean_files(files)


def create(
    path: Path,
    *,
    request_profile: Optional[str],
    bot_id: Optional[str],
    prompt: Any,
    body: Any,
    chat_id: Optional[str] = None,
    files: Any = None,
) -> Dict[str, Any]:
    """A canvas from a prompt: its record, its chat and the run that builds it, in that order.

    The chat is the one the app makes for a chat — ``new_chats.open_thread``'s record, keyed by the
    session the canvas is edited in, carrying ``canvasId`` so no list or card ever draws it, titled
    with the canvas's own name and marked ``titleEdited`` so Hermes's auto-title never replaces it.
    A caller that made the chat itself names it with ``chat_id`` and hands the records of the files
    it saved under that chat's session with ``files``: the canvas opens on that chat and the first
    turn carries those files, which is how a canvas is started with an attachment. A caller that
    names neither keeps the chat ``open_thread`` mints and queues no files.

    The prompt is queued on that session as its first turn, so the canvas is built with the app
    closed, and a failure anywhere takes the record back rather than leaving a canvas with no run.
    The prompt stays the human words — a canvas and its chat are titled by them — while whatever
    markers the caller wrote for its files ride only in the run body.
    """
    if not isinstance(prompt, str) or not prompt.strip():
        raise CanvasError("A canvas needs a prompt to build it from.")
    if not isinstance(body, dict) or not isinstance(body.get("input"), list) or not body["input"]:
        raise CanvasError("body must be the run request that builds the canvas.")
    # Both are read before anything is written: the chat the caller made, and the files it saved
    # under that chat's session.
    named = _named_chat(path, chat_id)
    saved = _saved(files, named)
    run = body
    now = int(time.time() * 1000)
    canvas_id = str(uuid.uuid4())
    title = title_of(prompt)
    opened, session_id = new_chats.open_thread(
        path,
        bot_id,
        chats.pick(run.get("provider"), run.get("model")),
        opener=prompt,
        title=title,
        canvas_id=canvas_id,
        chat_id=named,
    )
    found = {
        "id": canvas_id,
        "title": title,
        "session_id": session_id,
        "chat_id": opened,
        "at": now,
    }
    _insert(path, found)
    try:
        # The canvas row is in first: the run this queues may write to it the moment it starts.
        item = new_chats.queue_first_turn(path, request_profile, opened, session_id, prompt, saved, body)
    except Exception:
        _drop(path, canvas_id)
        raise
    events.note("canvas", session_id, path, True)
    return {
        **found,
        "version": 0,
        "pinned": False,
        "archived": False,
        "html": "",
        "tools": [],
        "grants": [],
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

LIST_SCHEMA = {
    "name": TOOL_LIST,
    "description": (
        "Lists every canvas this bot has — each one's id, its title, whether it is archived and "
        "when its page last changed, newest first — so a canvas can be named by its title or its "
        "id. It takes no arguments, and it works in any of this bot's sessions."
    ),
    "parameters": {"type": "object", "properties": {}},
}

WRITE_SCHEMA = {
    "name": TOOL_WRITE,
    "description": (
        "Canvas sessions only: writes the canvas's whole HTML document as its next version. The "
        "document must be complete — doctype, html lang, a title and a viewport meta — hold no "
        "secret and load nothing from outside itself, or the write is refused whole and the canvas "
        "keeps the version it had. The answer carries `warnings`: what the design guide says this "
        "page breaks, as advice. A warning never refuses the write."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "html": {"type": "string", "description": "The whole document, from <!doctype html>."},
            "title": {"type": "string", "description": "The canvas's name, when it changes."},
            "tools": {
                "type": "array",
                "items": {"type": "string"},
                "description": (
                    "The host tools this version's page may call, each named <server>.<tool>. A "
                    "write replaces the page whole, so leaving this out declares none — the list a "
                    "page had does not carry over."
                ),
            },
            "image": {
                "type": "string",
                "description": (
                    "A picture of the page for the canvas's tile in the list, as a data URL "
                    "(data:image/png;base64,...) — one inline image, at most 192 KB. Leave it out to "
                    "keep the one the canvas has; send an empty string to go back to its mark."
                ),
            },
        },
        "required": ["html"],
    },
}

READ_SCHEMA = {
    "name": TOOL_READ,
    "description": (
        "Canvas sessions only: reads the canvas's current version — its document, its number and "
        "the tools that version declared — so a change starts from what is there now."
    ),
    "parameters": {"type": "object", "properties": {}},
}

EDIT_SCHEMA = {
    "name": TOOL_EDIT,
    "description": (
        "Canvas sessions only: changes the canvas by find and replace, stored as one new version. "
        "Each find has to match the current document exactly once, and either every pair is applied "
        "or nothing is written — so a small change costs no whole rewrite. Write the page again "
        "with canvas_write when the change is too big to name. The answer carries `warnings`: what "
        "the design guide says the page now breaks, as advice. A warning never refuses the edit."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "edits": {
                "type": "array",
                "description": "Find and replace pairs, applied in order.",
                "items": {
                    "type": "object",
                    "properties": {
                        "find": {
                            "type": "string",
                            "description": "Text as it stands in the current version, exactly once.",
                        },
                        "replace": {
                            "type": "string",
                            "description": 'What stands in its place; "" cuts it.',
                        },
                    },
                    "required": ["find", "replace"],
                },
            },
            "tools": {
                "type": "array",
                "items": {"type": "string"},
                "description": (
                    "The host tools this version's page may call, each named <server>.<tool>. An "
                    "edit changes the page rather than replacing it, so leaving this out keeps the "
                    "list the page already had."
                ),
            },
        },
        "required": ["edits"],
    },
}


# The `canvas` argument both data tools carry: one wording, since a caller learns a canvas's name
# from either schema, and a canvas's own session may leave either one out to mean itself.
_CANVAS_ARG = {
    "type": "string",
    "description": (
        "The canvas this call works on, by its title or its id. Any of this bot's sessions except "
        "another canvas's reaches a canvas's data; a canvas's own session may leave this out, "
        "where it means that canvas."
    ),
}


DATA_READ_SCHEMA = {
    "name": TOOL_DATA_READ,
    "description": (
        "Reads the data a canvas keeps — the documents its page stores on the host, which no "
        "version and no undo touches. Name the canvas by its title or its id; in the canvas's own "
        "session leave `canvas` out to mean this canvas. No more arguments answers every "
        "collection; a collection answers that one; a collection and an id answers one document, "
        "or null when there is none."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "canvas": _CANVAS_ARG,
            "collection": {
                "type": "string",
                "description": "One collection's name, for its documents.",
            },
            "id": {"type": "string", "description": "One document's id within that collection."},
        },
    },
}

DATA_WRITE_SCHEMA = {
    "name": TOOL_DATA_WRITE,
    "description": (
        "Stores one document in a canvas's data, or removes it. Name the canvas by its title or "
        "its id; in the canvas's own session leave `canvas` out to mean this canvas. A write "
        "replaces the document with that collection and id, and the whole of a canvas's data is "
        "capped at 1 MB, so a write past it is refused whole."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "canvas": _CANVAS_ARG,
            "collection": {
                "type": "string",
                "description": "The collection the document belongs to.",
            },
            "id": {"type": "string", "description": "The document's id within that collection."},
            "doc": {"description": "The document, as any JSON value."},
            "remove": {
                "type": "boolean",
                "description": "Removes the document instead of storing one.",
            },
        },
        "required": ["collection", "id"],
    },
}


def _unreadable(tool: str) -> str:
    """What a tool answers for a store it can't read: the answer, never a raise.

    A locked store, one that is no database and one whose migration step failed all reach a handler
    as ``sqlite3.Error`` (with an ``OSError`` for a file it can't open). Letting one out fails the
    tool call and tells the model nothing, so every read of the store is answered from here in the
    voice the rest of the canvas refusals use.
    """
    return json.dumps({"error": f"{tool} can't read this bot's store, so it can't answer this call."})


def _answered(
    tool: str,
    run: Callable[[Path, str], Dict[str, Any]],
    path: Path,
    canvas_id: str,
    shape: Optional[Callable[[Dict[str, Any]], Dict[str, Any]]] = None,
) -> str:
    """One tool's answer as JSON: what ``run`` found — shaped, where the tool has an answer of its
    own — or the ``CanvasError`` it refused with, named, or the store it couldn't read.

    The envelope both kinds of canvas tool share: a refusal is an ``{"error": ...}`` answer and
    never a raise to the caller, so a model is told what went wrong rather than the call failing.
    """
    try:
        found = run(path, canvas_id)
    except CanvasError as refused:
        return json.dumps({"error": str(refused)})
    except (sqlite3.Error, OSError):
        logger.debug("gots: %s couldn't read the store", tool, exc_info=True)
        return _unreadable(tool)
    return json.dumps(found if shape is None else shape(found))


def _tool_answer(
    tool: str,
    task_id: Optional[str],
    session_id: Optional[str],
    run: Callable[[Path, str], Dict[str, Any]],
    answer: Callable[[Dict[str, Any]], Dict[str, Any]],
) -> str:
    """One canvas tool's answer: a canvas's session only, a refusal as an error, else its payload."""
    canvas_id, path = _call_canvas(task_id, session_id)
    if not canvas_id or path is None:
        return json.dumps({"error": f"{tool} only works in a canvas's session."})
    return _answered(tool, run, path, canvas_id, answer)


def _own_canvas(tool: str, named: Any, canvas_id: str, path: Path) -> None:
    """Refuses a name that isn't the canvas a canvas's session edits.

    The name is resolved exactly as any other session resolves it, and then asked whether it is
    this canvas: so a name means one canvas everywhere — a title that is another canvas's id is
    still that id, and a title two canvases answer to is refused rather than read as this one, in
    this session as in every other. A name left out is the one case that means this canvas alone.
    """
    if named is None:
        return
    resolved = resolve(path, named)
    if resolved == canvas_id:
        return
    raise CanvasError(
        f"{tool} reaches only this canvas's data from a canvas's session: this is {canvas_id}'s "
        f"session, and {named!r} names {resolved}. Leave canvas out to mean this one."
    )


def _data_canvas(
    tool: str, named: Any, task_id: Optional[str], session_id: Optional[str]
) -> tuple[Path, str]:
    """The store and the canvas one data call reaches, or a ``CanvasError`` saying why it can't.

    A canvas's own session is asked first, so a call that names nothing costs no lookup; a name it
    does give is resolved by the same rule every other session resolves one by. A session with no
    canvas of its own has to name one, and the refusal says what to name and where the names are,
    because a caller who knows no title has only ``canvas_list``.
    """
    canvas_id, path = _call_canvas(task_id, session_id)
    if path is None:
        raise CanvasError(f"{tool} can't read this bot's store, so it can't name a canvas.")
    if canvas_id:
        _own_canvas(tool, named, canvas_id, path)
        return path, canvas_id
    if not isinstance(named, str) or not named.strip():
        raise CanvasError(
            f"{tool} needs the canvas it works on: name it by its title or its id. "
            f"{TOOL_LIST} names every canvas this bot has."
        )
    return path, resolve(path, named)


def _data_answer(
    tool: str,
    named: Any,
    task_id: Optional[str],
    session_id: Optional[str],
    run: Callable[[Path, str], Dict[str, Any]],
) -> str:
    """One data tool's answer: the canvas this call named, or the one its own session edits."""
    try:
        path, canvas_id = _data_canvas(tool, named, task_id, session_id)
    except CanvasError as refused:
        return json.dumps({"error": str(refused)})
    except (sqlite3.Error, OSError):
        # Naming the canvas reads the store's names, so this read fails where `run`'s does.
        logger.debug("gots: %s couldn't read the store", tool, exc_info=True)
        return _unreadable(tool)
    return _answered(tool, run, path, canvas_id)


def handle_list(
    args: Any = None, task_id: Optional[str] = None, session_id: Optional[str] = None, **_: Any
) -> str:
    """The tool: every canvas this bot has, newest first, archived ones included and flagged.

    The one canvas tool that reaches every session: a caller who knows no title is who needs to look
    one up, and a session with no canvas of its own has no other way to learn what there is. It
    reads the store's names, never a record's picture, from the store's path alone — no canvas of
    its own is exactly the session it is asked from, so there is no lineage to walk.
    """
    try:
        path, _home = sessions._paths()
    except Exception:
        logger.debug("gots: couldn't find the store a canvas lives in", exc_info=True)
        return json.dumps(
            {"error": f"{TOOL_LIST} can't read this bot's store, so it can't name its canvases."}
        )
    try:
        return json.dumps({"canvases": names(path)})
    except (sqlite3.Error, OSError):
        logger.debug("gots: %s couldn't read the store", TOOL_LIST, exc_info=True)
        return _unreadable(TOOL_LIST)


def handle_write(args: Any, task_id: Optional[str] = None, session_id: Optional[str] = None, **_: Any) -> str:
    """The tool: writes the canvas whose session made the call."""
    args = args if isinstance(args, dict) else {}
    return _tool_answer(
        TOOL_WRITE,
        task_id,
        session_id,
        lambda path, canvas_id: write(
            path,
            canvas_id,
            args.get("html"),
            args.get("title"),
            args.get("tools"),
            args.get("image"),
        ),
        lambda found: {
            "id": found["id"],
            "title": found["title"],
            "version": found["version"],
            "written": True,
            "warnings": warnings(found["html"]),
        },
    )


def handle_edit(args: Any, task_id: Optional[str] = None, session_id: Optional[str] = None, **_: Any) -> str:
    """The tool: changes the canvas whose session made the call, by find and replace."""
    args = args if isinstance(args, dict) else {}
    return _tool_answer(
        TOOL_EDIT,
        task_id,
        session_id,
        lambda path, canvas_id: edit(path, canvas_id, args.get("edits"), args.get("tools")),
        lambda found: {
            "id": found["id"],
            "title": found["title"],
            "version": found["version"],
            "edited": True,
            "warnings": warnings(found["html"]),
        },
    )


def handle_read(args: Any, task_id: Optional[str] = None, session_id: Optional[str] = None, **_: Any) -> str:
    """The tool: the canvas's current version, as it stands."""
    return _tool_answer(
        TOOL_READ,
        task_id,
        session_id,
        page,
        lambda found: {
            "id": found["id"],
            "title": found["title"],
            "version": found["version"],
            "tools": found["tools"],
            "html": found["html"],
        },
    )


def handle_data_read(
    args: Any, task_id: Optional[str] = None, session_id: Optional[str] = None, **_: Any
) -> str:
    """The tool: the named canvas's own documents — all of them, a collection, or one document —
    or, in that canvas's own session, this canvas's."""
    args = args if isinstance(args, dict) else {}
    collection, doc_id = args.get("collection"), args.get("id")

    def read(path: Path, canvas_id: str) -> Dict[str, Any]:
        if doc_id is not None and collection is None:
            # A document is one of one collection: an id on its own would read whichever collection
            # sorts first, which is not the document the caller named.
            raise CanvasError(f"{TOOL_DATA_READ} needs the collection that id belongs to.")
        documents = data(path, canvas_id, collection, doc_id)
        if doc_id is None:
            return {"documents": documents}
        return {"document": documents[0] if documents else None}

    return _data_answer(TOOL_DATA_READ, args.get("canvas"), task_id, session_id, read)


def handle_data_write(
    args: Any, task_id: Optional[str] = None, session_id: Optional[str] = None, **_: Any
) -> str:
    """The tool: stores one of the named canvas's documents, or removes one — or, in that canvas's
    own session, this canvas's."""
    args = args if isinstance(args, dict) else {}
    return _data_answer(
        TOOL_DATA_WRITE,
        args.get("canvas"),
        task_id,
        session_id,
        lambda path, canvas_id: write_call(path, canvas_id, args),
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
            f"This is a canvas's session: change the canvas with {TOOL_WRITE}, {TOOL_EDIT} and "
            f"{TOOL_READ}, and its data with {TOOL_DATA_READ} and {TOOL_DATA_WRITE}. It can't "
            "ship a pull request, file a library item or take a task."
        ),
    }


def register(plugin_ctx: Any) -> bool:
    """Keeps the context and registers the canvas's six tools — the list and the two data tools
    every session carries, and the three more a canvas's own session is given."""
    global ctx, _registered
    ctx = plugin_ctx
    register_tool = getattr(plugin_ctx, "register_tool", None)
    if not callable(register_tool):
        return False
    took = True
    for tool, schema, handler in (
        (TOOL_LIST, LIST_SCHEMA, handle_list),
        (TOOL_WRITE, WRITE_SCHEMA, handle_write),
        (TOOL_EDIT, EDIT_SCHEMA, handle_edit),
        (TOOL_READ, READ_SCHEMA, handle_read),
        (TOOL_DATA_READ, DATA_READ_SCHEMA, handle_data_read),
        (TOOL_DATA_WRITE, DATA_WRITE_SCHEMA, handle_data_write),
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
    """Gives every agent the list and the two data tools, and a canvas's agents the rest.

    Those three are wired with no ``when``: a session with no canvas of its own is exactly who needs
    to look one up, one that isn't a canvas's reads or writes a canvas's data by naming it, and a
    canvas's own session leaves the name out to mean itself. The three document tools stay in the
    session the canvas is edited in.
    """
    global adapter, _wired
    adapter = api_adapter

    def is_canvas(session: Optional[str]) -> bool:
        return _session_canvas(session) is not None

    took = True
    for tool, schema, when in (
        (TOOL_LIST, LIST_SCHEMA, None),
        (TOOL_DATA_READ, DATA_READ_SCHEMA, None),
        (TOOL_DATA_WRITE, DATA_WRITE_SCHEMA, None),
        (TOOL_WRITE, WRITE_SCHEMA, is_canvas),
        (TOOL_EDIT, EDIT_SCHEMA, is_canvas),
        (TOOL_READ, READ_SCHEMA, is_canvas),
    ):
        if not tools_common.wire_tool(api_adapter, tool, schema, tool, when=when):
            took = False
    _wired = took
    return took


def ready() -> bool:
    """Whether a canvas can be worked on this host: its tools registered and wired into the agents
    the API server builds, so a canvas's session is given them."""
    return _registered and _wired
