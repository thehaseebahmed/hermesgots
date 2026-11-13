"""A canvas's data copied into an OKF vault, when that canvas's own switch is on.

The vault is a bundle of markdown notes, one per document, under the bot's own home: a folder named
by the canvas's id, a folder named by each collection, a note named by the document's id. What this
holds is the rule that makes it a backup rather than a copy that grows: a note is written only where
its document moved on the host's own clock, so a second tick writes nothing it already wrote and a
note the user edited in the vault is left alone; a note whose document a completed walk no longer
names is deleted; and a tick writes a bounded number of files, so five thousand documents converge
over ticks rather than holding the host for a minute.

Run: python3 -m unittest plugin.tests.test_canvas_vault -v
"""

from __future__ import annotations

import asyncio
import json
import math
import os
import time
import unittest
from pathlib import Path
from typing import Any, Dict, List, Tuple
from unittest import mock

import plugin
from plugin import canvas_vault, canvases
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

# A clock in the past, so a planted document is older than the note a tick writes for it: the vault
# writes a note whose document is newer than the file, and a fixture stamped with "now" would be
# skipped the second time this host's clock has moved on.
AT = 1_700_000_000_000


def frontmatter(text: str) -> Dict[str, Any]:
    """A note's frontmatter as the values it holds: ``key`` to its scalar, quotes taken off.

    Read the way a YAML reader reads one line of it — a value in double quotes is the text it
    encloses, and everything else is the line as written — since a note quotes what a reader would
    otherwise take for something else.
    """
    assert text.startswith("---\n"), "a note opens with frontmatter"
    head = text.split("---\n", 2)[1]
    read: Dict[str, Any] = {}
    for line in head.splitlines():
        if not line.strip():
            continue
        key, _, value = line.partition(": ")
        read[key] = json.loads(value) if value.startswith('"') else value
    return read


def body_of(text: str) -> str:
    """A note's body: what stands under its frontmatter."""
    return text.split("---\n", 2)[2]


def fenced(text: str) -> Any:
    """The json a note carries in its fenced block."""
    return json.loads(text.split("```json\n", 1)[1].split("\n```", 1)[0])


class Host:
    """A wired plugin over a throwaway home, with one canvas in it and its routes to call."""

    def __init__(self, case: unittest.TestCase) -> None:
        self.home = temp_hermes_home(case)
        self.app = wire(case, RouteAdapter())
        self.path = db_path(self.home)
        self.canvas = canvases.create(
            self.path, request_profile="default", bot_id="bot-1", prompt=PROMPT, body=BODY
        )

    @property
    def id(self) -> str:
        return self.canvas["id"]

    @property
    def vault(self) -> Path:
        """Where this bot's vault is: the fixed folder under its home."""
        return canvas_vault.root(self.home)

    @property
    def folder(self) -> Path:
        """The one folder a canvas's notes live in — named by its id."""
        return self.vault / self.id

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

    def switched(self, on: bool) -> None:
        """Turns the canvas's own backup switch, as the options sheet's row does."""
        canvases.update(self.path, self.id, {"vault": on})

    def put(self, collection: str, doc_id: str, doc: Any) -> None:
        canvases.put_doc(self.path, self.id, collection, doc_id, doc)

    def back_up(self) -> int:
        """One tick of the vault, as the watcher's own tick calls it."""
        return canvas_vault.tick(self.path, self.home)

    def notes(self, collection: str) -> List[str]:
        """The note files of one collection, its own ``index.md`` left out."""
        folder = self.folder / collection
        return sorted(
            one.name for one in folder.glob("*.md") if one.name != canvas_vault.INDEX
        )


