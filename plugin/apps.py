"""A bot's apps and their pages: one record per app, one row per ``openui-lang`` source (ADR 0099).

An app is its title and its pages, and each page is its own source with its own first-line id. The
pages are kept in the order a build answered them in, and the first is the root the app opens on. A
page keeps the source its last change replaced — one step of undo — and a change lands on one page
without touching the others (ADR 0099).

Reading is open here: the list names every app with its title, its library version and its page ids
and never a source, and one page is read on its own, its source and whether it can be undone. The
record is the bot's, on its own store (``store.py``), so a second device reads the same apps from
the same truth (ADR 0100).

A built-in app is an ordinary app the plugin seeds from its bundle (``openui/apps/``, #865): a
manifest names a set version and, per app, a key, a version and the page files in order. The first
list read writes whatever is missing, in one transaction, and a read that finds nothing to do
writes nothing. A built-in app is never deleted, only hidden; an untouched one is replaced whole
when its bundle version moves, an edited one reports an update until the update is taken, and an
app the bundle drops is left exactly as it is.
"""

from __future__ import annotations

import json
import logging
from functools import lru_cache
import re
import sqlite3
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional

from .store import now_ms, open_rows

logger = logging.getLogger(__name__)

# The two caps a write is held to. A source past the page cap is refused whole — never cut to fit,
# since a cut page is a page that no longer parses — and the refusal names the cap it hit.
PAGE_MAX_CHARS = 20_000
TITLE_MAX_CHARS = 120
# The library a page is written against until a build says otherwise.
LIBRARY_VERSION = "1.0.1"
ROOT_PAGE = "root"
# The bundle of built-in apps, beside the prompt artifacts it demonstrates (`openui.py`).
BUNDLE = Path(__file__).parent / "openui" / "apps"
_ID_LINE = re.compile(r"\A\s*#\s*id:\s*([A-Za-z0-9][A-Za-z0-9_-]{0,63})\s*(?:\n|\Z)")


class AppsError(Exception):
    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


def decide(bundle_version: int, recorded: Optional[int], edited: bool) -> str:
    """What the bundle owes one built-in app, as a pure rule.

    ``recorded`` is the bundle version the app was seeded or last updated at, ``None`` where the app
    isn't there. Answers ``create``, ``replace`` (untouched and behind), ``update`` (edited and
    behind: reported, never written) or ``none``. Hiding is no input: a hidden app takes the same
    branch as a shown one.
    """
    if recorded is None:
        return "create"
    if bundle_version <= recorded:
        return "none"
    return "update" if edited else "replace"


def _bundle() -> Dict[str, Dict[str, Any]]:
    """The bundle's apps by key, each with its version, title, library version and ordered
    ``(page_id, source)`` pairs; empty where the bundle can't be read, so a broken bundle never
    breaks the list. Read once per folder: it ships with the plugin and changes only with it."""
    return _read_bundle(BUNDLE)


@lru_cache(maxsize=4)
def _read_bundle(root: Path) -> Dict[str, Dict[str, Any]]:
    try:
        manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
        found: Dict[str, Dict[str, Any]] = {}
        for key, entry in manifest["apps"].items():
            sources = [
                _checked((root / name).read_text(encoding="utf-8")) for name in entry["pages"]
            ]
            if not sources or not isinstance(entry["version"], int):
                raise ValueError(f"{key} has no pages or no version")
            found[key] = {
                "version": entry["version"],
                "title": entry["title"],
                "library_version": entry.get("library_version") or LIBRARY_VERSION,
                "pages": [(page_id_of(source), source) for source in sources],
            }
        return found
    except (OSError, ValueError, KeyError, TypeError, AttributeError, AppsError):
        logger.warning("memento: couldn't read the built-in apps bundle", exc_info=True)
        return {}


def _recorded(conn: sqlite3.Connection) -> Dict[str, sqlite3.Row]:
    rows = conn.execute(
        "SELECT id, builtin_key, builtin_version, edited FROM apps WHERE builtin_key IS NOT NULL"
    ).fetchall()
    return {row["builtin_key"]: row for row in rows}


def _owed(recorded: Dict[str, sqlite3.Row], bundle: Dict[str, Dict[str, Any]]) -> Dict[str, str]:
    owed = {}
    for key, entry in bundle.items():
        row = recorded.get(key)
        owed[key] = decide(
            entry["version"],
            None if row is None else row["builtin_version"] or 0,
            row is not None and bool(row["edited"]),
        )
    return owed


