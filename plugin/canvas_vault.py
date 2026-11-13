"""A canvas's data copied into an OKF vault on its host, when that canvas's own switch is on.

The vault is one fixed folder under the bot's own home — ``llm-wiki/canvas`` — and, under it, one
folder a canvas, one a collection, and one markdown note a document (``VAULT`` is the fixed half,
and ``canvases.py``'s ``vault`` the switch that says which canvases are copied). It is OKF's shape:
a bundle of markdown files with YAML frontmatter, ``type`` the one key that has to be there, a
concept's id being its path without the ``.md``, and ``index.md`` the folder's own file. So a
bookmark is a file a vault's own tools can list and link, and the folder is named by a canvas's id
rather than its title, since a title is the user's to change and a rename would orphan every note.

Nothing here is ever read back: the vault is a copy the host writes, not a second store. What that
copy has to be is *incremental* and *bounded*, and both come from the same fact — the host writes
the file and the host stamped the document:

- A note is written only where its document's ``at`` is newer than the file's mtime, so a second
  tick writes nothing it already wrote, and a note the user edited in the vault (whose mtime is now
  later than any clock the store holds for it) is left exactly as they left it.
- A note is deleted only where a walk that reached the end of its collection no longer names it. A
  remove writes no tombstone, so a walk cut short is no evidence that a document is gone.
- A tick writes at most ``VAULT_PER_TICK`` files and stops after ``VAULT_SECONDS``: five thousand
  documents converge over ticks instead of holding the host for a minute, and a steady-state tick
  writes the one note that moved.

Turning the switch off stops the writing and deletes nothing already written, since a wiki the user
may have linked and edited is not the app's to take away; a canvas the store no longer holds is
never walked, so its notes stay as they are. The one thing deleted is a document the store itself
stopped naming, because the vault exists to say what the store holds.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

from . import canvas_docs, canvases, ticker
from .store import connect, db_path

logger = logging.getLogger(__name__)

# Where a bot's vault is, under its home: one fixed path rather than a folder the user chose, since
# a path in settings is a second thing to validate and the home already names whose vault it is.
VAULT = ("llm-wiki", "canvas")

# A folder's own file, which every folder in an OKF bundle carries and no document is ever written
# as (``note_name``). `log.md` is a vault's change log, reserved for the same reason.
INDEX = "index.md"
RESERVED_STEMS = ("index", "log")

# What each kind of file says it is: the one key OKF requires, so a tool reading the bundle knows
# what a file holds without parsing its body.
DOCUMENT = "canvas.document"
COLLECTION = "canvas.collection"
CANVAS = "canvas.canvas"

# One tick's bound: what it may write, and how long it may take. A first backup of five thousand
# documents is twenty-five of these.
VAULT_PER_TICK = 200
VAULT_SECONDS = 20.0

# How often the watcher looks again having been poked by nothing. A data write wakes it, so this is
# the pace a first backup converges at rather than the pace a change is noticed at.
TICK_SECONDS = 60.0

_ticker = ticker.Ticker("canvas vault")


def root(home: Path) -> Path:
    """Where this bot's vault is: ``<its home>/llm-wiki/canvas``, and nowhere the user chose."""
    return home.joinpath(*VAULT)


def wake() -> None:
    """Has the vault look again now; safe from any thread, which is where a data write lands."""
    _ticker.wake()


async def run(home: Path) -> None:
    """Backs up the canvases whose switch is on, for as long as the server runs (see ``__init__``).

    A tick runs off the loop's thread: it is file work for as long as ``VAULT_SECONDS`` allows, and
    a host waiting on a page's write must not wait behind it.
    """
    store = db_path(home)
    await _ticker.run(TICK_SECONDS, lambda: asyncio.to_thread(tick, store, home))


def tick(store: Path, home: Path) -> int:
    """One pass over every canvas whose record says ``vault``; answers how many files it wrote.

    A canvas that can't be read is not the whole backup's failure: the rest are written and the
    next tick comes back to it.
    """
    budget = _Bounded()
    base = root(home)
    for canvas in canvases.vaulting(store):
        if budget.spent:
            break
        try:
            _back_up(store, base, canvas, budget)
        except Exception:
            logger.warning("gots: couldn't back up canvas %s", canvas["id"], exc_info=True)
    return budget.written