class SwitchTest(unittest.TestCase):
    """The switch is the canvas's own, and off is the default a store written before it has."""

    def setUp(self) -> None:
        self.host = Host(self)

    def test_a_canvas_whose_switch_is_off_writes_no_file(self) -> None:
        self.host.put("bookmarks", "b1", {"title": "Rust"})
        self.assertFalse(canvases.record(self.host.path, self.host.id)["vault"])
        self.assertEqual(self.host.back_up(), 0)
        self.assertFalse(self.host.vault.exists(), "no vault is made for a canvas that is not backed up")

    def test_the_record_carries_the_switch_and_the_update_route_writes_it(self) -> None:
        self.assertIs(canvases.record(self.host.path, self.host.id)["vault"], False)
        answer = self.host.call(
            "/canvases/{canvas_id}", method="POST", body={"vault": True}, canvas_id=self.host.id
        )
        self.assertEqual(answer["status"], 200)
        self.assertIs(answer["payload"]["canvas"]["vault"], True)
        self.assertIs(canvases.record(self.host.path, self.host.id)["vault"], True)
        # A flag that is no boolean is refused rather than stored, as every flag of this record is.
        refused = self.host.call(
            "/canvases/{canvas_id}", method="POST", body={"vault": "yes"}, canvas_id=self.host.id
        )
        self.assertEqual(refused["status"], 400)
        self.assertIn("vault", refused["payload"]["error"]["message"])
        self.assertIs(canvases.record(self.host.path, self.host.id)["vault"], True)

    def test_turning_the_switch_off_writes_nothing_more_and_deletes_nothing(self) -> None:
        self.host.switched(True)
        self.host.put("bookmarks", "b1", {"title": "Rust"})
        self.assertEqual(self.host.back_up(), 3, "a note, and the two folders' own indexes")
        kept = self.host.folder / "bookmarks" / canvas_vault.note_name("b1")
        inode = kept.stat().st_ino
        self.host.switched(False)
        self.host.put("bookmarks", "b2", {"title": "Go"})
        self.assertEqual(self.host.back_up(), 0)
        self.assertEqual(kept.stat().st_ino, inode, "the note already written is left where it is")
        self.assertFalse((self.host.folder / "bookmarks" / canvas_vault.note_name("b2")).exists())


