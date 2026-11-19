"""A canvas's own folder in the plugin's data: made with it, capped, and gone with it.

A canvas keeps more than its versions and its data (ADR 0170): the draft a build writes, its
plans, its tests and its memory live in one folder under the plugin's own data, made when the
canvas is and taken when it is deleted. Two things hold it: each file and the whole folder are
capped, so a canvas cannot grow without end on a host, and no route or bridge read reaches it — a
page's only channel answers the store's own data, never the host's work in progress (G4).

Run: python3 -m unittest plugin.tests.test_canvas_folder -v
"""

from __future__ import annotations

import asyncio
import unittest
from pathlib import Path
from typing import Any, Dict
from unittest import mock

import plugin
from plugin import canvases
from plugin.store import db_path
from plugin.tests._helpers import FakeWeb, RouteAdapter, route, temp_hermes_home, wire

PROMPT = "A bookmark board, one collection of five thousand links"
BODY = {"input": [{"role": "user", "content": PROMPT}]}


class Host:
    """A wired plugin over a throwaway home, with one canvas in it and its routes to call."""

    def __init__(self, case: unittest.TestCase) -> None:
        self.home = temp_hermes_home(case)

        class SessionDb:
            def delete_session(self, session_id: str) -> None:
                pass

        adapter = RouteAdapter()
        adapter.session_db = SessionDb()
        self.app = wire(case, adapter)
        self.path = db_path(self.home)
        self.canvas = canvases.create(
            self.path, request_profile="default", bot_id="bot-1", prompt=PROMPT, body=BODY
        )

    @property
    def id(self) -> str:
        return self.canvas["id"]

    @property
    def folder(self) -> Path:
        """The canvas's own folder, found by the store's own rule rather than named here."""
        return canvases.folder_of(self.home, self.id)

    def call(
        self, path: str, method: str = "GET", body: Any = None, **match: str
    ) -> Dict[str, Any]:
        request = FakeWeb.Request()
        request.match_info, request.headers = match, {}
        request.query = {}
        request.json = mock.AsyncMock(return_value=body)
        return asyncio.run(route(self.app, plugin.PREFIX + path, method)(request))


class MadeWithTheCanvasTest(unittest.TestCase):
    """The folder's life is the canvas's: it is there from the start and gone with the delete."""

    def setUp(self) -> None:
        self.host = Host(self)

    def test_a_canvas_is_made_with_its_folder(self) -> None:
        self.assertTrue(self.host.folder.is_dir(), "a canvas is made with its folder")

    def test_delete_takes_the_folder_with_it(self) -> None:
        # Nothing in the folder is read back, so a canvas's delete takes the whole of it: a draft
        # or a plan left behind would be work no canvas owns.
        canvases.keep(self.host.path, self.host.id, "draft.html", "<h1>Tip</h1>")
        self.assertEqual(
            [one.name for one in self.host.folder.iterdir()], ["draft.html"]
        )
        gone = self.host.call("/canvases/{canvas_id}", "DELETE", canvas_id=self.host.id)
        self.assertEqual(gone["status"], 200)
        self.assertFalse(self.host.folder.exists(), "the folder is gone with the canvas")


class CappedTest(unittest.TestCase):
    """Each file and the whole folder are capped, and a write past either says so."""

    def setUp(self) -> None:
        self.host = Host(self)

    def test_a_file_past_its_cap_is_refused_in_words_naming_the_cap(self) -> None:
        # A file is a page at most — the same 256 KB a write admits, since the draft is a page —
        # and the refusal carries the number, so the words move with the cap.
        refused = None
        try:
            canvases.keep(self.host.path, self.host.id, "draft.html", "x" * (canvases.FILE_BYTES + 1))
        except canvases.CanvasError as error:
            refused = str(error)
        self.assertIsNotNone(refused, "an over-cap file is refused")
        self.assertIn("draft.html", refused)
        self.assertIn(str(canvases.FILE_BYTES // 1024), refused)

    def test_the_folder_past_its_cap_refuses_a_write(self) -> None:
        # The folder's cap bounds the lot — the draft, its plans, its tests and its memory — so a
        # canvas cannot grow without end on the host. The write that would cross it is refused
        # whole, and the files already there stay where they are.
        written = 0
        try:
            for index in range(canvases.FOLDER_BYTES // canvases.FILE_BYTES + 1):
                canvases.keep(
                    self.host.path, self.host.id, f"plan-{index}.md", "p" * canvases.FILE_BYTES
                )
                written += 1
        except canvases.CanvasError as error:
            refused = str(error)
        else:
            refused = None
        self.assertIsNotNone(refused, "the folder is capped whole")
        self.assertIn("canvas", refused)
        self.assertIn(str(canvases.FOLDER_BYTES // (1024 * 1024)), refused)
        self.assertEqual(
            sorted(one.name for one in self.host.folder.iterdir()),
            sorted(f"plan-{index}.md" for index in range(written)),
            "the files already written stay where they are",
        )


class UnreachableTest(unittest.TestCase):
    """No route or bridge read reaches the folder: a page's channel answers the store's data."""

    def setUp(self) -> None:
        self.host = Host(self)

    def test_no_bridge_read_names_a_folder_file(self) -> None:
        # The page's only way out is the bridge, and its reads answer the store's own documents: a
        # file in the canvas's folder is not a document behind one. A draft read back through the
        # bridge would be the host's work in progress shown to the page before its build
        # published it, and a plan or a memory file would be the agent's own notes.
        canvases.keep(self.host.path, self.host.id, "draft.html", "<h1>unpublished</h1>")
        canvases.put_doc(self.host.path, self.host.id, "notes", "a", {"text": "the store's own"})
        answered = self.host.call(
            "/canvases/{canvas_id}/call",
            "POST",
            {"shape": "data.query", "args": {"collection": "notes"}},
            canvas_id=self.host.id,
        )
        self.assertEqual(answered["status"], 200, answered)
        documents = answered["payload"]["result"]["documents"]
        self.assertEqual([row["id"] for row in documents], ["a"])
        self.assertNotIn("unpublished", str(answered), "no bridge read names a folder file")


if __name__ == "__main__":
    unittest.main()