# --- one canvas ----------------------------------------------------------------------------------


def _back_up(store: Path, base: Path, canvas: Dict[str, Any], budget: "_Bounded") -> None:
    """A canvas's folder: its own ``index.md``, then each collection of its catalogue."""
    folder = base / _folder(canvas["id"])
    conn = connect(store)
    try:
        held = canvas_docs.catalogue(conn, canvas["id"])
        _keep(folder / INDEX, _canvas_index(canvas, held["collections"]), budget)
        # A collection the catalogue no longer names is a collection whose every document the store
        # has stopped holding, so its folder goes with them — and anything beside the notes, which
        # is the user's, stays.
        _prune_folders(folder, {_folder(row["collection"]) for row in held["collections"]})
        for row in held["collections"]:
            if budget.spent:
                return
            _back_up_collection(
                conn,
                folder / _folder(row["collection"]),
                canvas,
                row["collection"],
                row["count"],
                budget,
            )
    finally:
        conn.close()


def _back_up_collection(
    conn: sqlite3.Connection,
    folder: Path,
    canvas: Dict[str, Any],
    collection: str,
    count: int,
    budget: "_Bounded",
) -> None:
    """One collection's folder: its ``index.md``, then the notes a page at a time.

    The walk is ``canvas_docs.each``'s — the one rule every read of a canvas's documents shares — so
    a collection of five thousand documents costs twenty-five statements and holds one page of them.
    A walk the budget cut short has not seen the collection whole: it starts again on the next tick,
    and it deletes nothing, since a note it did not meet is no evidence of a document removed.
    """
    _keep(folder / INDEX, _collection_index(collection, count), budget)
    names: Set[str] = set()
    for document in canvas_docs.each(conn, canvas["id"], collection, canvas_docs.PAGE_ROWS):
        names.add(_note(folder, canvas, collection, document, budget))
        if budget.spent:
            return
    _prune(folder, names)


def _note(
    folder: Path,
    canvas: Dict[str, Any],
    collection: str,
    document: Dict[str, Any],
    budget: "_Bounded",
) -> str:
    """Writes one document's note where it moved, and answers the name it is filed under.

    "Moved" is the document's own clock against the file's: a document no newer than its note is one
    the vault already holds — or one the user edited after the last tick wrote it, and a note the
    user has touched is left as they left it, since no tick writes over a file it did not write
    last. A file that isn't there is written whatever its document's age, which is what a first
    backup and a note deleted by hand both are.
    """
    name = note_name(document["id"])
    path = folder / name
    if path.exists() and document["at"] <= int(path.stat().st_mtime * 1000):
        return name
    _put(path, note(canvas, collection, document))
    budget.spend()
    return name


def _prune(folder: Path, names: Set[str]) -> None:
    """Deletes the notes a completed walk did not name, and the folder's own files never."""
    if not folder.exists():
        return
    for one in folder.glob("*.md"):
        if one.name != INDEX and one.name not in names:
            one.unlink()


def _prune_folders(folder: Path, collections: Set[str]) -> None:
    """Deletes a collection's folder where the catalogue names no collection that answers to it.

    A collection the store no longer holds a document of is not a collection, so every note under
    it is a document the store has stopped naming — the same rule a walk inside the folder applies,
    read off the catalogue instead of the walk. Only the notes go: a file the user put beside them
    keeps the folder, since a wiki is theirs to add to.
    """
    if not folder.exists():
        return
    for one in folder.iterdir():
        if not one.is_dir() or one.name in collections:
            continue
        for note in one.glob("*.md"):
            note.unlink()
        try:
            one.rmdir()
        except OSError:
            # Something of the user's is in there, which is no reason to have kept the notes.
            pass


# --- the files' names ----------------------------------------------------------------------------


# Everything a file name may hold: a document's id is a page's to choose, so whatever it holds that
# a filesystem would read as a path is replaced.
_PLAIN = re.compile(r"[^A-Za-z0-9._-]")