def _lay_pages(conn: sqlite3.Connection, app_id: str, pages: List[Any]) -> None:
    for position, (page_id, source) in enumerate(pages):
        conn.execute(
            "INSERT INTO app_pages (app_id, page_id, position, source) VALUES (?, ?, ?, ?)",
            (app_id, page_id, position, source),
        )


def seed(path: Path, bundle: Dict[str, Dict[str, Any]]) -> None:
    """Creates the built-in apps that are missing and replaces the untouched ones the bundle has
    moved past, in one transaction; a store with nothing owed is not written.

    What is owed is read again inside the write lock, so two first reads cannot both create an app.
    """
    if not bundle:
        return
    if path.exists():
        conn = open_rows(path)
        try:
            owed = _owed(_recorded(conn), bundle)
        finally:
            conn.close()
        if not any(action in ("create", "replace") for action in owed.values()):
            return
    with _writing(path, building=True) as conn:
        recorded = _recorded(conn)
        for key, action in _owed(recorded, bundle).items():
            entry = bundle[key]
            if action == "create":
                app_id = f"builtin-{key}"
                conn.execute(
                    "INSERT INTO apps (id, title, library_version, created_at, builtin_key,"
                    " builtin_version) VALUES (?, ?, ?, ?, ?, ?)",
                    (
                        app_id,
                        entry["title"],
                        entry["library_version"],
                        now_ms(),
                        key,
                        entry["version"],
                    ),
                )
                _lay_pages(conn, app_id, entry["pages"])
            elif action == "replace":
                _replace(conn, recorded[key]["id"], entry)


def _replace(conn: sqlite3.Connection, app_id: str, entry: Dict[str, Any]) -> None:
    """Every page of an app swapped for the bundle's in the caller's transaction, so an update never
    leaves half of an old page beside half of a new one; clears the edit mark."""
    conn.execute("DELETE FROM app_pages WHERE app_id = ?", (app_id,))
    conn.execute(
        "UPDATE apps SET title = ?, library_version = ?, builtin_version = ?, edited = 0"
        " WHERE id = ?",
        (entry["title"], entry["library_version"], entry["version"], app_id),
    )
    _lay_pages(conn, app_id, entry["pages"])


def listing(path: Path, include_hidden: bool = False) -> List[Dict[str, Any]]:
    """Every app with its title, its library version and its page ids — the root first, newest app
    first — and no source. The first read seeds the built-in apps (see ``seed``).

    A built-in app also names its bundle ``builtin`` key, whether it is ``hidden`` (a hidden app is
    left out unless ``include_hidden``) and whether the bundle holds an ``update`` it has not taken.

    The order the pages are kept in is the order a build answered them in — the store holds one
    page per place — so the first id is the root the app opens on and a reader needs no second
    field to find it.
    """
    bundle = _bundle()
    seed(path, bundle)
    if not path.exists():
        return []
    conn = open_rows(path)
    try:
        rows = conn.execute(
            "SELECT id, title, library_version, builtin_key, hidden FROM apps"
            + ("" if include_hidden else " WHERE hidden = 0")
            + " ORDER BY created_at DESC, id"
        ).fetchall()
        pages = conn.execute(
            "SELECT app_id, page_id FROM app_pages ORDER BY app_id, position"
        ).fetchall()
        owed = _owed(_recorded(conn), bundle)
    finally:
        conn.close()
    ids: Dict[str, List[str]] = {}
    for row in pages:
        ids.setdefault(row["app_id"], []).append(row["page_id"])
    return [
        _summary(
            row["id"],
            row["title"],
            row["library_version"],
            ids.get(row["id"], []),
            builtin=row["builtin_key"],
            hidden=bool(row["hidden"]),
            update=owed.get(row["builtin_key"]) == "update",
        )
        for row in rows
    ]


