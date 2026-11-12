"""A canvas's documents, read by one rule: the row's shape, the store's one order, and a walk.

A canvas's data is rows of ``canvas_docs`` — the canvas, a collection, an id, the document as the
JSON text it was stored as, and the host's clock for it (ADR 0113). ``stored`` is the one reading of
a row, so a whole-array read, a page of one collection and the walk a backup makes all carry the
same document; ``ORDER`` is the one order they are read in, the table's primary key past the canvas,
so a collection listed twice reads the same both times however its writes landed.

A walk is one statement a batch, the next starting after the row the last one ended on, so a reader
holds a batch rather than a collection however many documents the canvas keeps.
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any, Dict, Iterator, Optional

# One order for every read, so a page's list of a collection is the same however its writes landed.
ORDER = "ORDER BY collection, id"

DOCUMENTS = "SELECT collection, id, value, at FROM canvas_docs WHERE canvas_id = ?"

# How many rows one statement of a walk reads. A caller reading a canvas whole holds all of them
# anyway, so this bounds one statement's fetch rather than the memory the read costs.
WALK_BATCH = 500


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