def note_name(doc_id: str) -> str:
    """The file one document is written as: its id, escaped, with a digest of the id after it.

    The digest is what makes the name safe rather than pretty: two ids that escape to one stem
    (``a/b`` and ``a_b``) are still two files, and a whole id is what the frontmatter names, so a
    file name is a handle rather than the record. It is also what keeps a concept from being a
    folder's own file — ``index`` and ``log`` are refused as stems, so a document whose id is one
    of them is a note beside the index rather than over it.
    """
    stem = _PLAIN.sub("_", doc_id)
    if stem.casefold() in RESERVED_STEMS:
        stem = f"{stem}_"
    return f"{stem}-{_digest(doc_id)}.md"


def _folder(name: str) -> str:
    """The folder one name is filed under: the name itself where nothing had to be replaced.

    A canvas id and a collection are read by a person looking through a vault, so an ordinary name
    stays whole; a name that needed escaping takes a digest, so two collections can never be handed
    one folder and a document can never be read under another collection's name.
    """
    stem = _PLAIN.sub("_", name)
    return stem if stem == name else f"{stem}-{_digest(name)}"


def _digest(value: str) -> str:
    """Six characters of the id's own hash: enough to keep two names apart, short enough to read."""
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:6]


# --- one note ------------------------------------------------------------------------------------


def note(canvas: Dict[str, Any], collection: str, document: Dict[str, Any]) -> str:
    """One document as an OKF concept: what it is, which document it is, and the document whole.

    The frontmatter is the vault's index of it — ``type`` first, since that is the one key OKF
    requires, then the document's own title (or its id, which is what a document with no title has),
    its description and the url it points at (as ``resource``) where it has them, and the clock it
    was written at as ISO 8601. The body is what a reader wants before the raw document: its
    scalar fields as a list, and then the document itself in a fence, so nothing the store holds is
    lost to the copy.
    """
    doc = document["doc"]
    fields: Dict[str, Any] = doc if isinstance(doc, dict) else {}
    title = fields.get("title")
    header: List[Tuple[str, Any]] = [
        ("type", DOCUMENT),
        ("title", title if isinstance(title, str) and title.strip() else document["id"]),
        ("description", _text(fields.get("description"))),
        ("resource", _text(fields.get("url"))),
        ("tags", _tags(fields.get("tags"))),
        ("timestamp", _timestamp(document["at"])),
        ("canvas", canvas["id"]),
        ("collection", collection),
        ("id", document["id"]),
    ]
    lines = [_frontmatter(header), ""]
    scalars = [(key, value) for key, value in fields.items() if _scalar(value)]
    if scalars:
        lines += [f"- **{key}**: {_inline(value)}" for key, value in scalars]
        lines.append("")
    lines += ["```json", json.dumps(doc, indent=2, ensure_ascii=False), "```", ""]
    return "\n".join(lines)


def _canvas_index(canvas: Dict[str, Any], collections: List[Dict[str, Any]]) -> str:
    """A canvas's own file: the canvas by title, and the collections its vault holds."""
    header = [("type", CANVAS), ("title", canvas["title"]), ("id", canvas["id"])]
    lines = [f"# {canvas['title']}", ""]
    if collections:
        lines += [
            f"- [{row['collection']}]({_folder(row['collection'])}/{INDEX}) — {_count(row['count'])}"
            for row in collections
        ]
    else:
        lines.append("Nothing backed up yet.")
    return _frontmatter(header) + "\n\n" + "\n".join(lines) + "\n"


def _collection_index(collection: str, count: int) -> str:
    """A collection's own file: the collection by name, and how many documents it holds."""
    header = [("type", COLLECTION), ("title", collection), ("id", collection)]
    body = [f"# {collection}", "", f"{_count(count)}."]
    return _frontmatter(header) + "\n\n" + "\n".join(body) + "\n"


def _count(count: int) -> str:
    return f"{count} document" if count == 1 else f"{count} documents"


# --- the bytes -----------------------------------------------------------------------------------


