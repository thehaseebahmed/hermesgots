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
from plugin.tests._helpers import (
    FakeWeb,
    RouteAdapter,
    plant,
    route,
    temp_hermes_home,
    wire,
)

PROMPT = "A bookmark board, one collection of five thousand links"
BODY = {"input": [{"role": "user", "content": PROMPT}]}


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


def bookmark(n: int) -> Tuple[str, str, Any, int]:
    """One of five thousand bookmarks, one in thirty-seven of them about Rust."""
    return (
        "bookmarks",
        f"b{n:05d}",
        {"title": f"{'rust' if n % 37 == 0 else 'go'} link {n}", "n": n},
        1_700_000_000_000 + n,
    )


# The bookmarks a `contains 'rust'` filter matches: one in thirty-seven, so 5000 rows answer 136.
RUSTY = [n for n in range(5_000) if n % 37 == 0]


class QueryTest(unittest.TestCase):
    """The host filtering, sorting and paging one collection for a page: one statement a query.

    A page over five thousand bookmarks cannot hold them to filter them, so the host answers a
    filter, a sort and one page of the result in one statement — and holds a field's name to the
    rule a JSON path can carry before it becomes one.
    """

    def setUp(self) -> None:
        self.host = Host(self)

    def ask(self, **spec: Any) -> Dict[str, Any]:
        """One ``data.query`` call as a page makes it, as the route answers it."""
        return self.host.call(
            "/canvases/{canvas_id}/call",
            method="POST",
            body={"shape": "data.query", "args": spec},
            canvas_id=self.host.canvas["id"],
        )

    def test_a_contains_filter_over_five_thousand_bookmarks_answers_the_right_rows_in_order(self) -> None:
        plant(self.host.path, self.host.canvas["id"], [bookmark(n) for n in range(5_000)])
        filter = [{"field": "title", "op": "contains", "value": "rust"}]
        held: List[int] = []
        for page, offset in enumerate((0, 50, 100)):
            answer = self.ask(
                collection="bookmarks",
                where=filter,
                order={"field": "n", "dir": "asc"},
                limit=50,
                offset=offset,
            )
            self.assertEqual(answer["status"], 200)
            result = answer["payload"]["result"]
            # The total is the whole filter's, not the page's, so a caller knows how far it goes.
            self.assertEqual(result["total"], len(RUSTY))
            expected = RUSTY[offset : offset + 50]
            self.assertEqual([document["doc"]["n"] for document in result["documents"]], expected)
            held.extend(expected)
        # Fifty at a time, in the order asked for, and the last page is the short one.
        self.assertEqual(len(held), len(RUSTY))
        self.assertLess(len(expected), 50)
        # A document comes back whole, as every read of the store answers one.
        conn = connect(self.host.path)
        self.addCleanup(conn.close)
        first = canvas_docs.query(
            conn,
            self.host.canvas["id"],
            {"collection": "bookmarks", "where": filter, "order": {"field": "n", "dir": "asc"}, "limit": 1},
        )["documents"][0]
        self.assertEqual(
            first,
            {
                "collection": "bookmarks",
                "id": "b00000",
                "doc": {"title": "rust link 0", "n": 0},
                "at": 1_700_000_000_000,
            },
        )
        # A page asked past the end is an empty one that still says how many matched: the total rides
        # the same statement as the page, and an aggregate has a row even where its page has none.
        past = self.ask(collection="bookmarks", where=filter, limit=50, offset=1_000)
        self.assertEqual(past["payload"]["result"], {"documents": [], "total": len(RUSTY)})
        # The arrow is the caller's: the same rows from the other end.
        backwards = self.ask(
            collection="bookmarks",
            where=filter,
            order={"field": "n", "dir": "desc"},
            limit=50,
            offset=0,
        )["payload"]["result"]["documents"]
        self.assertEqual([document["doc"]["n"] for document in backwards], RUSTY[::-1][:50])

    def test_a_query_is_one_statement_however_many_documents_it_reads(self) -> None:
        # Filtering, sorting and cutting the page are SQLite's: one statement, which names the
        # document's own JSON path and a LIMIT. A loop over rows, or a second statement for the
        # total, is what this count fails.
        plant(self.host.path, self.host.canvas["id"], [bookmark(n) for n in range(5_000)])
        conn = connect(self.host.path)
        self.addCleanup(conn.close)
        seen: List[str] = []
        conn.set_trace_callback(seen.append)
        try:
            answer = canvas_docs.query(
                conn,
                self.host.canvas["id"],
                {
                    "collection": "bookmarks",
                    "where": [{"field": "n", "op": "gt", "value": 4_950}],
                    "order": {"field": "n", "dir": "desc"},
                    "limit": 50,
                    "offset": 0,
                },
            )
        finally:
            conn.set_trace_callback(None)
        self.assertEqual(len(seen), 1, f"one statement, not {len(seen)}: {seen}")
        self.assertIn("json_extract(value, '$.n')", seen[0])
        self.assertIn("COUNT(*)", seen[0], "the total rides the same statement as its page")
        self.assertIn("LIMIT", seen[0])
        self.assertEqual(answer["total"], 49)
        self.assertEqual(len(answer["documents"]), 49)

    def test_a_field_name_outside_the_rule_is_refused_not_pasted_into_a_json_path(self) -> None:
        plant(
            self.host.path,
            self.host.canvas["id"],
            [("bookmarks", "a", {"title": "kept", "n": 1}, 1_000), ("bookmarks", "b", {"title": "also"}, 2_000)],
        )
        conn = connect(self.host.path)
        self.addCleanup(conn.close)
        seen: List[str] = []
        conn.set_trace_callback(seen.append)
        for field in ("n') OR 1=1 --", "n.json", "$.n", "n" * 65, ""):
            with self.subTest(field=field):
                with self.assertRaises(ValueError) as refused:
                    canvas_docs.query(
                        conn,
                        self.host.canvas["id"],
                        {"collection": "bookmarks", "where": [{"field": field, "op": "eq", "value": 1}]},
                    )
                self.assertIn("field", str(refused.exception))
        # Nothing reached SQLite: the name is refused, never pasted into a path a parser reads.
        self.assertEqual(seen, [])
        # A value is bound rather than pasted, so the same text as a value is a literal that matches
        # nothing — and a document with no such field is simply not the answer.
        answer = canvas_docs.query(
            conn,
            self.host.canvas["id"],
            {"collection": "bookmarks", "where": [{"field": "title", "op": "eq", "value": "n') OR 1=1 --"}]},
        )
        self.assertEqual(answer, {"documents": [], "total": 0})
        self.assertEqual(len(seen), 1)

    def test_a_query_the_shape_cannot_hold_is_refused_in_words_a_page_can_act_on(self) -> None:
        for spec, words in (
            ({"where": [{"field": "n", "op": "like", "value": "1%"}]}, "op"),
            ({"where": [{"field": "n", "op": ["eq"], "value": 1}]}, "op"),
            ({"where": [{"field": "n", "op": "eq"}]}, "value"),
            ({"where": [{"field": "n", "op": "eq", "value": None}]}, "value"),
            ({"where": [{"field": "title", "op": "contains", "value": 5}]}, "text"),
            ({"where": {"field": "n", "op": "eq", "value": 1}}, "where"),
            ({"order": {"field": "n", "dir": "up"}}, "dir"),
            ({"limit": 0}, "limit"),
            ({"limit": "lots"}, "limit"),
            ({"offset": -1}, "offset"),
        ):
            with self.subTest(spec=spec):
                answer = self.ask(collection="bookmarks", **spec)
                self.assertEqual(answer["status"], 400)
                self.assertIn(words, answer["payload"]["error"]["message"])

    def test_the_query_rides_the_page_s_own_calls_without_asking_consent(self) -> None:
        # A canvas's own data is the page's: no declared tool, no consent, and no act lock — the
        # store's own read is what makes it safe, so the call is answered as `data.query` beside
        # `data.put` and `data.remove`.
        plant(self.host.path, self.host.canvas["id"], [bookmark(0)])
        answer = self.ask(collection="bookmarks", limit=1)
        self.assertEqual(answer["status"], 200)
        self.assertEqual(answer["payload"]["object"], "gots.canvas.call")


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


