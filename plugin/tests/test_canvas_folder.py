"""Run: python3 -m unittest plugin.tests.test_canvas_folder -v
"""

from __future__ import annotations

import threading
import unittest
from pathlib import Path

from plugin import canvases
from plugin.tests.test_canvas_vault import Host as CanvasHost


class Host(CanvasHost):
    @property
    def folder(self) -> Path:
        return canvases.folder_of(self.home, self.id)


class MadeWithTheCanvasTest(unittest.TestCase):
    def setUp(self) -> None:
        self.host = Host(self)

    def test_a_canvas_is_made_with_its_folder(self) -> None:
        self.assertTrue(self.host.folder.is_dir(), "a canvas is made with its folder")

    def test_delete_takes_the_folder_with_it(self) -> None:
        canvases.keep(self.host.path, self.host.id, "draft.html", "<h1>Tip</h1>")
        self.assertEqual(
            [one.name for one in self.host.folder.iterdir()], ["draft.html"]
        )
        gone = self.host.call("/canvases/{canvas_id}", "DELETE", canvas_id=self.host.id)
        self.assertEqual(gone["status"], 200)
        self.assertFalse(self.host.folder.exists(), "the folder is gone with the canvas")


class CappedTest(unittest.TestCase):
    def setUp(self) -> None:
        self.host = Host(self)

    def test_a_file_past_its_cap_is_refused_in_words_naming_the_cap(self) -> None:
        with self.assertRaises(canvases.CanvasError) as refused:
            canvases.keep(self.host.path, self.host.id, "draft.html", "x" * (canvases.FILE_BYTES + 1))
        self.assertIn("draft.html", str(refused.exception))
        self.assertIn(str(canvases.FILE_BYTES // 1024), str(refused.exception))

    def test_the_folder_past_its_cap_refuses_a_write(self) -> None:
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


class KeptFileTest(unittest.TestCase):
    def setUp(self) -> None:
        self.host = Host(self)

    def test_a_canvas_the_store_doesnt_hold_has_no_folder_to_write_in(self) -> None:
        with self.assertRaises(canvases.CanvasError) as refused:
            canvases.keep(self.host.path, "canvas-gone", "draft.html", "<h1>Tip</h1>")
        self.assertEqual(refused.exception.status, 404)
        self.assertIn("no such canvas", str(refused.exception))
        self.assertFalse(canvases.folder_of(self.host.home, "canvas-gone").exists())

    def test_a_name_that_is_not_one_plain_file_name_is_refused(self) -> None:
        for name in (
            "",
            ".",
            "..",
            "plans/today.md",
            "draft.html\x00.txt",
            "x" * (canvases.FILE_NAME_CHARS + 1),
        ):
            with self.subTest(name=name):
                with self.assertRaises(canvases.CanvasError) as refused:
                    canvases.keep(self.host.path, self.host.id, name, "<h1>Tip</h1>")
                self.assertIn("plain name", str(refused.exception))
        self.assertEqual(list(self.host.folder.iterdir()), [], "nothing landed in the folder")

    def test_a_kept_file_is_written_under_the_stores_write_lock(self) -> None:
        held, free, kept = threading.Event(), threading.Event(), threading.Event()

        def hold_the_lock() -> None:
            with canvases._writing(self.host.path):
                held.set()
                free.wait(5)

        def write_the_file() -> None:
            canvases.keep(self.host.path, self.host.id, "draft.html", "<h1>Tip</h1>")
            kept.set()

        threading.Thread(target=hold_the_lock).start()
        self.assertTrue(held.wait(5), "the lock is held")
        try:
            threading.Thread(target=write_the_file).start()
            self.assertFalse(kept.wait(0.3), "the write waits for the lock")
        finally:
            free.set()
        self.assertTrue(kept.wait(5))


class UnreachableTest(unittest.TestCase):
    def setUp(self) -> None:
        self.host = Host(self)

    def test_no_bridge_read_names_a_folder_file(self) -> None:
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
