"""A canvas's documents, read by one rule: the row's shape, the store's one order, and a walk.

A canvas's data is rows of ``canvas_docs`` — the canvas, a collection, an id, the document as the
JSON text it was stored as, and the host's clock for it (ADR 0113). ``stored`` is the one reading of
a row, so a whole-array read, a page of one collection and the walk a backup makes all carry the
same document; ``ORDER`` is the one order they are read in, the table's primary key past the canvas,
so a collection listed twice reads the same both times however its writes landed.

A walk is one statement a batch, the next starting after the row the last one ended on, so a reader
holds a batch rather than a collection however many documents the canvas keeps. ``catalogue`` answers
what a canvas holds by collection rather than any of it, and ``page`` is the collection read a page at
a time once a sweep has its catalogue: one statement, the next page named by the id this one ended on,
so a document written or removed between two pages moves neither.
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any, Dict, Iterator, List, Optional

# One order for every read, so a page's list of a collection is the same however its writes landed.
ORDER = "ORDER BY collection, id"

DOCUMENTS = "SELECT collection, id, value, at FROM canvas_docs WHERE canvas_id = ?"

# How many rows one statement of a walk reads. A caller reading a canvas whole holds all of them
# anyway, so this bounds one statement's fetch rather than the memory the read costs.
WALK_BATCH = 500

# What one document weighs beside its content: the keys, the clock and the punctuation a read of the
# data carries for it. Counting only the content would let a page keep a hundred thousand one-byte
# documents and hand every open an answer many times the cap — so the cap, the catalogue's ``bytes``
# and the bound a whole-array read is cut at are all one measure.
DOC_BYTES = 64

# A page is what one screen draws, and the number a sweep reads without being told: 200 documents a
# page, and 500 the most a caller can ask for.
PAGE_ROWS = 200
PAGE_MAX = 500

# What each collection holds, how fresh it is and what it weighs, in the one statement a catalogue
# is: no document is read, so a canvas of five thousand of them is the same cost as one of five.
COLLECTIONS = """SELECT collection, COUNT(*), MAX(at),
                        SUM(length(CAST(collection AS BLOB)) + length(CAST(id AS BLOB))
                            + length(CAST(value AS BLOB)) + ?)
                 FROM canvas_docs WHERE canvas_id = ? GROUP BY collection ORDER BY collection"""

# Every row with what it weighs, for the whole-array read a device from before the paged route
# makes: the same measure as ``COLLECTIONS``, one document to a row, so the read is cut where the
# next document would pass the bound rather than after it.
WEIGHED = """SELECT collection, id, value, at,
                    ? + length(CAST(collection AS BLOB)) + length(CAST(id AS BLOB))
                      + length(CAST(value AS BLOB))
             FROM canvas_docs WHERE canvas_id = ? ORDER BY collection, id"""


def stored(collection: str, doc_id: str, value: str, at: int) -> Dict[str, Any]:
    """One row of ``canvas_docs`` as the document it holds: a collection, an id, the document and
    the host's clock for it."""
    return {"collection": collection, "id": doc_id, "doc": json.loads(value), "at": at}


def each(
    conn: sqlite3.Connection,
    canvas_id: str,
    collection: Optional[str] = None,
    batch: int = WALK_BATCH,
    doc_id: Optional[str] = None,
) -> Iterator[Dict[str, Any]]:
    """A canvas's documents, ``batch`` of them at a time, in ``ORDER``.

    Narrowed by whichever name is given, as the read is: ``collection`` is that collection's
    documents and ``doc_id`` the one document on that key, which stays one point lookup on the
    table's primary key rather than a parse of everything the canvas keeps. A walk naming neither
    reads every collection's documents in that same order, so the whole of a canvas's data and one
    collection of it are one rule read twice.

    A generator, so the walk is read as far as its caller needs and the caller's own work fits at
    the statement boundary rather than having to hold a cursor open across it.
    """
    keyset = ""
    after: tuple = ()
    while True:
        query, args = DOCUMENTS, [canvas_id]
        if collection is not None:
            query += " AND collection = ?"
            args.append(collection)
        if doc_id is not None:
            query += " AND id = ?"
            args.append(doc_id)
        rows = conn.execute(f"{query} {keyset} {ORDER} LIMIT ?", (*args, *after, batch)).fetchall()
        for row in rows:
            yield stored(*row)
        if len(rows) < batch:
            return
        last = rows[-1]
        # The next statement starts after the row this one ended on. A pinned collection says that
        # as one id, which the index seeks as tightly as the collection's own name; a whole-canvas
        # walk needs both halves of the key, and a row value is the only form to seek that from.
        if collection is not None:
            keyset, after = "AND id > ?", (last[1],)
        else:
            keyset, after = "AND (collection, id) > (?, ?)", (last[0], last[1])