class WeightTest(unittest.TestCase):
    """One rule answers what a document weighs, and every reader of the measure asks it.

    The cap a write is refused by, the catalogue's ``bytes`` a sweep compares to that cap, and the
    bound the whole-array read is cut at are one number: a document that fits a canvas always fits on
    its own, and a measure that moves moves all three at once.
    """

    def setUp(self) -> None:
        self.host = Host(self)

    def test_one_rule_answers_a_document_s_weight(self) -> None:
        canvas_id = self.host.canvas["id"]
        plant(
            self.host.path,
            canvas_id,
            [
                ("bookmarks", "b1", {"title": "Rust", "n": 1}, 1_000),
                ("bookmarks", "b2", {"tags": ["a", "b"], "n": 2}, 2_000),
                ("notes", "n-é", {"text": "héllo ✓"}, 3_000),
            ],
        )
        conn = connect(self.host.path)
        try:
            rows = conn.execute(
                "SELECT collection, id, value FROM canvas_docs WHERE canvas_id = ? "
                "ORDER BY collection, id",
                (canvas_id,),
            ).fetchall()
            self.assertEqual([row[1] for row in rows], ["b1", "b2", "n-é"])
            each = [canvas_docs.weight(conn, *row) for row in rows]
            # The catalogue's bytes are those weights summed, and a collection's are its own rows'.
            self.assertEqual(sum(each), canvas_docs.weigh(conn, canvas_id))
            self.assertEqual(each[0] + each[1], canvas_docs.weigh(conn, canvas_id, "bookmarks"))
            # The whole-array read is cut at the same measure: two documents fit, the third is one
            # past the bound rather than half-written into it.
            self.assertEqual(
                [one["id"] for one in canvas_docs.upto(conn, canvas_id, each[0] + each[1])],
                ["b1", "b2"],
            )
        finally:
            conn.close()
        self.assertEqual(sum(each), canvases.data_catalogue(self.host.path, canvas_id)["bytes"])

        # And the cap a write is refused by is that same number: one byte under a document's own
        # weight refuses it, and the weight itself stores it.
        document = {"text": "héllo ✓"}
        conn = connect(self.host.path)
        try:
            weighed = canvas_docs.weight(conn, "notes", "n2", json.dumps(document))
        finally:
            conn.close()
        with mock.patch.object(canvases, "DOC_MAX_BYTES", weighed - 1):
            with self.assertRaises(canvases.CanvasError) as refused:
                canvases.put_doc(self.host.path, canvas_id, "notes", "n2", document)
        self.assertIn("capped at", str(refused.exception))
        with mock.patch.object(canvases, "DOC_MAX_BYTES", weighed):
            stored = canvases.put_doc(self.host.path, canvas_id, "notes", "n2", document)
        self.assertEqual(stored["id"], "n2")
