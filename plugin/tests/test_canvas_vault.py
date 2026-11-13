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
        """The one folder a canvas's notes live in, found under the vault rather than named here: the
        vault's own name for a canvas is its rule, not this test's."""
        folders = [one for one in self.vault.iterdir() if one.is_dir()]
        assert len(folders) == 1, "one canvas in the store, one folder in the vault"
        return folders[0]

    def folder_of(self, collection: str) -> Path:
        """The folder the vault filed one collection under, found by the name its index carries."""
        for one in self.folder.iterdir():
            index = one / canvas_vault.INDEX
            if not one.is_dir() or not index.exists():
                continue
            if frontmatter(index.read_text(encoding="utf-8")).get("id") == collection:
                return one
        raise AssertionError(f"no folder under the canvas's own holds {collection!r}")

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
        folder = self.folder_of(collection)
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
        kept = self.host.folder_of("bookmarks") / canvas_vault.note_name("b1")
        inode = kept.stat().st_ino
        self.host.switched(False)
        self.host.put("bookmarks", "b2", {"title": "Go"})
        self.assertEqual(self.host.back_up(), 0)
        self.assertEqual(kept.stat().st_ino, inode, "the note already written is left where it is")
        self.assertFalse((self.host.folder_of("bookmarks") / canvas_vault.note_name("b2")).exists())


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

        folder = self.host.folder_of("bookmarks")
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
        gone = self.host.folder_of("bookmarks") / canvas_vault.note_name("b1")
        kept = self.host.folder_of("bookmarks") / canvas_vault.note_name("b2")
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
        folder = self.host.folder_of("bookmarks")
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
        self.assertTrue((self.host.folder_of("bookmarks") / canvas_vault.INDEX).exists())
        self.assertEqual(self.host.back_up(), 0, "a converged vault writes nothing at all")

    def test_a_walk_cut_short_by_the_budget_deletes_nothing(self) -> None:
        # A cut walk has not seen the collection whole, so a note it did not meet is no evidence of
        # a document removed: only a completed walk deletes.
        self.host.switched(True)
        self.host.put("bookmarks", "b1", {"title": "Rust"})
        self.host.back_up()
        kept = self.host.folder_of("bookmarks") / canvas_vault.note_name("b1")
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
        kept = self.host.folder_of("bookmarks") / canvas_vault.note_name("b1")
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