def _put(path: Path, text: str) -> None:
    """Writes a file whole: a note half written is a file no vault can read.

    The text goes beside the file and is renamed onto it, so a tick cut off mid-write leaves the
    vault as it was rather than a document with its second half missing.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    part = path.with_name(f".{path.name}.part")
    part.write_text(text, encoding="utf-8")
    os.replace(part, path)


def _keep(path: Path, text: str, budget: "_Bounded") -> None:
    """Writes a file whose text changed, and nothing where it is the one already there."""
    if path.exists() and path.read_text(encoding="utf-8") == text:
        return
    _put(path, text)
    budget.spend()


# A scalar YAML can carry unquoted: it opens on a letter, a digit or a dot, closes on one that is no
# space, holds no colon-space pair (which a reader would take as a second key) and nothing that
# would open or close a list, a map, a comment, a tag or a second document. A colon is allowed where
# a space does not follow it, which is what makes a url a url.
_PLAIN_SCALAR = re.compile(
    r"(?!.*: )[A-Za-z0-9.](?:[A-Za-z0-9 :._/()?&=+-]*[A-Za-z0-9._/()?&=+-])?"
)

# The words a YAML reader takes for something other than themselves, and the shape of a number: a
# title that is one of these is quoted, since a reader would otherwise be handed a type.
_AMBIGUOUS = frozenset({"true", "false", "null", "yes", "no", "on", "off", "y", "n", "~"})
_NUMBER = re.compile(r"[-+]?[0-9][0-9_]*(?:\.[0-9]+)?(?:[eE][-+]?[0-9]+)?")


def _frontmatter(pairs: Iterable[Tuple[str, Any]]) -> str:
    """A note's frontmatter: the keys it has, in the order it names them, and nothing it does not."""
    lines = ["---"]
    for key, value in pairs:
        if value is not None:
            lines.append(f"{key}: {_yaml(value)}")
    lines.append("---")
    return "\n".join(lines)


def _yaml(value: Any) -> str:
    """One frontmatter value as YAML: plainly where it reads back as itself, else as a JSON string.

    A JSON string is a YAML double-quoted scalar, so the quoting is one rule rather than an escaped
    dialect of its own, and a title holding a colon, a hash or a bracket is still the title.
    """
    if isinstance(value, list):
        return "[" + ", ".join(_yaml(one) for one in value) + "]"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return repr(value)
    text = str(value)
    if (
        _PLAIN_SCALAR.fullmatch(text)
        and not _NUMBER.fullmatch(text)
        and text.casefold() not in _AMBIGUOUS
    ):
        return text
    return json.dumps(text, ensure_ascii=False)


def _timestamp(at: Any) -> str:
    """A document's clock as ISO 8601 in UTC — the one form a vault's tools sort and print."""
    moment = datetime.fromtimestamp((at or 0) / 1000, timezone.utc)
    return moment.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _text(value: Any) -> Optional[str]:
    """A value a note's frontmatter names, or nothing where the document holds none."""
    if isinstance(value, str) and value.strip():
        return value
    return None


def _tags(value: Any) -> Optional[List[str]]:
    """A document's tags as the list a vault reads, or nothing where it has none."""
    if not isinstance(value, list) or not value:
        return None
    return [one if isinstance(one, str) else json.dumps(one, ensure_ascii=False) for one in value]


def _scalar(value: Any) -> bool:
    """Whether a field is one a body's list can carry: a value with no shape of its own."""
    return not isinstance(value, (dict, list))


def _inline(value: Any) -> str:
    """A scalar as one line of a list, since a body's row is one row however the text was typed."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if value is None:
        return "null"
    if isinstance(value, str):
        return " ".join(value.split())
    return json.dumps(value, ensure_ascii=False)


# --- one tick's budget ---------------------------------------------------------------------------


class _Bounded:
    """What one tick may still write: files it may add, and the moment it has to be done by.

    Both are read where the tick starts, so a tick that found nothing to write costs a walk and no
    file, and one that found five thousand stops at the bound and is finished by the next.
    """

    def __init__(self) -> None:
        self.left = VAULT_PER_TICK
        self.written = 0
        self.until = time.monotonic() + VAULT_SECONDS

    @property
    def spent(self) -> bool:
        return self.left <= 0 or time.monotonic() >= self.until

    def spend(self) -> None:
        self.written += 1
        self.left -= 1