def _summary(
    app_id: str,
    title: str,
    library_version: str,
    pages: List[str],
    *,
    builtin: Optional[str] = None,
    hidden: bool = False,
    update: bool = False,
) -> Dict[str, Any]:
    """An app as the list and a create both answer it, so the two can't drift."""
    return {
        "id": app_id,
        "title": title,
        "library_version": library_version,
        "pages": pages,
        "builtin": builtin,
        "hidden": hidden,
        "update": update,
    }


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
    path: Path,
    title: Any,
    source: Any = None,
    library_version: Optional[str] = None,
    pages: Any = None,
) -> Dict[str, Any]:
    """Saves a new app whose pages are written together, the first the root; answers the app as the
    list does.

    ``pages`` is a build's blocks in order; a lone ``source`` is a one-page app. The app and every
    page are written in one transaction, so no reader meets an app without its root or one half
    built. Raises ``AppsError`` (400/413) for a title or source that can't be kept, or two pages
    sharing an id.
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
    if pages is None:
        pages = [source]
    if not isinstance(pages, list) or not pages:
        raise AppsError("An app needs a page.", 400)
    pages = [(page_id_of(one), one) for one in map(_checked, pages)]
    ids = [page_id for page_id, _ in pages]
    if len(set(ids)) != len(ids):
        raise AppsError("Two pages of an app can't share an id.", 400)
    version = (
        library_version if isinstance(library_version, str) and library_version else LIBRARY_VERSION
    )
    app_id = f"app-{uuid.uuid4().hex[:12]}"
    with _writing(path, building=True) as conn:
        conn.execute(
            "INSERT INTO apps (id, title, library_version, created_at) VALUES (?, ?, ?, ?)",
            (app_id, title, version, now_ms()),
        )
        conn.executemany(
            "INSERT INTO app_pages (app_id, page_id, position, source) VALUES (?, ?, ?, ?)",
            [(app_id, page_id, position, one) for position, (page_id, one) in enumerate(pages)],
        )
    return _summary(app_id, title, version, ids)


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
        _mark_edited(conn, app_id)
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
        _mark_edited(conn, app_id)
        return _answer(app_id, page_id, _found(conn, app_id, page_id))


def _mark_edited(conn: sqlite3.Connection, app_id: str) -> None:
    """A person's change to any page makes a built-in app theirs, and the bundle never replaces it
    again; a generated app has no mark to set."""
    conn.execute("UPDATE apps SET edited = 1 WHERE id = ? AND builtin_key IS NOT NULL", (app_id,))


def _builtin(conn: sqlite3.Connection, app_id: str) -> sqlite3.Row:
    row = conn.execute(
        "SELECT id, builtin_key, builtin_version, edited FROM apps WHERE id = ?", (app_id,)
    ).fetchone()
    if row is None:
        raise AppsError("No such app.", 404)
    return row


def remove(path: Path, app_id: str) -> Dict[str, Any]:
    """Deletes a generated app and its pages and answers its id; a built-in app is refused and is
    hidden instead.

    Raises ``AppsError`` (404 for no such app, 409 for a built-in one).
    """
    with _writing(path) as conn:
        if _builtin(conn, app_id)["builtin_key"] is not None:
            raise AppsError("A built-in app can't be deleted; hide it instead.", 409)
        conn.execute("DELETE FROM app_pages WHERE app_id = ?", (app_id,))
        conn.execute("DELETE FROM apps WHERE id = ?", (app_id,))
    return {"id": app_id}


def set_hidden(path: Path, app_id: str, hidden: Any) -> Dict[str, Any]:
    """Hides a built-in app, or brings it back, as the host's own mark; the app keeps its pages, its
    edit mark and its version, and is still seeded and updated while hidden.

    Raises ``AppsError`` (400 for a non-boolean, 404 for no such app, 409 for a generated app,
    which is deleted rather than hidden).
    """
    if not isinstance(hidden, bool):
        raise AppsError("hidden must be true or false.", 400)
    with _writing(path) as conn:
        if _builtin(conn, app_id)["builtin_key"] is None:
            raise AppsError("Only a built-in app is hidden; delete this one.", 409)
        conn.execute("UPDATE apps SET hidden = ? WHERE id = ?", (int(hidden), app_id))
    return {"id": app_id, "hidden": hidden}


def take_update(path: Path, app_id: str) -> Dict[str, Any]:
    """Replaces every page of an edited built-in app with the bundle's and clears its edit mark.

    Raises ``AppsError`` (404 for no such app, 409 where the app is generated, left out of the
    bundle or already at the bundle's version).
    """
    bundle = _bundle()
    with _writing(path) as conn:
        row = _builtin(conn, app_id)
        entry = bundle.get(row["builtin_key"] or "")
        if entry is None or entry["version"] <= (row["builtin_version"] or 0):
            raise AppsError("There is no update to take.", 409)
        _replace(conn, app_id, entry)
    return {"id": app_id, "pages": [page_id for page_id, _ in entry["pages"]]}