class NoteTest(unittest.TestCase):
    """One document, one note: the frontmatter the vault lists it by, and the document whole."""

    def setUp(self) -> None:
        self.host = Host(self)

    def test_one_tick_writes_three_notes_and_one_index_md_each_with_type(self) -> None:
        self.host.switched(True)
        plant(
            self.host.path,
            self.host.id,
            [
                (
                    "bookmarks",
                    "b1",
                    {
                        "title": "Rust",
                        "description": "The language",
                        "url": "https://example.com/rust",
                        "tags": ["rust", "lang"],
                        "n": 1,
                    },
                    AT,
                ),
                ("bookmarks", "b2", {"title": "Go"}, AT + 1),
                ("bookmarks", "b3", {"n": 3}, AT + 2),
            ],
        )
        written = self.host.back_up()
        # Three notes and the collection's own index, and the canvas's own index above them.
        self.assertEqual(written, 5)

        folder = self.host.folder / "bookmarks"
        self.assertEqual(len(self.host.notes("bookmarks")), 3)
        self.assertTrue((folder / canvas_vault.INDEX).exists())
        # Every file in the folder says what it is, as OKF's one required key asks.
        for one in sorted(folder.glob("*.md")):
            with self.subTest(file=one.name):
                self.assertEqual(frontmatter(one.read_text(encoding="utf-8"))["type"][:7], "canvas.")

        note = frontmatter((folder / canvas_vault.note_name("b1")).read_text(encoding="utf-8"))
        self.assertEqual(note["type"], "canvas.document")
        self.assertEqual(note["title"], "Rust")
        self.assertEqual(note["description"], "The language")
        self.assertEqual(note["resource"], "https://example.com/rust")
        self.assertEqual(note["tags"], "[rust, lang]")
        self.assertEqual(note["timestamp"], "2023-11-14T22:13:20.000Z")
        self.assertEqual(note["canvas"], self.host.id)
        self.assertEqual(note["collection"], "bookmarks")
        self.assertEqual(note["id"], "b1")

        # A document with no title of its own is named by its id, and one with no description,
        # resource or tags says nothing about them rather than an empty line.
        bare = frontmatter((folder / canvas_vault.note_name("b3")).read_text(encoding="utf-8"))
        self.assertEqual(bare["title"], "b3")
        for absent in ("description", "resource", "tags"):
            self.assertNotIn(absent, bare)

        # The body is the document's scalar fields as a list, and the whole document in a fence.
        text = (folder / canvas_vault.note_name("b1")).read_text(encoding="utf-8")
        body = body_of(text)
        self.assertIn("- **title**: Rust", body)
        self.assertIn("- **n**: 1", body)
        self.assertEqual(fenced(text)["url"], "https://example.com/rust")
        self.assertEqual(
            fenced(text),
            {
                "title": "Rust",
                "description": "The language",
                "url": "https://example.com/rust",
                "tags": ["rust", "lang"],
                "n": 1,
            },
        )

        # The canvas's own index names it by title and lists its collections.
        index = (self.host.folder / canvas_vault.INDEX).read_text(encoding="utf-8")
        self.assertEqual(frontmatter(index)["title"], PROMPT)
        self.assertEqual(frontmatter(index)["type"], "canvas.canvas")
        self.assertIn("bookmarks", body_of(index))
        self.assertIn("3 documents", body_of(index))

        # A title holding a colon and a space is quoted, since a YAML reader would otherwise take
        # the rest of the line as a second key of the frontmatter.
        self.host.put("bookmarks", "b4", {"title": "Split: the bill"})
        self.host.back_up()
        quoted = (folder / canvas_vault.note_name("b4")).read_text(encoding="utf-8")
        self.assertIn('title: "Split: the bill"', quoted)

    def test_a_second_tick_writes_no_file_it_already_wrote(self) -> None:
        self.host.switched(True)
        self.host.put("bookmarks", "b1", {"title": "Rust"})
        self.host.put("bookmarks", "b2", {"title": "Go"})
        self.host.put("notes", "n1", {"text": "one"})
        self.assertGreater(self.host.back_up(), 0)
        held = {
            one: os.stat(one).st_ino
            for one in self.host.vault.rglob("*.md")
        }
        self.assertEqual(len(held), 6, "two notes and two indexes, and the canvas's own index")
        self.assertEqual(self.host.back_up(), 0, "nothing moved, so nothing is written")
        self.assertEqual(
            {one: os.stat(one).st_ino for one in held},
            held,
            "every file is the one that was there: an atomic write is a new inode",
        )

    def test_a_removed_document_s_file_is_gone(self) -> None:
        self.host.switched(True)
        self.host.put("bookmarks", "b1", {"title": "Rust"})
        self.host.put("bookmarks", "b2", {"title": "Go"})
        self.host.back_up()
        gone = self.host.folder / "bookmarks" / canvas_vault.note_name("b1")
        kept = self.host.folder / "bookmarks" / canvas_vault.note_name("b2")
        inode = kept.stat().st_ino
        canvases.remove_doc(self.host.path, self.host.id, "bookmarks", "b1")
        self.host.back_up()
        self.assertFalse(gone.exists(), "a document the host no longer names loses its note")
        self.assertEqual(kept.stat().st_ino, inode, "and the one beside it is not written again")
        self.assertEqual(self.host.notes("bookmarks"), [kept.name])

    def test_an_id_of_dot_dot_etc_passwd_lands_inside_the_collection_s_folder(self) -> None:
        self.host.switched(True)
        self.host.put("bookmarks", "../../etc/passwd", {"title": "Escape"})
        self.host.put("bookmarks", "index", {"title": "Not the index"})
        self.host.back_up()
        folder = self.host.folder / "bookmarks"
        files = sorted(folder.glob("*.md"))
        self.assertEqual(len(files), 3, "two notes and the folder's own index")
        for one in files:
            with self.subTest(file=one.name):
                self.assertEqual(one.parent.resolve(), folder.resolve(), "no name climbs out")
        # The id climbs nowhere and is still the id the note names.
        escaped = [
            one
            for one in files
            if frontmatter(one.read_text(encoding="utf-8")).get("id") == "../../etc/passwd"
        ]
        self.assertEqual(len(escaped), 1)
        self.assertFalse((self.host.home / "etc").exists(), "nothing was written outside the vault")
        # A document whose id is a folder's own name is a note, never the index itself.
        index = frontmatter((folder / canvas_vault.INDEX).read_text(encoding="utf-8"))
        self.assertEqual(index["type"], "canvas.collection")
        self.assertEqual(
            canvas_vault.note_name("index"), canvas_vault.note_name("index"), "a name is steady"
        )
        self.assertNotEqual(canvas_vault.note_name("index"), canvas_vault.INDEX)
        self.assertNotEqual(canvas_vault.note_name("log"), "log.md")
        # Two ids that escape to one stem are still two files, which is what the digest is for.
        self.assertEqual(canvas_vault.note_name("a/b")[:2], "a_")
        self.assertNotEqual(canvas_vault.note_name("a/b"), canvas_vault.note_name("a_b"))


