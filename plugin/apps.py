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

from pathlib import Path
from typing import Any, Dict, List

from .store import open_rows


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


def page(path: Path, app_id: str, page_id: str) -> Dict[str, Any]:
    """One page's source and whether an undo is available — the source its last change replaced.

    The answer names the page the way the record does, by its app and its own id. A page of an app
    that isn't there is not-found, in its own words: an app that is gone stays gone, and a read
    never draws one back out of a page row left behind.

    Raises ``AppsError`` (404) where the app or the page isn't there.
    """
    if not path.exists():
        raise AppsError("No such app.", 404)
    conn = open_rows(path)
    try:
        if conn.execute("SELECT 1 FROM apps WHERE id = ?", (app_id,)).fetchone() is None:
            raise AppsError("No such app.", 404)
        found = conn.execute(
            "SELECT source, previous_source IS NOT NULL AS undoable"
            " FROM app_pages WHERE app_id = ? AND page_id = ?",
            (app_id, page_id),
        ).fetchone()
    finally:
        conn.close()
    if found is None:
        raise AppsError("No such page.", 404)
    return {
        "id": page_id,
        "app_id": app_id,
        "source": found["source"],
        "undoable": bool(found["undoable"]),
    }