class OwnershipTest(unittest.TestCase):
    """The vault deletes and rewrites only what it wrote: the rest of the bundle is the reader's.

    A wiki is a folder people add to, so a tick that took every ``*.md`` it did not name would delete
    the notes they wrote beside the ones it did — and a document moving onto a name the reader had
    already used would replace their file with the vault's. What a file is is readable from the file:
    a note says ``type: canvas.document``, and a folder's own index carries the marker the vault
    writes on its first line. Everything else is left exactly as it is.
    """

    def setUp(self) -> None:
        self.host = Host(self)

    def test_a_file_the_vault_did_not_write_is_left_exactly_as_it_is(self) -> None:
        self.host.switched(True)
        self.host.put("bookmarks", "b1", {"title": "Rust"})
        self.host.back_up()
        folder = self.host.folder_of("bookmarks")
        # Two files of the reader's own: one beside the documents, and one at the name the vault would
        # give a document that does not exist yet — which a later write would otherwise overwrite.
        aside = folder / "Reading list.md"
        aside_text = "# Reading list\n\nWhat I still want to read.\n"
        aside.write_text(aside_text, encoding="utf-8")
        clash = folder / canvas_vault.note_name("b2")
        clash_text = "---\ntype: note\n---\n\nMine, with my notes on it.\n"
        clash.write_text(clash_text, encoding="utf-8")

        # A document whose clock is past the note's, which is what a document moving looks like to a
        # tick: b1's own note is set back to the clock it was written at, as an untouched one would be,
        # and then the document moves. b2 is a document the reader's file happens to be named for.
        held = folder / canvas_vault.note_name("b1")
        os.utime(held, (AT / 1000, AT / 1000))
        canvases.put_doc(self.host.path, self.host.id, "bookmarks", "b1", {"title": "Rust, second edition"})
        plant(self.host.path, self.host.id, [("bookmarks", "b2", {"title": "Go"}, AT)])
        self.host.back_up()

        self.assertEqual(aside.read_text(encoding="utf-8"), aside_text, "a note of the reader's stays")
        self.assertEqual(
            clash.read_text(encoding="utf-8"), clash_text, "and one at a document's own name is not replaced"
        )
        # The vault's own notes are still the vault's: b1 moved, and its note says so.
        self.assertIn(
            "Rust, second edition",
            held.read_text(encoding="utf-8"),
            "a note the vault wrote is rewritten when its document moves",
        )
        self.assertEqual(aside.read_text(encoding="utf-8"), aside_text, "and the reader's is still theirs")

    def test_a_folder_the_vault_did_not_write_is_left_exactly_as_it_is(self) -> None:
        self.host.switched(True)
        self.host.put("bookmarks", "b1", {"title": "Rust"})
        self.host.back_up()
        canvas_folder = self.host.folder
        # A folder of the reader's beside the collections, with a note in it the vault never made.
        mine = canvas_folder / "Reading"
        mine.mkdir()
        someday = mine / "someday.md"
        someday.write_text("# Someday\n\nA few links for later.\n", encoding="utf-8")
        # And a note of theirs inside the collection's folder.
        collection = self.host.folder_of("bookmarks")
        beside = collection / "Notes on Rust.md"
        beside_text = "# Notes\n\nBorrow checker, again.\n"
        beside.write_text(beside_text, encoding="utf-8")

        # The collection's every document goes, so the catalogue stops naming it: the vault's own
        # notes go with the collection, and nothing else does.
        canvases.remove_doc(self.host.path, self.host.id, "bookmarks", "b1")
        self.host.back_up()

        self.assertTrue(mine.is_dir(), "a folder of the reader's stays")
        self.assertEqual(someday.read_text(encoding="utf-8"), "# Someday\n\nA few links for later.\n")
        self.assertTrue(collection.is_dir(), "and so does a collection's, while their note is in it")
        self.assertEqual(beside.read_text(encoding="utf-8"), beside_text)
        self.assertFalse(
            (collection / canvas_vault.note_name("b1")).exists(), "the note the vault wrote is gone"
        )
        self.assertFalse((collection / canvas_vault.INDEX).exists(), "and its own index with it")


class FolderNameTest(unittest.TestCase):
    """A folder's name is one directory inside its parent, whatever the collection is called."""

    def setUp(self) -> None:
        self.host = Host(self)

    def test_a_collection_named_for_its_parent_stays_inside_the_canvas_s_folder(self) -> None:
        self.host.switched(True)
        # A collection is a page's to name, so `..` and `.` are names it can give one: escaped and
        # digested as a note's name is, they are folders inside the canvas's own and nowhere else.
        for collection in ("..", ".", "../../etc", "bookmarks"):
            self.host.put(collection, "d1", {"title": collection})
        self.host.back_up()

        self.assertEqual(list(self.host.vault.glob("*.md")), [], "nothing is written in the vault's root")
        above = self.host.vault.parent
        self.assertEqual(list(above.glob("*.md")), [], "nor above it")
        self.assertFalse((above / "bookmarks").exists(), "and no collection's folder is beside the vault")
        self.assertFalse((self.host.home / "etc").exists(), "and nothing escapes the home")

        canvas_folder = self.host.folder
        folders = [one for one in canvas_folder.iterdir() if one.is_dir()]
        self.assertEqual(len(folders), 4, "one folder a collection")
        named: Dict[str, Path] = {}
        for one in folders:
            self.assertEqual(one.parent.resolve(), canvas_folder.resolve(), "no collection climbs out")
            index = frontmatter((one / canvas_vault.INDEX).read_text(encoding="utf-8"))
            named[index["id"]] = one
        self.assertEqual(sorted(named), [".", "..", "../../etc", "bookmarks"])
        # The name a person reads is the collection's own, and the note under it is the document's.
        for collection, folder in named.items():
            with self.subTest(collection=collection):
                note = folder / canvas_vault.note_name("d1")
                self.assertTrue(note.exists(), "the document's note is in the collection's folder")
                self.assertEqual(
                    frontmatter(note.read_text(encoding="utf-8"))["collection"], collection
                )
        # And the canvas's own index is still the canvas's: no collection took its folder to write in.
        self.assertEqual(
            frontmatter((canvas_folder / canvas_vault.INDEX).read_text(encoding="utf-8"))["type"],
            canvas_vault.CANVAS,
        )
