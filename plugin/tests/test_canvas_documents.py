"""A canvas's data as the host catalogues it, answers one collection a page at a time, and caps it.

A sweep reads the catalogue first and then asks each collection for a page, so the two reads a
device makes are what this holds: the catalogue's row a collection with its count and its newest
document's clock, and a page of a collection with the key the next one starts after. Beside them,
the caps one write is refused by — a document's and the canvas's, each refused whole — and the
record's ``docs_at``, which is how a device knows its copy of a canvas is out of date. The
whole-array read a device from before the paged route survives, bounded to what it could hold.

Run: python3 -m unittest plugin.tests.test_canvas_documents -v
"""

from __future__ import annotations

import asyncio
import json
import unittest
from pathlib import Path
from typing import Any, Dict, List, Tuple
from unittest import mock

import plugin
from plugin import canvas_docs, canvases
from plugin.store import connect, db_path
from plugin.tests._helpers import FakeWeb, RouteAdapter, route, temp_hermes_home, wire

PROMPT = "A bookmark board, one collection of five thousand links"
BODY = {"input": [{"role": "user", "content": PROMPT}]}


def plant(path: Path, canvas_id: str, rows: List[Tuple[str, str, Any, int]]) -> None:
    """Rows written straight into one canvas's data, as ``(collection, id, document, at)``.

    A fixture of five thousand documents is planted rather than put one at a time: every ``put_doc``
    weighs the whole of the canvas, which is the rule its cap rests on, so a write each is a
    quadratic fixture. One transaction, because a write the connection never committed is invisible
    to the read that follows it.
    """
    conn = connect(path)
    try:
        conn.execute("BEGIN")
        conn.executemany(
            "INSERT INTO canvas_docs (canvas_id, collection, id, value, at) VALUES (?, ?, ?, ?, ?)",
            [
                (canvas_id, collection, doc_id, json.dumps(doc), at)
                for collection, doc_id, doc, at in rows
            ],
        )
        conn.execute("COMMIT")
    finally:
        conn.close()


class Host:
    """A wired plugin over a throwaway store, with one canvas in it and its routes to call."""

    def __init__(self, case: unittest.TestCase) -> None:
        temp_hermes_home(case)
        self.app = wire(case, RouteAdapter())
        self.path = db_path(Path(__import__("hermes_constants").get_hermes_home()))
        self.canvas = canvases.create(
            self.path, request_profile="default", bot_id="bot-1", prompt=PROMPT, body=BODY
        )

    def call(
        self,
        path: str,
        method: str = "GET",
        body: Any = None,
        query: Any = None,
        **match: str,
    ) -> Dict[str, Any]:
        request = FakeWeb.Request()
        request.match_info, request.headers = match, {}
        request.query = query or {}
        request.json = mock.AsyncMock(return_value=body)
        return asyncio.run(route(self.app, plugin.PREFIX + path, method)(request))

    def page(self, collection: str, **query: str) -> Dict[str, Any]:
        """One page of a collection as the route answers it."""
        return self.call(
            "/canvases/{canvas_id}/data/{collection}",
            canvas_id=self.canvas["id"],
            collection=collection,
            query=query,
        )["payload"]

    def catalogue(self) -> Dict[str, Any]:
        return self.call("/canvases/{canvas_id}/data", canvas_id=self.canvas["id"])["payload"]


