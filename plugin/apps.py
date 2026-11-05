"""A bot's apps and their pages: one record per app, one row per ``openui-lang`` source (ADR 0099).

An app is its title and its pages, and each page is its own source with its own first-line id. The
pages are kept in the order a build answered them in, and the first is the root the app opens on. A
page keeps the source its last change replaced — one step of undo — and a change lands on one page
without touching the others (ADR 0099).

Reading is open here: the list names every app with its title, its library version and its page ids
and never a source, and one page is read on its own, its source and whether it can be undone. The
record is the bot's, on its own store (``store.py``), so a second device reads the same apps from
the same truth (ADR 0100).
"""

from __future__ import annotations

import re
import sqlite3
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional

from .store import now_ms, open_rows

# The two caps a write is held to. A source past the page cap is refused whole — never cut to fit,
# since a cut page is a page that no longer parses — and the refusal names the cap it hit.
PAGE_MAX_CHARS = 20_000
TITLE_MAX_CHARS = 120
# The library a page is written against until a build says otherwise.
LIBRARY_VERSION = "1.0.1"
ROOT_PAGE = "root"
_ID_LINE = re.compile(r"\A\s*#\s*id:\s*([A-Za-z0-9][A-Za-z0-9_-]{0,63})\s*(?:\n|\Z)")


class AppsError(Exception):
    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


def listing(path: Path) -> List[Dict[str, Any]]:
    """Every app with its title, its library version and its page ids — the root first, newest app
    first — and no source.

    The order the pages are kept in is the order a build answered them in — the store holds one
    page per place — so the first id is the root the app opens on and a reader needs no second
    field to find it.
    """
    if not path.exists():
        return []
    conn = open_rows(path)
    try:
        rows = conn.execute(
            "SELECT id, title, library_version FROM apps ORDER BY created_at DESC, id"
        ).fetchall()
        pages = conn.execute(
            "SELECT app_id, page_id FROM app_pages ORDER BY app_id, position"
        ).fetchall()
    finally:
        conn.close()
    ids: Dict[str, List[str]] = {}
    for row in pages:
        ids.setdefault(row["app_id"], []).append(row["page_id"])
    return [
        {
            "id": row["id"],
            "title": row["title"],
            "library_version": row["library_version"],
            "pages": ids.get(row["id"], []),
        }
        for row in rows
    ]


def _found(conn: sqlite3.Connection, app_id: str, page_id: str) -> sqlite3.Row:
    """One page's row, or the not-found that names what is missing: the app first, then the page.

    An app that is gone stays gone, so a page row left behind is never read back out of it.
    """
    if conn.execute("SELECT 1 FROM apps WHERE id = ?", (app_id,)).fetchone() is None:
        raise AppsError("No such app.", 404)
    found = conn.execute(
        "SELECT source, previous_source IS NOT NULL AS undoable"
        " FROM app_pages WHERE app_id = ? AND page_id = ?",
        (app_id, page_id),
    ).fetchone()
    if found is None:
        raise AppsError("No such page.", 404)
    return found


def _answer(app_id: str, page_id: str, found: sqlite3.Row) -> Dict[str, Any]:
    return {
        "id": page_id,
        "app_id": app_id,
        "source": found["source"],
        "undoable": bool(found["undoable"]),
    }


def page(path: Path, app_id: str, page_id: str) -> Dict[str, Any]:
    """One page's source and whether an undo is available — the source its last change replaced.

    The answer names the page the way the record does, by its app and its own id.

    Raises ``AppsError`` (404) where the app or the page isn't there.
    """
    if not path.exists():
        raise AppsError("No such app.", 404)
    conn = open_rows(path)
    try:
        return _answer(app_id, page_id, _found(conn, app_id, page_id))
    finally:
        conn.close()


@contextmanager
def _writing(path: Path, building: bool = False) -> Iterator[sqlite3.Connection]:
    """A connection holding the store's write lock, committed when the block ends and rolled back
    when it raises, so a write is whole or not at all and its checks and its change see one state.

    Only a ``building`` write may bring the store into being; any other finds no app in a store
    that isn't there, and creates nothing.
    """
    if not building and not path.exists():
        raise AppsError("No such app.", 404)
    conn = open_rows(path)
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


def _checked(source: Any) -> str:
    if not isinstance(source, str) or not source.strip():
        raise AppsError("A page needs a source.", 400)
    if len(source) > PAGE_MAX_CHARS:
        raise AppsError(
            f"A page's source is capped at {PAGE_MAX_CHARS} characters (the page cap);"
            f" this one is {len(source)}.",
            413,
        )
    return source


def page_id_of(source: str) -> str:
    found = _ID_LINE.match(source)
    return found.group(1) if found else ROOT_PAGE


def create(
    path: Path, title: Any, source: Any, library_version: Optional[str] = None
) -> Dict[str, Any]:
    """Saves a new app whose first page, the root, is ``source``; answers the app as the list does.

    The app and its page are written in one transaction, so no reader meets an app without its
    root. Raises ``AppsError`` (400/413) for a title or source that can't be kept.
    """
    if not isinstance(title, str) or not title.strip():
        raise AppsError("An app needs a title.", 400)
    title = title.strip()
    if len(title) > TITLE_MAX_CHARS:
        raise AppsError(
            f"An app's title is capped at {TITLE_MAX_CHARS} characters (the title cap);"
            f" this one is {len(title)}.",
            413,
        )
    source = _checked(source)
    version = (
        library_version if isinstance(library_version, str) and library_version else LIBRARY_VERSION
    )
    app_id = f"app-{uuid.uuid4().hex[:12]}"
    root = page_id_of(source)
    with _writing(path, building=True) as conn:
        conn.execute(
            "INSERT INTO apps (id, title, library_version, created_at) VALUES (?, ?, ?, ?)",
            (app_id, title, version, now_ms()),
        )
        conn.execute(
            "INSERT INTO app_pages (app_id, page_id, position, source) VALUES (?, ?, 0, ?)",
            (app_id, root, source),
        )
    return {"id": app_id, "title": title, "library_version": version, "pages": [root]}


def write(path: Path, app_id: str, page_id: str, source: Any) -> Dict[str, Any]:
    """Replaces one page's whole source and keeps the one it replaced for one step of undo.

    A write names a page that is there: an app or page that isn't answers not-found and creates
    nothing, so a deleted app stays deleted. Raises ``AppsError`` (404, 400 or 413).
    """
    with _writing(path) as conn:
        _found(conn, app_id, page_id)
        source = _checked(source)
        conn.execute(
            "UPDATE app_pages SET previous_source = source, source = ?"
            " WHERE app_id = ? AND page_id = ?",
            (source, app_id, page_id),
        )
        return _answer(app_id, page_id, _found(conn, app_id, page_id))


def undo(path: Path, app_id: str, page_id: str) -> Dict[str, Any]:
    """Puts back the source a page's last write replaced; there is one step, so a second undo has
    nothing to put back.

    Raises ``AppsError`` (404 for a missing app or page, 409 for a page with nothing to undo).
    """
    with _writing(path) as conn:
        if not _found(conn, app_id, page_id)["undoable"]:
            raise AppsError("Nothing to undo.", 409)
        conn.execute(
            "UPDATE app_pages SET source = previous_source, previous_source = NULL"
            " WHERE app_id = ? AND page_id = ?",
            (app_id, page_id),
        )
        return _answer(app_id, page_id, _found(conn, app_id, page_id))