def catalogue(conn: sqlite3.Connection, canvas_id: str) -> Dict[str, Any]:
    """A canvas's data by collection: each one's name, how many documents it holds, the newest of
    their clocks, and what the whole of the canvas's data weighs.

    One statement grouped by collection, so a canvas of five thousand documents is one read rather
    than five thousand, and no document is parsed to answer it. ``bytes`` is the measure the canvas's
    cap counts — each document's collection, its id and the JSON it is stored as, plus ``DOC_BYTES``
    for the envelope a read carries for it — so a reader can compare a catalogue to the cap it is
    told without a second opinion about what a byte is.

    ``docs_at`` on the canvas's record is the newest of these, and a device compares it to what it
    last swept; a collection's own ``newest_at`` says which part of a canvas moved.
    """
    rows = conn.execute(COLLECTIONS, (DOC_BYTES, canvas_id)).fetchall()
    return {
        "collections": [
            {"collection": collection, "count": count, "newest_at": newest}
            for collection, count, newest, _ in rows
        ],
        "bytes": sum(row[3] for row in rows),
    }


def page(
    conn: sqlite3.Connection,
    canvas_id: str,
    collection: str,
    after: Optional[str] = None,
    limit: int = PAGE_ROWS,
) -> Dict[str, Any]:
    """One page of a collection, the key the next page starts after, and how big the collection is.

    The page is a keyset on ``(collection, id)`` — the one order every read here uses — rather than
    an offset, so a document written or removed between two pages moves neither: ``after`` names the
    last id the caller holds and the page starts past it, whether or not that document is still
    there. One row more than the page is read, which is how ``next`` knows whether another page
    exists: it is the page's last id, and null exactly when this was the last page.

    ``limit`` is clamped to ``PAGE_MAX`` rather than refused, since the answer still says whether
    another page follows; ``count`` is the whole collection's, not the page's, so a reader can say
    how far it has to go.
    """
    limit = max(1, min(int(limit), PAGE_MAX))
    query, args = f"{DOCUMENTS} AND collection = ?", [canvas_id, collection]
    if after is not None:
        query += " AND id > ?"
        args.append(after)
    rows = conn.execute(f"{query} {ORDER} LIMIT ?", (*args, limit + 1)).fetchall()
    documents = [stored(*row) for row in rows[:limit]]
    count = conn.execute(
        "SELECT COUNT(*) FROM canvas_docs WHERE canvas_id = ? AND collection = ?",
        (canvas_id, collection),
    ).fetchone()[0]
    return {
        "documents": documents,
        "next": documents[-1]["id"] if len(rows) > limit else None,
        "count": count,
    }


def upto(conn: sqlite3.Connection, canvas_id: str, cap: int) -> List[Dict[str, Any]]:
    """A canvas's documents as one array, stopped before the document that would pass ``cap``.

    The whole-array read a device from before the paged route makes, which can only hold what its
    own cap was: the read is cut where the next document would take it past ``cap``, so what it
    answers is a prefix of ``each``'s order, whole documents throughout, and its size is the same
    measure the cap counts. A document is never cut in half — a half document is a value no page
    could parse — so an answer can be a whole document short of the bound.
    """
    held: List[Dict[str, Any]] = []
    total = 0
    for row in conn.execute(WEIGHED, (DOC_BYTES, canvas_id)):
        if total + row[4] > cap:
            break
        total += row[4]
        held.append(stored(*row[:4]))
    return held