class CatalogueTest(unittest.TestCase):
    """The catalogue: one row a collection, what it holds, how fresh it is, and what it weighs."""

    def setUp(self) -> None:
        self.host = Host(self)

    def test_the_catalogue_names_each_collection_with_its_count_and_newest_document(self) -> None:
        plant(
            self.host.path,
            self.host.canvas["id"],
            [
                ("bookmarks", "b1", {"n": 1}, 1_000),
                ("bookmarks", "b2", {"n": 2}, 3_000),
                ("bookmarks", "b3", {"n": 3}, 2_000),
                ("notes", "n1", {"text": "one"}, 4_000),
            ],
        )
        answer = self.host.catalogue()
        self.assertEqual(answer["object"], "gots.canvas.data")
        # A collection a row, in the store's own order.
        self.assertEqual(
            answer["collections"],
            [
                {"collection": "bookmarks", "count": 3, "newest_at": 3_000},
                {"collection": "notes", "count": 1, "newest_at": 4_000},
            ],
        )
        self.assertGreater(answer["bytes"], 0)

    def test_a_canvas_holding_nothing_is_an_empty_catalogue(self) -> None:
        self.assertEqual(
            self.host.catalogue(), {"object": "gots.canvas.data", "collections": [], "bytes": 0}
        )

    def test_the_catalogue_weighs_the_data_as_the_cap_does(self) -> None:
        # `bytes` is the same measure the canvas's cap counts, so a sweep that compares it to the
        # cap gets the host's own answer rather than a second opinion. A write that replaces a row
        # with the document it already holds leaves the total where the catalogue said it was.
        canvas_id = self.host.canvas["id"]
        plant(
            self.host.path,
            canvas_id,
            [("bookmarks", f"b{n}", {"n": n}, 1_000 + n) for n in range(40)],
        )
        weighed = canvases.data_catalogue(self.host.path, canvas_id)["bytes"]
        with mock.patch.object(canvases, "DATA_BYTES", weighed):
            stored = canvases.put_doc(self.host.path, canvas_id, "bookmarks", "b0", {"n": 0})
            self.assertEqual(stored["id"], "b0")
            with self.assertRaises(canvases.CanvasError) as refused:
                canvases.put_doc(self.host.path, canvas_id, "bookmarks", "one-more", {"n": 99})
        self.assertIn("capped at", str(refused.exception))

    def test_the_data_routes_answer_a_canvas_the_store_does_not_hold_with_a_404(self) -> None:
        for path, match in (
            ("/canvases/{canvas_id}/data", {}),
            ("/canvases/{canvas_id}/data/{collection}", {"collection": "bookmarks"}),
        ):
            with self.subTest(path=path):
                answer = self.host.call(path, canvas_id="nope", **match)
                self.assertEqual(answer["status"], 404)
                self.assertIn("no such canvas", answer["payload"]["error"]["message"])

    def test_the_data_routes_answer_the_connections_own_refusal(self) -> None:
        # The same auth as every other route: a request the adapter refuses never reaches the store.
        adapter = RouteAdapter()
        adapter.denied = FakeWeb.json_response({"error": {"message": "no"}}, 401)
        self.host.app = wire(self, adapter)
        for path, match in (
            ("/canvases/{canvas_id}/data", {}),
            ("/canvases/{canvas_id}/data/{collection}", {"collection": "bookmarks"}),
        ):
            with self.subTest(path=path):
                self.assertEqual(
                    self.host.call(path, canvas_id=self.host.canvas["id"], **match)["status"], 401
                )


class PageTest(unittest.TestCase):
    """One collection, a page at a time: the keyset, the key the next page starts after."""

    def setUp(self) -> None:
        self.host = Host(self)

    def test_five_thousand_documents_read_in_twenty_five_pages_of_two_hundred(self) -> None:
        ids = [f"b{n:05d}" for n in range(5_000)]
        plant(
            self.host.path,
            self.host.canvas["id"],
            [
                ("bookmarks", doc_id, {"n": n}, 1_700_000_000_000 + n)
                for n, doc_id in enumerate(ids)
            ],
        )
        held: List[str] = []
        after: Any = None
        for page in range(25):
            answer = self.host.page("bookmarks", **({"after": after} if after else {}))
            expected = ids[page * 200 : (page + 1) * 200]
            self.assertEqual([document["id"] for document in answer["documents"]], expected)
            self.assertEqual(answer["documents"][0]["doc"], {"n": page * 200})
            # `next` is the last id this page answered, and null only once the collection is read.
            self.assertEqual(answer["next"], expected[-1] if page < 24 else None)
            # The page's count is the whole collection's, not the page's.
            self.assertEqual(answer["count"], 5_000)
            held.extend(document["id"] for document in answer["documents"])
            after = answer["next"]
        self.assertEqual(held, ids)
        self.assertEqual(len(set(held)), 5_000)
        # A page asked past the end is an empty one, and the collection still says how big it is.
        self.assertEqual(
            self.host.page("bookmarks", after=ids[-1]),
            {"object": "gots.canvas.documents", "documents": [], "next": None, "count": 5_000},
        )

    def test_a_page_is_at_most_five_hundred_rows(self) -> None:
        plant(
            self.host.path,
            self.host.canvas["id"],
            [("bookmarks", f"b{n:04d}", {"n": n}, 1_000 + n) for n in range(600)],
        )
        asked = self.host.page("bookmarks", limit="100000")
        self.assertEqual(len(asked["documents"]), 500)
        self.assertEqual(len(asked["documents"]), canvas_docs.PAGE_MAX)
        self.assertEqual(asked["next"], "b0499")
        self.assertEqual(len(self.host.page("bookmarks", after=asked["next"])["documents"]), 100)
        # A limit under the max is the caller's to choose, as a query string is one.
        self.assertEqual(len(self.host.page("bookmarks", limit="2")["documents"]), 2)
        # No limit is the page a sweep asks for.
        self.assertEqual(len(self.host.page("bookmarks")["documents"]), canvas_docs.PAGE_ROWS)

    def test_a_limit_that_is_no_count_is_refused_rather_than_guessed(self) -> None:
        for asked in ("lots", "0", "-3", "2.5"):
            with self.subTest(limit=asked):
                answer = self.host.call(
                    "/canvases/{canvas_id}/data/{collection}",
                    canvas_id=self.host.canvas["id"],
                    collection="bookmarks",
                    query={"limit": asked},
                )
                self.assertEqual(answer["status"], 400)
                self.assertIn("limit", answer["payload"]["error"]["message"])

    def test_a_page_after_an_id_no_document_holds_starts_where_that_id_would_be(self) -> None:
        # The keyset is `(collection, id)`: a page starts past the id it was given whether or not
        # that document is still there, which is what makes a delete between two pages harmless.
        plant(
            self.host.path,
            self.host.canvas["id"],
            [("bookmarks", doc_id, {}, 1_000) for doc_id in ("a", "c", "e")],
        )
        self.assertEqual(
            [document["id"] for document in self.host.page("bookmarks", after="b")["documents"]],
            ["c", "e"],
        )


