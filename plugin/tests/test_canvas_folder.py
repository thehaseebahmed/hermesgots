"""A canvas's own folder in the plugin's data: made with it, capped, and gone with it.

A canvas keeps more than its versions and its data (ADR 0170): the draft a build writes, its
plans, its tests and its memory live in one folder under the plugin's own data, made when the
canvas is and taken when it is deleted. Two things hold it: each file and the whole folder are
capped, so a canvas cannot grow without end on a host, and no route or bridge read reaches it — a
page's only channel answers the store's own data, never the host's work in progress (G4).

Run: python3 -m unittest plugin.tests.test_canvas_folder -v
"""

from __future__ import annotations

import unittest
from pathlib import Path

from plugin import canvases
from plugin.tests.test_canvas_vault import Host as CanvasHost


class Host(CanvasHost):
    """The canvas host the vault suite wires, and the folder under it this suite is about."""

    @property
    def folder(self) -> Path:
        """The canvas's own folder, found by the store's own rule rather than named here."""
        return canvases.folder_of(self.home, self.id)


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
        with self.assertRaises(canvases.CanvasError) as refused:
            canvases.keep(self.host.path, self.host.id, "draft.html", "x" * (canvases.FILE_BYTES + 1))
        self.assertIn("draft.html", str(refused.exception))
        self.assertIn(str(canvases.FILE_BYTES // 1024), str(refused.exception))

    def test_the_folder_past_its_cap_refuses_a_write(self) -> None:
        # The folder's cap bounds the lot — the draft, its plans, its tests and its memory — so a
        # canvas cannot grow without end on the host. The write that would cross it is refused
        # whole, and the files already there stay where they are.
        with self.assertRaises(canvases.CanvasError) as refused:
            for index in range(canvases.FOLDER_BYTES // canvases.FILE_BYTES + 1):
                canvases.keep(
                    self.host.path, self.host.id, f"plan-{index}.md", "p" * canvases.FILE_BYTES
                )
        self.assertIn("canvas", str(refused.exception))
        self.assertIn(str(canvases.FOLDER_BYTES // (1024 * 1024)), str(refused.exception))
        self.assertEqual(
            sorted(one.name for one in self.host.folder.iterdir()),
            sorted(
                f"plan-{index}.md"
                for index in range(canvases.FOLDER_BYTES // canvases.FILE_BYTES)
            ),
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
