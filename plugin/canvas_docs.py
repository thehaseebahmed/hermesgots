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

``query`` is the read a page makes of a collection it cannot hold: a filter, a sort and one page of
the result, answered in one statement with the total beside it, so five thousand documents cost the
host a scan rather than the phone a copy.
"""

from __future__ import annotations

import json
import math
import re
import sqlite3
from typing import Any, Dict, Iterator, List, Optional, Tuple

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


# A field a query may read, and the rule a JSON path is safe to carry: letters, digits and
# underscores, 1 to 64 of them. A name is never pasted into a path unchecked — the path is SQLite's
# own syntax, and a name that is not one is refused rather than handed to that parser.
QUERY_FIELD = re.compile(r"[A-Za-z0-9_]{1,64}")

# The five comparisons a query may make, each as the SQL it is. Every value is bound rather than
# written into the statement, so a page's words are never the statement's. `eq`, `gt` and `lt` compare
# the field as JSON stores it — a number by its own order, text by its own — while `contains` and
# `prefix` read the field as text, which is why only text is asked of those two.
QUERY_OPS = {
    "eq": "json_extract(value, '$.{field}') = ?",
    "contains": "instr(CAST(json_extract(value, '$.{field}') AS TEXT), ?) > 0",
    "prefix": "substr(CAST(json_extract(value, '$.{field}') AS TEXT), 1, length(?)) = ?",
    "gt": "json_extract(value, '$.{field}') > ?",
    "lt": "json_extract(value, '$.{field}') < ?",
}


def query(conn: sqlite3.Connection, canvas_id: str, spec: Dict[str, Any]) -> Dict[str, Any]:
    """One collection filtered, sorted and cut to a page, and the total beside it: one statement.

    The read a page makes of a collection it cannot hold — five thousand bookmarks, a search box — so
    the filter, the sort and the page are SQLite's rather than a document's worth of Python. ``spec``
    is ``{collection, where: [{field, op, value}], order: {field|id, dir}, limit, offset}``; a value
    is bound, never written into the statement, and a field's name is held to ``QUERY_FIELD`` before
    it becomes a JSON path.

    The total is the whole filter's, not the page's, so a caller can say how far it has to go. It
    rides the one statement as a count joined to the page rather than a second read, and the join is
    why a page asked past its own end still answers the total: an aggregate has a row even when the
    page it is joined to has none.
    """
    collection = _held(spec.get("collection"), "collection")
    filters, values = _where(canvas_id, collection, spec.get("where"))
    key, direction = _sorted(spec.get("order"))
    limit, offset = _limit(spec.get("limit")), _offset(spec.get("offset"))
    rows = conn.execute(
        f"""SELECT page.collection, page.id, page.value, page.at, kept.total
            FROM (SELECT COUNT(*) AS total FROM canvas_docs WHERE {filters}) AS kept
            LEFT JOIN (SELECT collection, id, value, at, {key} AS sort_key
                       FROM canvas_docs WHERE {filters}
                       ORDER BY sort_key {direction}, id LIMIT ? OFFSET ?) AS page ON 1
            ORDER BY page.sort_key {direction}, page.id""",
        (*values, *values, limit, offset),
    ).fetchall()
    return {
        "documents": [stored(*row[:4]) for row in rows if row[1] is not None],
        "total": rows[0][4] if rows else 0,
    }


def _where(canvas_id: str, collection: str, where: Any) -> Tuple[str, List[Any]]:
    """The statement's ``WHERE`` and the values it binds, from the tests a query makes.

    Every name is checked before it reaches a path and every value is bound, so nothing a page sends
    is the statement's own words.
    """
    clause, values = "canvas_id = ? AND collection = ?", [canvas_id, collection]
    if where is None:
        return clause, values
    if not isinstance(where, list):
        raise ValueError("A query's where is a list of {field, op, value} tests.")
    for test in where:
        if not isinstance(test, dict):
            raise ValueError("A query's where is a list of {field, op, value} tests.")
        field = test.get("field")
        if not isinstance(field, str) or not QUERY_FIELD.fullmatch(field):
            raise ValueError(
                "A query's field is a name of 1 to 64 letters, digits or underscores: it is one key "
                "of a document, read as a JSON path, so nothing else is taken."
            )
        op = test.get("op")
        # A name checked by `in` has to be a string first: a list is no op, and asking a dict
        # whether it holds one raises rather than answers.
        if not isinstance(op, str) or op not in QUERY_OPS:
            raise ValueError(f"A query's op is one of {', '.join(QUERY_OPS)}; {op!r} is not one.")
        if "value" not in test:
            raise ValueError(f"A query's {op} test needs the value it compares the field to.")
        value = _value(test["value"], op)
        clause += " AND " + QUERY_OPS[op].format(field=field)
        values.extend([value] * QUERY_OPS[op].count("?"))
    return clause, values


def _value(value: Any, op: str) -> Any:
    """One test's value, as JSON can hold one and as the comparison can read it.

    `contains` and `prefix` compare text, so a number or a flag is refused rather than quietly read as
    its own spelling. A value is text, a finite number or a boolean: `null` is left out because a
    document with no such field reads as null too, and a test that can't tell those apart would answer
    a page rows it did not ask for.
    """
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        if op in ("contains", "prefix"):
            raise ValueError(f"A query's {op} test compares text, so its value is text.")
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if op in ("contains", "prefix"):
            raise ValueError(f"A query's {op} test compares text, so its value is text.")
        if isinstance(value, float) and not math.isfinite(value):
            raise ValueError("A query's value is a finite number.")
        return value
    raise ValueError("A query's value is text, a number or true/false.")


def _sorted(order: Any) -> Tuple[str, str]:
    """The key a page is sorted on and the way it is read: a document's own field, or its id."""
    if order is None:
        return "id", "ASC"
    if not isinstance(order, dict):
        raise ValueError("A query's order is {field, dir}, or {dir} alone to sort by id.")
    field = order.get("field")
    if field is None:
        key = "id"
    elif isinstance(field, str) and QUERY_FIELD.fullmatch(field):
        key = f"json_extract(value, '$.{field}')"
    else:
        raise ValueError(
            "A query's order field is a name of 1 to 64 letters, digits or underscores, or nothing "
            "for the document's id."
        )
    direction = order.get("dir")
    if direction is None:
        direction = "asc"
    if not isinstance(direction, str) or direction.lower() not in ("asc", "desc"):
        raise ValueError("A query's dir is 'asc' or 'desc'.")
    return key, direction.upper()


def _limit(value: Any) -> int:
    """How many documents one page of a query answers: ``PAGE_ROWS`` when none is named, and at most
    ``PAGE_MAX``, clamped rather than refused since the answer's total says what is left."""
    if value is None:
        return PAGE_ROWS
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError(f"A query's limit is a whole number of documents, from 1 to {PAGE_MAX}.")
    return min(value, PAGE_MAX)


def _offset(value: Any) -> int:
    """How many documents a query's page starts past: none at all when it names none."""
    if value is None:
        return 0
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError("A query's offset is a whole number of documents, from 0 up.")
    return value


def _held(value: Any, what: str) -> str:
    """A spec's own name — its collection — as the shape says it: a non-empty string."""
    if not isinstance(value, str) or not value:
        raise ValueError(f"A query's {what} is a name.")
    return value


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