class CapsTest(unittest.TestCase):
    """One write, refused whole: a document past its own cap, or a canvas past the whole data's."""

    def setUp(self) -> None:
        self.host = Host(self)

    def test_a_document_past_two_hundred_and_fifty_six_kb_is_refused_whole(self) -> None:
        canvas_id = self.host.canvas["id"]
        canvases.put_doc(self.host.path, canvas_id, "bookmarks", "kept", {"n": 1})
        with self.assertRaises(canvases.CanvasError) as refused:
            canvases.put_doc(
                self.host.path, canvas_id, "bookmarks", "big", {"text": "x" * canvases.DOC_MAX_BYTES}
            )
        self.assertEqual(refused.exception.status, 400)
        self.assertIn("256 KB", str(refused.exception))
        self.assertIn("document", str(refused.exception))
        # The canvas keeps exactly the documents it had.
        self.assertEqual(
            [document["id"] for document in canvases.data(self.host.path, canvas_id)], ["kept"]
        )

    def test_a_document_inside_its_cap_is_stored(self) -> None:
        canvas_id = self.host.canvas["id"]
        canvases.put_doc(
            self.host.path, canvas_id, "bookmarks", "wide", {"text": "x" * (canvases.DOC_MAX_BYTES // 2)}
        )
        self.assertEqual(
            [document["id"] for document in canvases.data(self.host.path, canvas_id)], ["wide"]
        )

    def test_a_canvas_past_sixty_four_mb_is_refused_whole(self) -> None:
        # The cap is 64 MB, and a fixture that wrote one would be 64 MB of test data: the constant
        # is lowered for the case and the rule is the same one — past the cap, refused whole.
        canvas_id = self.host.canvas["id"]
        canvases.put_doc(self.host.path, canvas_id, "bookmarks", "kept", {"n": 1})
        with mock.patch.object(canvases, "DATA_BYTES", 4 * 1024):
            with self.assertRaises(canvases.CanvasError) as refused:
                canvases.put_doc(
                    self.host.path, canvas_id, "bookmarks", "big", {"text": "x" * (4 * 1024)}
                )
        self.assertEqual(refused.exception.status, 400)
        self.assertIn("4 KB", str(refused.exception))
        self.assertIn("Remove something first", str(refused.exception))
        self.assertEqual(
            [document["id"] for document in canvases.data(self.host.path, canvas_id)], ["kept"]
        )

    def test_the_cap_is_sixty_four_megabytes_and_a_document_two_hundred_and_fifty_six_kb(self) -> None:
        self.assertEqual(canvases.DATA_BYTES, 64 * 1024 * 1024)
        self.assertEqual(canvases.DOC_MAX_BYTES, 256 * 1024)


class RecordTest(unittest.TestCase):
    """The record says how fresh a canvas's data is, so a device knows what to sweep."""

    def setUp(self) -> None:
        self.host = Host(self)

    def test_the_record_says_docs_at(self) -> None:
        canvas_id = self.host.canvas["id"]
        self.assertIsNone(canvases.record(self.host.path, canvas_id)["docs_at"])
        plant(
            self.host.path,
            canvas_id,
            [("bookmarks", "b1", {}, 1_000), ("notes", "n1", {}, 3_000), ("bookmarks", "b2", {}, 2_000)],
        )
        # The newest clock among its documents, whichever collection it sits in — and it rides the
        # list and the one-canvas read alike, since a poll reads the list and never a document.
        self.assertEqual(canvases.record(self.host.path, canvas_id)["docs_at"], 3_000)
        self.assertEqual(
            self.host.call("/canvases/{canvas_id}", canvas_id=canvas_id)["payload"]["canvas"]["docs_at"],
            3_000,
        )
        listed = self.host.call("/canvases")["payload"]["canvases"]
        self.assertEqual([row["docs_at"] for row in listed], [3_000])
        # Removing the newest document moves it back, because there is no counter to fall behind.
        canvases.remove_doc(self.host.path, canvas_id, "notes", "n1")
        self.assertEqual(canvases.record(self.host.path, canvas_id)["docs_at"], 2_000)
        canvases.remove_doc(self.host.path, canvas_id, "bookmarks", "b2")
        canvases.remove_doc(self.host.path, canvas_id, "bookmarks", "b1")
        self.assertIsNone(canvases.record(self.host.path, canvas_id)["docs_at"])


class LegacyReadTest(unittest.TestCase):
    """The whole-array read a device from before the paged route makes, and its 1 MB."""

    def setUp(self) -> None:
        self.host = Host(self)

    def test_a_get_without_docs_none_answers_at_most_a_megabyte(self) -> None:
        canvas_id = self.host.canvas["id"]
        # 300 documents of 8 KB are about 2.4 MB: more than an app from before the paged read kept.
        plant(
            self.host.path,
            canvas_id,
            [("bookmarks", f"b{n:03d}", {"text": "x" * 8_000}, 1_000 + n) for n in range(300)],
        )
        whole = self.host.call("/canvases/{canvas_id}", canvas_id=canvas_id)["payload"]["canvas"]
        # Measured the way the host's own cap measures a canvas's data: each document's collection,
        # its id and the JSON it is stored as, plus the envelope a read carries for it.
        weighed = sum(
            canvases.DOC_BYTES
            + len(document["collection"].encode("utf-8"))
            + len(document["id"].encode("utf-8"))
            + len(json.dumps(document["doc"]).encode("utf-8"))
            for document in whole["data"]
        )
        self.assertLessEqual(weighed, canvases.LEGACY_DATA_BYTES)
        # A page is whole documents in the store's order, so the cut leaves no half a document, and
        # what it answered is the longest run that fits: every planted document weighs the same, so
        # one more would pass the bound and one fewer would have been a short answer.
        each = canvases.DOC_BYTES + len("bookmarks") + len("b000")
        each += len(json.dumps({"text": "x" * 8_000}))
        self.assertGreater(weighed + each, canvases.LEGACY_DATA_BYTES)
        self.assertLess(len(whole["data"]), 300)
        self.assertEqual([document["id"] for document in whole["data"]][:2], ["b000", "b001"])
        # `?docs=none` is the app asking for the record alone: no document at all, and `docs_at`
        # still says how fresh the data it is not carrying is.
        alone = self.host.call(
            "/canvases/{canvas_id}", canvas_id=canvas_id, query={"docs": "none"}
        )["payload"]["canvas"]
        self.assertNotIn("data", alone)
        self.assertEqual(alone["docs_at"], 1_299)
        self.assertEqual(alone["id"], canvas_id)

    def test_a_canvas_inside_the_bound_is_answered_whole(self) -> None:
        canvas_id = self.host.canvas["id"]
        plant(
            self.host.path,
            canvas_id,
            [("bookmarks", f"b{n}", {"n": n}, 1_000 + n) for n in range(50)],
        )
        whole = self.host.call("/canvases/{canvas_id}", canvas_id=canvas_id)["payload"]["canvas"]
        self.assertEqual(len(whole["data"]), 50)
        self.assertEqual(whole["data"][0]["doc"], {"n": 0})