class WakeTest(unittest.TestCase):
    """A data write wakes the vault's watcher, and a burst of writes wakes it once."""

    def setUp(self) -> None:
        self.host = Host(self)

    def test_two_writes_inside_the_interval_wake_one_tick(self) -> None:
        # The tick is what a write asks for, and a page of writes — or a device sweeping a canvas —
        # asks thousands of times: at the write rate, a tick that has nothing to write costs a walk of
        # every note in the vault. A minimum interval between ticks coalesces what the writes asked
        # for, and the watcher's own TICK_SECONDS is the pace a burst ends at.
        woke = mock.Mock()
        with mock.patch.object(canvas_vault, "_ticker", woke), mock.patch.object(
            canvas_vault, "_woken_at", float("-inf")
        ):
            self.host.put("bookmarks", "b1", {"title": "Rust"})
            self.host.put("bookmarks", "b2", {"title": "Go"})
            self.assertEqual(woke.wake.call_count, 1, "two writes inside one interval are one tick")
            # A write past the interval is a tick of its own, so a backup converges as writes land.
            with mock.patch.object(
                canvas_vault,
                "_woken_at",
                time.monotonic() - canvas_vault.WAKE_SECONDS - 1,
            ):
                self.host.put("bookmarks", "b3", {"title": "Zig"})
            self.assertEqual(woke.wake.call_count, 2, "a write past the interval wakes it again")


class BudgetTest(unittest.TestCase):
    """A tick writes a bounded number of files, so a first backup converges over ticks."""

    def setUp(self) -> None:
        self.host = Host(self)

    def test_five_thousand_documents_converge_under_a_two_hundred_file_budget(self) -> None:
        plant(
            self.host.path,
            self.host.id,
            [("bookmarks", f"b{n:05d}", {"title": f"link {n}", "n": n}, AT + n) for n in range(5_000)],
        )
        self.host.switched(True)
        ticks: List[int] = []
        for _ in range(60):
            ticks.append(self.host.back_up())
            if ticks[-1] == 0:
                break
        self.assertLessEqual(max(ticks), canvas_vault.VAULT_PER_TICK)
        self.assertEqual(ticks[0], canvas_vault.VAULT_PER_TICK, "a bounded tick writes its whole budget")
        # Five thousand notes need twenty-five full ticks, however many the two indexes ride.
        self.assertGreaterEqual(len([one for one in ticks if one]), math.ceil(5_000 / 200))
        self.assertEqual(len(self.host.notes("bookmarks")), 5_000)
        self.assertTrue((self.host.folder / "bookmarks" / canvas_vault.INDEX).exists())
        self.assertEqual(self.host.back_up(), 0, "a converged vault writes nothing at all")

    def test_a_walk_cut_short_by_the_budget_deletes_nothing(self) -> None:
        # A cut walk has not seen the collection whole, so a note it did not meet is no evidence of
        # a document removed: only a completed walk deletes.
        self.host.switched(True)
        self.host.put("bookmarks", "b1", {"title": "Rust"})
        self.host.back_up()
        kept = self.host.folder / "bookmarks" / canvas_vault.note_name("b1")
        plant(
            self.host.path,
            self.host.id,
            [("bookmarks", f"c{n:04d}", {"n": n}, AT + 100 + n) for n in range(400)],
        )
        with mock.patch.object(canvas_vault, "VAULT_PER_TICK", 3):
            written = self.host.back_up()
        self.assertEqual(written, 3, "the budget is what a tick writes, whatever it walks")
        self.assertTrue(kept.exists(), "a cut walk deletes nothing")


class StaleTest(unittest.TestCase):
    """A canvas the store no longer holds is never walked, so its notes stay as they are."""

    def setUp(self) -> None:
        self.host = Host(self)

    def test_a_record_taken_out_of_the_store_is_never_walked(self) -> None:
        self.host.switched(True)
        self.host.put("bookmarks", "b1", {"title": "Rust"})
        self.host.back_up()
        kept = self.host.folder / "bookmarks" / canvas_vault.note_name("b1")
        conn = connect(self.host.path)
        try:
            conn.execute("DELETE FROM canvases WHERE id = ?", (self.host.id,))
            conn.commit()
        finally:
            conn.close()
        # Its documents are still rows — a store this old keeps none of them for it — and the vault
        # walks records, so nothing is read and nothing is deleted.
        self.assertEqual(self.host.back_up(), 0)
        self.assertTrue(kept.exists())
