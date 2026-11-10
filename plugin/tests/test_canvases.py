"""A canvas: the run its prompt starts, the chat record that carries it, the scan every write
passes, the data it keeps of its own, and the session — compression's children included — that is
the only one told its tools and guide.

Run: python3 -m unittest plugin.tests.test_canvases -v
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
import sys
import time
import unittest
from contextlib import contextmanager
from types import ModuleType
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import plugin
from plugin import canvases, chats, openui, outbox, page_calls, triage
from plugin.store import connect, db_path
from plugin.tests._helpers import FakeWeb, RouteAdapter, route, temp_hermes_home, wire

PROMPT = "A tip calculator for a restaurant bill, in the app's own colours"
BODY = {
    "input": [{"role": "user", "content": PROMPT}],
    "provider": "anthropic",
    "model": "claude-opus-5-5",
}

# A canvas started with files: the chat id the app mints for it, the two records it saved under that
# chat's session before the create call, and the run body it builds — the prompt's words, then one
# marker line naming each saved file, as `lib/attachment-text.ts` writes them.
START_CHAT = "3f6a1c2e-7b4d-4a91-8e35-0c9d5b2a7e41"
START_FILES = [
    {
        "name": "bill.png",
        "type": "image/png",
        "size": 2048,
        "path": f"attachments/gots-{START_CHAT}/bill.png",
    },
    {
        "name": "menu.pdf",
        "type": "application/pdf",
        "size": 40960,
        "path": f"attachments/gots-{START_CHAT}/menu.pdf",
    },
]
MARKED_CONTENT = "\n".join(
    [
        PROMPT,
        *(
            f'<attachment name="{file["name"]}" type="{file["type"]}" size="{file["size"]}" '
            f'path="{file["path"]}" />'
            for file in START_FILES
        ),
    ]
)
MARKED_BODY = {**BODY, "input": [{"role": "user", "content": MARKED_CONTENT}]}
PAGE_WITHOUT_HEAD = """<!doctype html>
<html lang="en">
  <title>Tip</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <body><h1>Tip</h1></body>
</html>
"""

DOCUMENT = """<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Tip</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
  </head>
  <body><h1>Tip</h1></body>
</html>
"""


def make_canvas(path: Path) -> dict:
    """A canvas made the way the route makes one, over a store in a throwaway home."""
    return canvases.create(path, request_profile="default", bot_id="bot-1", prompt=PROMPT, body=BODY)


def store_of(case: unittest.TestCase) -> Path:
    return db_path(temp_hermes_home(case))


def queued_body(path: Path, item: dict) -> dict:
    """The run request a queued item carries, as the outbox stores it."""
    conn = connect(path)
    try:
        row = conn.execute("SELECT body FROM outbox WHERE id = ?", (item["id"],)).fetchone()
    finally:
        conn.close()
    return json.loads(row[0])


class Agent:
    """What the API server builds: a tool list and the names the model may call, and nothing else."""

    def __init__(self, session_id: str) -> None:
        self.session_id = session_id
        self.tools: list = []
        self.valid_tool_names: set = set()


@contextmanager
def tools_registered():
    """Hermes's tool registry, answering that the plugin's tools are in it."""
    registry = SimpleNamespace(get_entry=lambda name: object())
    module = ModuleType("tools.registry")
    setattr(module, "registry", registry)
    package = ModuleType("tools")
    setattr(package, "registry", module)
    with mock.patch.dict(
        sys.modules, {"tools": package, "tools.registry": module}
    ):
        yield


@contextmanager
def cron_modules(jobs: list):
    """Hermes's cron package, answering ``jobs`` and a run ledger no canvas read may open.

    ``list_executions`` is the trap: a routines read that still walked every job's runs would open
    one SQLite connection per job, per call, so the mock raises if it is reached at all.
    """
    executions = ModuleType("cron.executions")
    runs = mock.Mock(side_effect=AssertionError("a routines read opened the run ledger"))
    setattr(executions, "list_executions", runs)
    entries = ModuleType("cron.jobs")
    setattr(entries, "list_jobs", lambda include_disabled=False: list(jobs))
    package = ModuleType("cron")
    setattr(package, "jobs", entries)
    setattr(package, "executions", executions)
    with mock.patch.dict(
        sys.modules, {"cron": package, "cron.jobs": entries, "cron.executions": executions}
    ):
        yield runs


def sessions_db(home: Path, rows: list) -> None:
    """Hermes's own ``state.db``, with the sessions a lineage walk reads."""
    conn = sqlite3.connect(home / "state.db")
    conn.execute(
        "CREATE TABLE sessions (id TEXT PRIMARY KEY, parent_session_id TEXT, end_reason TEXT,"
        " model_config TEXT, source TEXT)"
    )
    conn.executemany("INSERT INTO sessions VALUES (?, ?, ?, ?, ?)", rows)
    conn.commit()
    conn.close()


class CreationTest(unittest.TestCase):
    def setUp(self) -> None:
        self.path = store_of(self)
        self.canvas = make_canvas(self.path)

    def test_create_queues_the_first_run_in_the_canvas_session(self) -> None:
        found = self.canvas
        self.assertEqual(found["version"], 0)
        self.assertEqual(found["html"], "")
        # The prompt is the first turn of the canvas's own session, so it is built with the app
        # closed — the same queue a triaged thread's first message rides.
        queued = outbox.read(self.path, found["session_id"])
        self.assertEqual(len(queued["items"]), 1)
        item = queued["items"][0]
        self.assertEqual(item["text"], PROMPT)
        # And the run it carries is the app's own request, rebound to the canvas's session.
        self.assertEqual(queued_body(self.path, item)["input"][0]["content"], PROMPT)
        # And the session is the chat's: `gots-<chat id>`, which is what every device labels it as.
        self.assertEqual(found["session_id"], f"gots-{found['chat_id']}")

    def test_the_chat_record_carries_the_canvass_title_edited(self) -> None:
        entry = chats.one(self.path, self.canvas["chat_id"])
        value = entry["value"]
        self.assertEqual(value["title"], self.canvas["title"])
        # Hermes's auto-title never replaces a title the user's own: this one is the canvas's name.
        self.assertIs(value["titleEdited"], True)
        self.assertEqual(value["canvasId"], self.canvas["id"])
        self.assertEqual(value["hermesSessionId"], self.canvas["session_id"])
        self.assertEqual(value["profileId"], "bot-1")
        # The model is pinned at the first send (ADR 0059), as a thread's is.
        self.assertEqual(value["modelChoice"], {"provider": "anthropic", "model": "claude-opus-5-5"})
        self.assertEqual(value["opener"], PROMPT)
        # And it is no plain thread: no list draws it and triage never continues it.
        self.assertFalse(triage.is_plain_thread(value))

    def test_a_prompt_that_never_got_queued_leaves_no_canvas(self) -> None:
        path = store_of(self)
        with mock.patch.object(outbox, "add", side_effect=ValueError("the queue refused it")):
            with self.assertRaises(ValueError):
                make_canvas(path)
        self.assertEqual(canvases.listing(path), [])
        # The chat record is a tombstone rather than a thread nothing posts in.
        self.assertTrue(all(entry.get("deleted") for entry in chats.read(path).values()))

    def test_a_create_on_a_named_chat_keeps_its_files_and_the_prompts_words(self) -> None:
        path = store_of(self)
        found = canvases.create(
            path,
            request_profile="default",
            bot_id="bot-1",
            prompt=PROMPT,
            body=MARKED_BODY,
            chat_id=START_CHAT,
            files=START_FILES,
        )
        # The canvas is on the chat its caller made, with the session that chat names, and the chat
        # record says which canvas it is — the same record a minted one would be.
        self.assertEqual(found["chat_id"], START_CHAT)
        self.assertEqual(found["session_id"], f"gots-{START_CHAT}")
        self.assertEqual(chats.one(path, START_CHAT)["value"]["canvasId"], found["id"])
        # The title is the prompt's own words, cut to the title's length: the markers ride the body
        # and never the name.
        self.assertEqual(found["title"], canvases.title_of(PROMPT))
        self.assertTrue(PROMPT.startswith(found["title"].rstrip("…")))
        self.assertNotIn("<attachment", found["title"])
        # The first turn carries both files, as the records the caller saved them as, and the
        # message is the words alone.
        item = outbox.read(path, found["session_id"])["items"][0]
        self.assertEqual(item["text"], PROMPT)
        self.assertEqual(item["attachments"], START_FILES)
        # And the run body is the caller's untouched: the markers it wrote are all still there.
        self.assertEqual(queued_body(path, item)["input"], MARKED_BODY["input"])
        self.assertEqual(queued_body(path, item)["session_id"], found["session_id"])

    def test_a_create_naming_neither_mints_its_own_chat_and_queues_no_files(self) -> None:
        path = store_of(self)
        found = make_canvas(path)
        self.assertNotEqual(found["chat_id"], START_CHAT)
        self.assertEqual(found["session_id"], f"gots-{found['chat_id']}")
        item = outbox.read(path, found["session_id"])["items"][0]
        self.assertEqual(item["text"], PROMPT)
        self.assertEqual(item["attachments"], [])

    def test_files_that_are_no_list_are_refused_before_anything_is_made(self) -> None:
        path = store_of(self)
        with self.assertRaises(canvases.CanvasError):
            canvases.create(
                path,
                request_profile="default",
                bot_id="bot-1",
                prompt=PROMPT,
                body=MARKED_BODY,
                chat_id=START_CHAT,
                files=START_FILES[0],
            )
        # Refused whole: no canvas, no chat and nothing queued.
        self.assertEqual(canvases.listing(path), [])
        self.assertEqual(chats.read(path), {})

    def test_a_chat_id_that_is_no_string_is_refused_before_the_canvas(self) -> None:
        path = store_of(self)
        with self.assertRaises(canvases.CanvasError):
            canvases.create(
                path,
                request_profile="default",
                bot_id="bot-1",
                prompt=PROMPT,
                body=MARKED_BODY,
                chat_id=12345,
                files=START_FILES,
            )
        # The chat the canvas opens on is a name the caller made: nothing is made with a number in it.
        self.assertEqual(canvases.listing(path), [])
        self.assertEqual(chats.read(path), {})

    def test_a_chat_id_that_is_blank_is_refused_before_the_canvas(self) -> None:
        path = store_of(self)
        for blank in ("", "   "):
            with self.subTest(blank=blank):
                with self.assertRaises(canvases.CanvasError):
                    canvases.create(
                        path,
                        request_profile="default",
                        bot_id="bot-1",
                        prompt=PROMPT,
                        body=MARKED_BODY,
                        chat_id=blank,
                        files=START_FILES,
                    )
        self.assertEqual(canvases.listing(path), [])
        self.assertEqual(chats.read(path), {})

    def test_a_chat_id_no_upload_could_save_under_is_refused_before_the_canvas(self) -> None:
        path = store_of(self)
        # A canvas's files live under `gots-<chat id>`, and the attachments route refuses a session
        # id outside its own shape: a chat id that leaves that room is a canvas whose files could
        # never be saved for it, so the start is refused rather than made on a chat of its own.
        for named in (
            "a" * 130,
            "3f6a 1c2e",
            "3f6a/1c2e",
            "..",
        ):
            with self.subTest(named=named[:16]):
                with self.assertRaises(canvases.CanvasError):
                    canvases.create(
                        path,
                        request_profile="default",
                        bot_id="bot-1",
                        prompt=PROMPT,
                        body=MARKED_BODY,
                        chat_id=named,
                        files=START_FILES,
                    )
        self.assertEqual(canvases.listing(path), [])
        self.assertEqual(chats.read(path), {})

    def test_a_chat_id_a_chat_already_holds_is_refused_and_left_alone(self) -> None:
        path = store_of(self)
        # A thread somebody is reading: its own title, the message that began it and the model it was
        # pinned to at the first send.
        held, _ = triage.open_thread(
            path,
            "bot-1",
            {"provider": "anthropic", "model": "claude-opus-5-5"},
            opener="Where's the receipt?",
            title="Receipts",
        )
        before = chats.one(path, held)
        with self.assertRaises(canvases.CanvasError) as refused:
            canvases.create(
                path,
                request_profile="default",
                bot_id="bot-1",
                prompt=PROMPT,
                body=BODY,
                chat_id=held,
            )
        self.assertIn("a chat of its own", str(refused.exception))
        # The thread is untouched: a create on it would have retitled it, dropped its pinned model
        # and marked it a canvas's chat, and none of those is a canvas's to do.
        self.assertEqual(chats.one(path, held), before)
        value = chats.one(path, held)["value"]
        self.assertEqual(value["title"], "Receipts")
        self.assertEqual(value["opener"], "Where's the receipt?")
        self.assertEqual(value["modelChoice"], {"provider": "anthropic", "model": "claude-opus-5-5"})
        self.assertNotIn("canvasId", value)
        self.assertEqual(canvases.listing(path), [])

        # A canvas's own chat is a chat too: a second canvas on it is refused the same way, and the
        # first keeps the one chat it was made on.
        made = make_canvas(path)
        with self.assertRaises(canvases.CanvasError):
            canvases.create(
                path,
                request_profile="default",
                bot_id="bot-1",
                prompt=PROMPT,
                body=BODY,
                chat_id=made["chat_id"],
                files=START_FILES,
            )
        self.assertEqual([row["id"] for row in canvases.listing(path)], [made["id"]])
        self.assertEqual(chats.one(path, made["chat_id"])["value"]["canvasId"], made["id"])

    def test_more_files_than_a_start_carries_is_refused(self) -> None:
        path = store_of(self)
        # The queue keeps at most 20 files per item and drops the rest without a word, so a start
        # asking for more is refused rather than answered with a turn missing some of them.
        many = [{**START_FILES[0], "name": f"photo-{index}.png"} for index in range(21)]
        with self.assertRaises(canvases.CanvasError):
            canvases.create(
                path,
                request_profile="default",
                bot_id="bot-1",
                prompt=PROMPT,
                body=MARKED_BODY,
                chat_id=START_CHAT,
                files=many,
            )
        self.assertEqual(canvases.listing(path), [])

    def test_files_with_no_chat_are_refused(self) -> None:
        path = store_of(self)
        # A start's files live under the session its chat names; a create that names no chat has no
        # session to have saved them under, so the files and the chat go together.
        with self.assertRaises(canvases.CanvasError):
            canvases.create(
                path,
                request_profile="default",
                bot_id="bot-1",
                prompt=PROMPT,
                body=MARKED_BODY,
                files=START_FILES,
            )
        self.assertEqual(canvases.listing(path), [])
        self.assertEqual(chats.read(path), {})

    def test_a_files_list_holding_what_is_no_file_is_refused_before_anything_is_made(self) -> None:
        path = store_of(self)
        # The queue keeps the objects in a list and drops the rest without a word, so a start holding
        # anything else is refused rather than answered with a turn missing one of its files.
        with self.assertRaises(canvases.CanvasError) as refused:
            canvases.create(
                path,
                request_profile="default",
                bot_id="bot-1",
                prompt=PROMPT,
                body=MARKED_BODY,
                chat_id=START_CHAT,
                files=[START_FILES[0], "two.png"],
            )
        self.assertIn("object", str(refused.exception))
        self.assertEqual(canvases.listing(path), [])
        self.assertEqual(chats.read(path), {})

    def test_no_files_is_the_same_start_as_none(self) -> None:
        path = store_of(self)
        # An empty list is no files, not files without a chat: a caller that staged everything and
        # then took every tile off sends the start a caller that staged nothing does.
        found = canvases.create(
            path,
            request_profile="default",
            bot_id="bot-1",
            prompt=PROMPT,
            body=BODY,
            files=[],
        )
        self.assertEqual(found["session_id"], f"gots-{found['chat_id']}")
        item = outbox.read(path, found["session_id"])["items"][0]
        self.assertEqual(item["attachments"], [])

    def test_the_start_file_cap_is_the_queues_own(self) -> None:
        path = store_of(self)
        # One number, in the queue that keeps it: the guard here and `clean_files`' trim read the
        # same constant, so a canvas can never hand over more than a queued turn keeps.
        trimmed = outbox.clean_files(
            [{**START_FILES[0], "name": f"p{index}.png"} for index in range(outbox.MAX_FILES + 5)]
        )
        self.assertEqual(len(trimmed), outbox.MAX_FILES)
        files = [{**START_FILES[0], "name": f"photo-{index}.png"} for index in range(outbox.MAX_FILES)]
        found = canvases.create(
            path,
            request_profile="default",
            bot_id="bot-1",
            prompt=PROMPT,
            body=BODY,
            chat_id=START_CHAT,
            files=files,
        )
        queued = outbox.read(path, found["session_id"])["items"][0]["attachments"]
        self.assertEqual(len(queued), outbox.MAX_FILES)
        with self.assertRaises(canvases.CanvasError) as refused:
            canvases.create(
                path,
                request_profile="default",
                bot_id="bot-1",
                prompt=PROMPT,
                body=BODY,
                chat_id="one-more-chat",
                files=files + [files[0]],
            )
        self.assertIn(str(outbox.MAX_FILES), str(refused.exception))

    def test_a_rename_is_the_canvas_and_its_chat(self) -> None:
        found = canvases.write(self.path, self.canvas["id"], DOCUMENT, title="Tip splitter")
        self.assertEqual(found["title"], "Tip splitter")
        self.assertEqual(chats.one(self.path, self.canvas["chat_id"])["value"]["title"], "Tip splitter")
        self.assertIs(chats.one(self.path, self.canvas["chat_id"])["value"]["titleEdited"], True)


class WriteTest(unittest.TestCase):
    def setUp(self) -> None:
        self.path = store_of(self)
        self.canvas = make_canvas(self.path)

    def test_a_write_is_the_next_version(self) -> None:
        first = canvases.write(self.path, self.canvas["id"], DOCUMENT, tools=["tasks.todo_list"])
        self.assertEqual((first["version"], first["html"]), (1, DOCUMENT))
        self.assertEqual(first["tools"], ["tasks.todo_list"])
        second = canvases.write(self.path, self.canvas["id"], DOCUMENT.replace("Tip", "Split"))
        self.assertEqual(second["version"], 2)
        self.assertEqual(canvases.listing(self.path)[0]["version"], 2)

    def test_a_write_answers_with_the_guides_warnings(self) -> None:
        # A warning is advice beside the answer and never a gate: the version is stored, and the bot is
        # told what the guide would say before the user ever sees the page. Nothing here judges a
        # colour: a user's named palette is the design, and a rule that argued with it would be the
        # guide overruling the thing it puts first.
        handlerless = DOCUMENT.replace("<h1>Tip</h1>", "<form><input><button>Split</button></form>")
        wider = DOCUMENT.replace("<h1>Tip</h1>", '<div style="width:600px">Tip</div>')
        named_palette = DOCUMENT.replace(
            "<h1>Tip</h1>", '<h1 style="color:#000;background:#f4f1ea">Tip</h1>'
        )
        # The guide's own two answers are clean: a button with a click handler, and a breakpoint in a
        # <style> block, which is where the guide tells a bot to breathe from 768px.
        clean = DOCUMENT.replace(
            "<h1>Tip</h1>",
            "<style>@media (min-width: 768px){h1{width:720px}}</style>"
            "<form><button id=\"go\">Split</button></form>"
            '<script>document.getElementById("go").addEventListener("click", '
            "function () {})</script>",
        )
        cases = (
            ("a form with nothing handling it", handlerless, "submit"),
            ("a width past the phone", wider, "width"),
            ("a palette the user named", named_palette, None),
            ("a page that keeps the rules", clean, None),
        )
        with mock.patch.object(canvases, "_session_canvas", return_value=self.canvas["id"]):
            for name, html, word in cases:
                with self.subTest(name):
                    answer = json.loads(
                        canvases.handle_write({"html": html}, session_id=self.canvas["session_id"])
                    )
                    self.assertIs(answer["written"], True)
                    if word is None:
                        self.assertEqual(answer["warnings"], [])
                    else:
                        self.assertEqual(len(answer["warnings"]), 1, answer["warnings"])
                        self.assertIn(word, answer["warnings"][0])
            # The version landed either way: advice never refuses a write.
            self.assertEqual(canvases.current(self.path, self.canvas["id"])["html"], clean)
            # An edit answers the same field, over the page it has just written.
            edited = json.loads(
                canvases.handle_edit(
                    {
                        "edits": [
                            {
                                "find": 'id="go"',
                                "replace": 'id="go" style="width:600px"',
                            }
                        ]
                    },
                    session_id=self.canvas["session_id"],
                )
            )
            self.assertIs(edited["edited"], True)
            self.assertEqual(len(edited["warnings"]), 1, edited["warnings"])
            self.assertIn("width", edited["warnings"][0])

    def test_only_the_newest_twenty_versions_are_kept(self) -> None:
        for _ in range(canvases.KEEP_VERSIONS + 2):
            canvases.write(self.path, self.canvas["id"], DOCUMENT)
        conn = connect(self.path)
        try:
            kept = [
                row[0]
                for row in conn.execute(
                    "SELECT version FROM canvas_versions WHERE canvas_id = ? ORDER BY version",
                    (self.canvas["id"],),
                )
            ]
        finally:
            conn.close()
        self.assertEqual(len(kept), canvases.KEEP_VERSIONS)
        self.assertEqual(kept[-1], canvases.KEEP_VERSIONS + 2)

    def test_a_write_can_name_the_picture_its_tile_draws(self) -> None:
        picture = "data:image/png;base64," + "A" * 32
        written = canvases.write(self.path, self.canvas["id"], DOCUMENT, image=picture)
        self.assertEqual(written["image"], picture)
        # It is the record's rather than the version's, so the list carries it and a later write that
        # names none leaves it where it was.
        self.assertEqual(canvases.listing(self.path)[0]["image"], picture)
        canvases.write(self.path, self.canvas["id"], DOCUMENT.replace("Tip", "Split"))
        self.assertEqual(canvases.record(self.path, self.canvas["id"])["image"], picture)

    def test_a_picture_that_is_no_inline_image_is_refused_whole(self) -> None:
        for named, refused in (
            ("https://example.com/shot.png", "data URL"),
            ("data:text/html;base64,PGI+", "data URL"),
            ("data:image/png;base64," + "A" * (canvases.IMAGE_CHARS + 1), "192 KB"),
        ):
            with self.subTest(named=named[:32]):
                with self.assertRaises(canvases.CanvasError) as why:
                    canvases.write(self.path, self.canvas["id"], DOCUMENT, image=named)
                self.assertIn(refused, str(why.exception))
        # Refused whole: the canvas keeps the version it had, and no picture.
        self.assertEqual(canvases.record(self.path, self.canvas["id"])["version"], 0)
        self.assertIsNone(canvases.record(self.path, self.canvas["id"])["image"])

    def test_an_empty_picture_goes_back_to_the_canvas_mark(self) -> None:
        picture = "data:image/png;base64," + "A" * 32
        canvases.write(self.path, self.canvas["id"], DOCUMENT, image=picture)
        canvases.update(self.path, self.canvas["id"], {"image": ""})
        self.assertEqual(canvases.record(self.path, self.canvas["id"])["image"], "")

    def test_a_write_past_256_kb_is_refused_naming_the_cap(self) -> None:
        huge = DOCUMENT.replace("<h1>Tip</h1>", "<p>" + "x" * (canvases.MAX_BYTES + 1) + "</p>")
        with self.assertRaises(canvases.CanvasError) as refused:
            canvases.write(self.path, self.canvas["id"], huge)
        self.assertIn("256 KB", str(refused.exception))
        # The size it names is rounded up: a write a byte over is not "256 KB".
        self.assertIn("257 KB", str(refused.exception))
        # Refused whole: the canvas keeps the version it had.
        self.assertEqual(canvases.record(self.path, self.canvas["id"])["version"], 0)

    def test_a_write_holding_a_key_pattern_is_refused_naming_it(self) -> None:
        for secret, named in (
            ("sk-ant-api03-" + "a1b2c3d4e5f6g7h8i9j0", "Anthropic key"),
            ("ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8", "GitHub token"),
            ("AKIA" + "ABCDEFGHIJKLMNOP", "AWS access key"),
            ("-----BEGIN RSA PRIVATE KEY-----", "private key"),
            ("sk_live_" + "a1b2c3d4e5f6g7h8i9j0", "Stripe key"),
            ("ya29." + "a0AfH6SMBx1y2z3w4v5u6t7s8r9q", "Google OAuth token"),
            ("Authorization: Bearer " + "a1b2c3d4e5f6g7h8i9j0k1l2", "bearer token"),
            ("postgres://admin:" + "hunter2hunter2" + "@db.example.com/app", "credential in a URL"),
            ("const secretKey = \"" + "9f8e7d6c5b4a39281706" + "\"", "secret assignment"),
            ("aws_secret_access_key = \"" + "wJalrXUtnFEMIK7MDENGbPxRfiCY" + "\"", "secret assignment"),
        ):
            with self.subTest(named=named):
                with self.assertRaises(canvases.CanvasError) as refused:
                    canvases.write(self.path, self.canvas["id"], DOCUMENT.replace("<h1>", secret + "<h1>"))
                self.assertIn(named, str(refused.exception))
        self.assertEqual(canvases.record(self.path, self.canvas["id"])["version"], 0)

    def test_a_write_that_is_no_whole_document_is_refused_naming_what_it_lacks(self) -> None:
        with self.assertRaises(canvases.CanvasError) as refused:
            canvases.write(self.path, self.canvas["id"], "<html><body>hi</body></html>")
        for words in ("doctype", "lang", "<head>", "title", "viewport"):
            self.assertIn(words, str(refused.exception))

    def test_a_head_named_only_in_a_comment_is_no_head(self) -> None:
        # A comment is not markup: the app finds the page's head the same way this does, so a
        # document whose only `<head>` is inside a comment is one nothing can put a policy into.
        commented = PAGE_WITHOUT_HEAD.replace(
            "<html lang=\"en\">", "<html lang=\"en\"><!-- the <head> goes here -->"
        )
        with self.assertRaises(canvases.CanvasError) as refused:
            canvases.write(self.path, self.canvas["id"], commented)
        self.assertIn("<head>", str(refused.exception))
        # A comment that merely mentions it is no reason to refuse a document that has one.
        mentioned = DOCUMENT.replace(
            "<html lang=\"en\">", "<html lang=\"en\"><!-- a note: <head> follows -->"
        )
        self.assertEqual(canvases.write(self.path, self.canvas["id"], mentioned)["version"], 1)

    def test_a_write_that_loads_from_outside_itself_is_refused(self) -> None:
        for hole in (
            '<script src="https://cdn.example.com/x.js"></script>',
            '<link rel="stylesheet" href="https://cdn.example.com/x.css">',
            '<img src="//example.com/x.png">',
            '<iframe src="https://example.com"></iframe>',
            '<meta http-equiv="refresh" content="0;url=https://example.com">',
            '<base href="https://example.com/">',
            '<div style="background: url(https://example.com/x.png)"></div>',
            '<img src="http://example.com/x.png">',
            '<img srcset="https://example.com/a.png 1x, http://example.com/b.png 2x">',
            '<picture><source srcset="//example.com/x.webp"></picture>',
            '<video poster="https://example.com/x.png"></video>',
            '<script src="https://cdn.example.com/x.js" data-alt="<img src=https://x>"></script>',
            '<form action="https://example.com/post"></form>',
        ):
            with self.subTest(hole=hole):
                with self.assertRaises(canvases.CanvasError):
                    canvases.write(self.path, self.canvas["id"], DOCUMENT.replace("<body>", hole + "<body>"))
        self.assertEqual(canvases.record(self.path, self.canvas["id"])["version"], 0)

    def test_a_remote_image_over_https_is_accepted(self) -> None:
        # ADR 0134: the frame's policy lets an https image in, so the scan does too — and only that.
        for image in (
            '<img src="https://example.com/x.png" alt="x">',
            "<img alt='x' src='https://example.com/x.png'>",
            '<img src="https://example.com/a.png" srcset="https://example.com/a.png 1x, https://example.com/b.png 2x" alt="x">',
            '<picture><source srcset="https://example.com/x.webp" type="image/webp"><img src="https://example.com/x.png" alt="x"></picture>',
        ):
            with self.subTest(image=image):
                html = DOCUMENT.replace("<body>", "<body>" + image)
                canvases.scan(html)

    def test_the_prompt_says_https_images_and_nothing_else_load(self) -> None:
        prompt = (Path(canvases.__file__).parent / "canvas" / "prompt.txt").read_text()
        self.assertIn("Remote images over https are allowed", prompt)
        self.assertIn("nothing else loads from outside", prompt)

    def test_a_link_the_reader_could_tap_is_not_a_resource(self) -> None:
        html = DOCUMENT.replace("<body>", '<body><a href="https://example.com">Read more</a>')
        self.assertEqual(canvases.write(self.path, self.canvas["id"], html)["version"], 1)

    def test_a_version_cannot_declare_the_canvases_own_data_as_a_tool(self) -> None:
        # The call route answers `data.put` and `data.remove` as the page's own write before consent
        # is consulted, so a version that declared one would make a tool the user denied write.
        canvas_id = self.canvas["id"]
        for name in ("data.put", "data.remove"):
            with self.subTest(name=name):
                with self.assertRaises(canvases.CanvasError) as refused:
                    canvases.write(self.path, canvas_id, DOCUMENT, tools=[name])
                self.assertEqual(refused.exception.status, 400)
                self.assertIn("canvas.data.*", str(refused.exception))
                self.assertIn(name, str(refused.exception))
        # Refused whole: a list holding one is no declaration at all.
        self.assertEqual(canvases.record(self.path, canvas_id)["version"], 0)

        # A store an earlier build wrote one into can't be granted it either: the row is refused
        # where a grant is written, so the answer is never asked about a name that isn't a tool.
        conn = connect(self.path)
        try:
            conn.execute(
                "INSERT INTO canvas_versions (canvas_id, version, html, tools, at) VALUES (?, 1, ?, ?, 1)",
                (canvas_id, DOCUMENT, json.dumps(["data.put"])),
            )
            conn.execute("UPDATE canvases SET version = 1 WHERE id = ?", (canvas_id,))
        finally:
            conn.close()
        with self.assertRaises(canvases.CanvasError) as refused:
            canvases.grant(self.path, canvas_id, "data.put", True)
        self.assertEqual(refused.exception.status, 400)
        self.assertIn("canvas.data.*", str(refused.exception))

    def test_a_name_with_whitespace_or_a_control_character_is_refused_where_it_is_written(self) -> None:
        # The bridge refuses a name with whitespace, so one stored here is a row nothing can call:
        # `mcp_call.split` is the one rule, and a declaration holding one is refused whole.
        for tools, named in (
            (["files. search"], "files. search"),
            ([" files.search"], " files.search"),
            (["files.search\n"], "files.search\n"),
            (["files.search\x00"], "files.search\x00"),
        ):
            with self.subTest(named=named):
                with self.assertRaises(canvases.CanvasError) as refused:
                    canvases.write(self.path, self.canvas["id"], DOCUMENT, tools=tools)
                self.assertEqual(refused.exception.status, 400)
                self.assertIn("<server>.<tool>", str(refused.exception))
                self.assertIn(repr(named), str(refused.exception))
        self.assertEqual(canvases.record(self.path, self.canvas["id"])["version"], 0)

    def test_a_declaration_is_at_most_fifty_tools_and_sixty_four_characters_a_name(self) -> None:
        # Every declared tool is an option row and a consent dialog: twenty thousand of them is a
        # canvas answer nothing can draw, so the cap is the whole declaration or nothing.
        canvas_id = self.canvas["id"]
        many = [f"srv.tool{index}" for index in range(canvases.TOOLS_MAX)]
        with self.assertRaises(canvases.CanvasError) as refused:
            canvases.write(self.path, canvas_id, DOCUMENT, tools=many + ["srv.one.more"])
        self.assertEqual(refused.exception.status, 400)
        self.assertIn(str(canvases.TOOLS_MAX), str(refused.exception))
        self.assertEqual(canvases.record(self.path, canvas_id)["version"], 0)

        long_name = "srv." + "t" * canvases.TOOL_NAME_CHARS
        with self.assertRaises(canvases.CanvasError) as refused:
            canvases.write(self.path, canvas_id, DOCUMENT, tools=[long_name])
        self.assertEqual(refused.exception.status, 400)
        self.assertIn(str(canvases.TOOL_NAME_CHARS), str(refused.exception))
        self.assertEqual(canvases.record(self.path, canvas_id)["version"], 0)

        # The cap is a bound, not a rule: the fiftieth is a row a sheet can draw.
        written = canvases.write(self.path, canvas_id, DOCUMENT, tools=many)
        self.assertEqual(len(written["tools"]), canvases.TOOLS_MAX)


class SessionTest(unittest.TestCase):
    """A canvas's page tools reach only its session, while the list and the two data tools reach
    every one — a compacted session included."""

    def setUp(self) -> None:
        self.home = temp_hermes_home(self)
        self.path = db_path(self.home)
        self.canvas = make_canvas(self.path)
        self.session = self.canvas["session_id"]
        # A plain thread of the same bot, which must be told and given nothing of the canvas's.
        self.plain = triage.open_thread(self.path, "bot-1")[1]
        sessions_db(
            self.home,
            [
                # The chat's own session ended in compression, which is what makes its child a
                # continuation of it rather than another conversation.
                (self.session, None, "compression", None, "api"),
                # Compression moved the chat on: the run is keyed on the child, the chat is the root.
                (self.session + "-c1", self.session, None, "{}", "api"),
                (self.plain, None, None, None, "api"),
                # A subagent the canvas's session made is another conversation, not the canvas's.
                (self.session + "-agent", self.session + "-c1", None, '{"_delegate_from": "x"}', "tool"),
            ],
        )

    def test_the_tools_and_the_section_reach_only_a_canvas_session_through_a_compression_child_too(self) -> None:
        # The canvas is resolved from the run's own session, through the lineage walk.
        self.assertEqual(canvases.canvas_of_session(self.path, self.home, self.session), self.canvas["id"])
        self.assertEqual(
            canvases.canvas_of_session(self.path, self.home, self.session + "-c1"), self.canvas["id"]
        )
        self.assertIsNone(canvases.canvas_of_session(self.path, self.home, self.plain))
        self.assertIsNone(canvases.canvas_of_session(self.path, self.home, self.session + "-agent"))

        # A real agent and a real registry entry, so the tools that reach it are the ones counted.
        adapter = SimpleNamespace(
            _create_agent=lambda *args, **kwargs: Agent(kwargs.get("session_id"))
        )
        with tools_registered():
            self.assertTrue(canvases.wire(adapter))
            canvas_agent = adapter._create_agent(session_id=self.session + "-c1")
            plain_agent = adapter._create_agent(session_id=self.plain)
        self.assertEqual(
            sorted(canvas_agent.valid_tool_names),
            [
                canvases.TOOL_DATA_READ,
                canvases.TOOL_DATA_WRITE,
                canvases.TOOL_EDIT,
                canvases.TOOL_LIST,
                canvases.TOOL_READ,
                canvases.TOOL_WRITE,
            ],
        )
        # A session with no canvas of its own is exactly who needs to look one up, and one that
        # isn't a canvas's reads or writes a canvas's data by naming it.
        self.assertEqual(
            plain_agent.valid_tool_names,
            {canvases.TOOL_LIST, canvases.TOOL_DATA_READ, canvases.TOOL_DATA_WRITE},
        )

        # The guide is the canvas's, and the component library's is withheld from that session.
        self.assertEqual(openui.canvas_content({"session_id": self.session + "-c1"}), openui.CANVAS_TEXT)
        self.assertEqual(openui.content({"session_id": self.session + "-c1"}), "")
        self.assertEqual(openui.canvas_content({"session_id": self.plain}), "")
        self.assertEqual(openui.content({"session_id": self.plain}), openui.TEXT)

    def test_a_call_is_found_from_either_id_hermes_gives_it(self) -> None:
        # A tool and a hook are handed a task id that is the run's own, which is not always the
        # session's: the canvas is found from whichever of the two names it.
        with mock.patch.object(canvases, "_session_canvas", side_effect=lambda s: self.canvas["id"] if s == self.session else None):
            self.assertEqual(canvases._canvas_of_call("task-abc", self.session), self.canvas["id"])
            self.assertEqual(canvases._canvas_of_call(self.session, None), self.canvas["id"])
            self.assertIsNone(canvases._canvas_of_call("task-abc", "not-a-canvas"))

    def test_a_canvas_session_cannot_ship_or_file_anything(self) -> None:
        with mock.patch.object(canvases, "_session_canvas", return_value=self.canvas["id"]):
            for tool in ("pull_request", "library_add", "afk_gate"):
                self.assertEqual(canvases.before_tool(tool_name=tool, session_id=self.session)["action"], "block")
            self.assertIsNone(canvases.before_tool(tool_name="read_file", session_id=self.session))
        with mock.patch.object(canvases, "_session_canvas", return_value=None):
            self.assertIsNone(canvases.before_tool(tool_name="pull_request", session_id=self.plain))

    def test_a_canvas_session_writes_and_reads_its_own_page(self) -> None:
        with mock.patch.object(canvases, "_session_canvas", return_value=self.canvas["id"]):
            written = json.loads(
                canvases.handle_write({"html": DOCUMENT, "title": "Tip"}, session_id=self.session)
            )
            self.assertEqual((written["version"], written["title"]), (1, "Tip"))
            read = json.loads(canvases.handle_read({}, session_id=self.session))
            self.assertEqual((read["html"], read["version"]), (DOCUMENT, 1))
            refused = json.loads(canvases.handle_write({"html": "<p>no</p>"}, session_id=self.session))
            self.assertIn("error", refused)
        # Outside a canvas's session none of the three answers anything of a canvas.
        with mock.patch.object(canvases, "_session_canvas", return_value=None):
            self.assertIn("error", json.loads(canvases.handle_write({"html": DOCUMENT}, session_id="s")))
            self.assertIn(
                "error",
                json.loads(
                    canvases.handle_edit(
                        {"edits": [{"find": "<h1>Tip</h1>", "replace": "<h1>Split</h1>"}]},
                        session_id="s",
                    )
                ),
            )
            self.assertIn("error", json.loads(canvases.handle_read({}, session_id="s")))

    def test_a_canvas_session_keeps_data_of_its_own(self) -> None:
        with mock.patch.object(canvases, "_session_canvas", return_value=self.canvas["id"]):
            written = json.loads(
                canvases.handle_data_write(
                    {"collection": "notes", "id": "a", "doc": {"text": "one"}},
                    session_id=self.session,
                )
            )
            self.assertEqual(
                (written["collection"], written["id"], written["doc"]),
                ("notes", "a", {"text": "one"}),
            )
            every = json.loads(canvases.handle_data_read({}, session_id=self.session))
            self.assertEqual([row["doc"] for row in every["documents"]], [{"text": "one"}])
            one = json.loads(
                canvases.handle_data_read(
                    {"collection": "notes", "id": "a"}, session_id=self.session
                )
            )
            self.assertEqual(one["document"]["doc"], {"text": "one"})
            absent = json.loads(
                canvases.handle_data_read(
                    {"collection": "notes", "id": "nope"}, session_id=self.session
                )
            )
            self.assertEqual(absent, {"document": None})
            # A document is one of one collection: an id on its own names nothing to read.
            unnamed = json.loads(
                canvases.handle_data_read({"id": "a"}, session_id=self.session)
            )
            self.assertIn("collection", unnamed["error"])
            gone = json.loads(
                canvases.handle_data_write(
                    {"collection": "notes", "id": "a", "remove": True}, session_id=self.session
                )
            )
            self.assertEqual(gone, {"collection": "notes", "id": "a", "removed": True})
            # A call that says neither what to store nor to remove says what is missing.
            neither = json.loads(
                canvases.handle_data_write(
                    {"collection": "notes", "id": "a"}, session_id=self.session
                )
            )
            self.assertIn("doc", neither["error"])
        # Outside a canvas's session both data tools have to name the canvas — no canvas is
        # nobody's own — and this session naming another canvas's is refused: a canvas's own
        # session reaches only its own data.
        elsewhere = make_canvas(self.path)
        unnamed = json.loads(canvases.handle_data_read({}, session_id=self.plain))
        self.assertIn("error", unnamed)
        self.assertIn(canvases.TOOL_LIST, unnamed["error"])
        unnamed = json.loads(
            canvases.handle_data_write(
                {"collection": "n", "id": "i", "doc": 1}, session_id=self.plain
            )
        )
        self.assertIn("error", unnamed)
        self.assertIn(canvases.TOOL_LIST, unnamed["error"])
        another = json.loads(
            canvases.handle_data_read({"canvas": elsewhere["id"]}, session_id=self.session)
        )
        self.assertIn("error", another)
        for canvas_id in (self.canvas["id"], elsewhere["id"]):
            self.assertIn(canvas_id, another["error"])


class ListTest(unittest.TestCase):
    """A bot's canvases, named by any session: id, title, whether archived, and the clock.

    A caller who knows no title is who the list is for, so it answers every canvas the bot has —
    archived ones included and flagged, newest first — and never the picture a tile draws, which is
    up to 192 KB a row.
    """

    def setUp(self) -> None:
        self.home = temp_hermes_home(self)
        self.path = db_path(self.home)
        # An archived canvas, whose tile carries a picture, then one made after it: the list is
        # newest first and the picture is no part of a name.
        self.archived = canvases.create(
            self.path, request_profile="default", bot_id="bot-1", prompt="A run log", body=BODY
        )
        canvases.update(self.path, self.archived["id"], {"archived": True})
        canvases.write(
            self.path,
            self.archived["id"],
            DOCUMENT,
            image="data:image/png;base64," + "A" * 32,
        )
        time.sleep(0.005)
        self.newest = canvases.create(
            self.path, request_profile="default", bot_id="bot-1", prompt=PROMPT, body=BODY
        )
        self.plain = triage.open_thread(self.path, "bot-1")[1]

    def test_canvas_list_names_every_canvas_without_its_picture(self) -> None:
        # A plain session and a canvas's own session are answered the same list.
        for session_id in (self.plain, self.archived["session_id"]):
            with self.subTest(session=session_id):
                listed = json.loads(canvases.handle_list({}, session_id=session_id))
                self.assertEqual(list(listed), ["canvases"])
                rows = listed["canvases"]
                self.assertEqual(
                    [row["id"] for row in rows], [self.newest["id"], self.archived["id"]]
                )
                self.assertEqual([row["archived"] for row in rows], [False, True])
                self.assertEqual(
                    [row["title"] for row in rows],
                    [canvases.title_of(PROMPT), "A run log"],
                )
                for row in rows:
                    self.assertEqual(list(row), ["id", "title", "archived", "at"])
        # It takes no arguments: the caller who knows no name asks it as it is.
        self.assertEqual(canvases.LIST_SCHEMA["parameters"], {"type": "object", "properties": {}})
        # The clock is the page's: a data write never moves it, so the description says so rather
        # than promising that `at` moves with everything a canvas holds.
        self.assertIn("when its page last changed", canvases.LIST_SCHEMA["description"])
        # A caller that sends nothing at all is answered the same list.
        self.assertEqual(
            json.loads(canvases.handle_list(None, session_id=self.plain))["canvases"][0]["id"],
            self.newest["id"],
        )

    def test_two_canvases_written_in_the_same_millisecond_are_newest_first(self) -> None:
        # The clock is milliseconds, so two writes can share one. The rowid breaks the tie: a list
        # that fell back to insertion order would put the older canvas first and the newest last.
        conn = connect(self.path)
        try:
            conn.execute("UPDATE canvases SET at = ?", (int(time.time() * 1000),))
        finally:
            conn.close()
        newest = [self.newest["id"], self.archived["id"]]
        self.assertEqual(
            [row["id"] for row in json.loads(canvases.handle_list({}, session_id=self.plain))["canvases"]],
            newest,
        )
        self.assertEqual([found["id"] for found in canvases.names(self.path)], newest)
        self.assertEqual([found["id"] for found in canvases.listing(self.path)], newest)

    def test_the_list_reads_the_store_without_walking_a_session(self) -> None:
        # The store's path is all a list needs: no canvas of its own is exactly the session it is
        # asked from, so the walk a canvas's tools take to find one is a lineage and a row read
        # for nothing — on a tool every session carries.
        with mock.patch.object(
            canvases,
            "canvas_of_session",
            side_effect=AssertionError("the list walked a session's lineage"),
        ):
            listed = json.loads(canvases.handle_list({}, session_id=self.plain))
        self.assertEqual(
            [row["id"] for row in listed["canvases"]], [self.newest["id"], self.archived["id"]]
        )


class UnreadableStoreTest(unittest.TestCase):
    """A store a tool can't read — corrupt, locked or half-migrated — is an answer, not a raise.

    Every canvas tool answers ``{"error": ...}`` by contract: a ``sqlite3.Error`` let out of a
    handler fails the tool call instead, so the model is told nothing and the turn carries the
    failure as its own. A store another writer holds (``BEGIN EXCLUSIVE``), a file that is no
    database and a migration step that fails all arrive here the same way.
    """

    def setUp(self) -> None:
        self.home = temp_hermes_home(self)
        self.path = db_path(self.home)
        self.canvas = make_canvas(self.path)
        self.plain = triage.open_thread(self.path, "bot-1")[1]
        # No database at all: `connect` refuses the file at its first read, which is where a locked
        # store's timeout and a failing migration step land too.
        self.path.write_bytes(b"not a sqlite store\n" * 32)

    def test_the_list_and_a_named_read_answer_an_unreadable_store_with_an_error(self) -> None:
        for tool, handler, args in (
            (canvases.TOOL_LIST, canvases.handle_list, {}),
            (
                canvases.TOOL_DATA_READ,
                canvases.handle_data_read,
                {"canvas": self.canvas["id"]},
            ),
        ):
            with self.subTest(tool=tool):
                answered = json.loads(handler(args, session_id=self.plain))
                self.assertEqual(list(answered), ["error"])
                self.assertIn(tool, answered["error"])

    def test_a_canvas_sessions_own_reads_answer_an_unreadable_store_with_an_error(self) -> None:
        # A canvas's session names no canvas and still reads the store, so the refusal is the one
        # `run` raises — caught where the answer is written, for every canvas tool alike.
        with mock.patch.object(canvases, "canvas_of_session", return_value=self.canvas["id"]):
            for tool, handler, args in (
                (canvases.TOOL_READ, canvases.handle_read, {}),
                (
                    canvases.TOOL_DATA_WRITE,
                    canvases.handle_data_write,
                    {"collection": "notes", "id": "a", "doc": 1},
                ),
            ):
                with self.subTest(tool=tool):
                    answered = json.loads(handler(args, session_id=self.canvas["session_id"]))
                    self.assertEqual(list(answered), ["error"])
                    self.assertIn(tool, answered["error"])


class EditTest(unittest.TestCase):
    """A small change is find and replace, and undo walks the pointer back a version."""

    def setUp(self) -> None:
        self.path = store_of(self)
        self.canvas = make_canvas(self.path)

    def stored_versions(self) -> list:
        conn = connect(self.path)
        try:
            return [
                row[0]
                for row in conn.execute(
                    "SELECT version FROM canvas_versions WHERE canvas_id = ? ORDER BY version",
                    (self.canvas["id"],),
                )
            ]
        finally:
            conn.close()

    def test_edit_versions_and_undo_restores(self) -> None:
        first = canvases.write(self.path, self.canvas["id"], DOCUMENT, tools=["tasks.todo_list"])
        second = canvases.write(
            self.path,
            self.canvas["id"],
            DOCUMENT.replace("<h1>Tip</h1>", "<h1>Split</h1>"),
            tools=["tasks.todo_list", "media.url"],
        )
        edited = canvases.edit(
            self.path,
            self.canvas["id"],
            [
                {"find": "<title>Tip</title>", "replace": "<title>Split</title>"},
                {"find": "<h1>Split</h1>", "replace": "<h1>Split the bill</h1>"},
            ],
        )
        # Every pair is one version, and that version carries the tools the one before it declared.
        self.assertEqual(edited["version"], 3)
        self.assertIn("<title>Split</title>", edited["html"])
        self.assertIn("<h1>Split the bill</h1>", edited["html"])
        self.assertEqual(edited["tools"], second["tools"])
        self.assertEqual(canvases.current(self.path, self.canvas["id"])["version"], 3)

        restored = canvases.undo(self.path, self.canvas["id"])
        self.assertEqual((restored["version"], restored["html"]), (second["version"], second["html"]))
        self.assertEqual(restored["tools"], second["tools"])
        # The version the undo walked off is still stored: undo moves a pointer and deletes nothing.
        self.assertIn(edited["version"], self.stored_versions())
        self.assertIs(restored["can_undo"], True)
        self.assertIs(canvases.current(self.path, self.canvas["id"])["can_undo"], True)

        back = canvases.undo(self.path, self.canvas["id"])
        self.assertEqual((back["version"], back["html"]), (first["version"], first["html"]))
        self.assertIs(back["can_undo"], False)
        with self.assertRaises(canvases.CanvasError) as refused:
            canvases.undo(self.path, self.canvas["id"])
        self.assertEqual(refused.exception.status, 409)

        # A write lands on the version the user is looking at: the history the undo walked off is
        # replaced rather than kept above it.
        written = canvases.write(
            self.path, self.canvas["id"], DOCUMENT.replace("<h1>Tip</h1>", "<h1>Again</h1>")
        )
        self.assertEqual(written["version"], first["version"] + 1)
        self.assertEqual(self.stored_versions(), [first["version"], written["version"]])

    def test_an_edit_whose_second_pair_matches_twice_writes_nothing(self) -> None:
        twice = DOCUMENT.replace(
            "<body><h1>Tip</h1></body>",
            "<body><h1>Tip</h1><button>Save</button><button>Save</button></body>",
        )
        written = canvases.write(self.path, self.canvas["id"], twice)
        with self.assertRaises(canvases.CanvasError) as refused:
            canvases.edit(
                self.path,
                self.canvas["id"],
                [
                    {"find": "<h1>Tip</h1>", "replace": "<h1>Split</h1>"},
                    {"find": "Save", "replace": "Keep"},
                ],
            )
        message = str(refused.exception)
        self.assertIn("2 of 2", message)
        self.assertIn('"Save"', message)
        self.assertIn("2 times", message)
        self.assertEqual(canvases.record(self.path, self.canvas["id"])["version"], written["version"])
        self.assertEqual(canvases.current(self.path, self.canvas["id"])["html"], twice)

    def test_after_an_undo_canvas_read_answers_the_restored_version(self) -> None:
        kept = canvases.write(self.path, self.canvas["id"], DOCUMENT)
        canvases.write(
            self.path, self.canvas["id"], DOCUMENT.replace("<h1>Tip</h1>", "<h1>Split</h1>")
        )
        canvases.undo(self.path, self.canvas["id"])
        with mock.patch.object(canvases, "_session_canvas", return_value=self.canvas["id"]):
            read = json.loads(canvases.handle_read({}, session_id=self.canvas["session_id"]))
        # The agent reads what the user is looking at, not the version the undo walked off.
        self.assertEqual((read["version"], read["html"]), (kept["version"], kept["html"]))

    def test_an_edit_after_an_undo_builds_on_the_restored_text(self) -> None:
        # What it holds: the pairs are applied to the version the record points at, and that version
        # is read on the connection the write takes, so an undo cannot be reverted by an edit built
        # from the version it walked off. The race needs two writers, which a single-threaded case
        # cannot stage.
        first = canvases.write(
            self.path, self.canvas["id"], DOCUMENT.replace("<h1>Tip</h1>", "<h1>First</h1>")
        )
        canvases.write(
            self.path, self.canvas["id"], DOCUMENT.replace("<h1>Tip</h1>", "<h1>Second</h1>")
        )
        restored = canvases.undo(self.path, self.canvas["id"])
        self.assertEqual(restored["version"], first["version"])
        edited = canvases.edit(
            self.path,
            self.canvas["id"],
            [{"find": "<h1>First</h1>", "replace": "<h1>Restored</h1>"}],
        )
        # One above the restored version, built on the text the undo put back.
        self.assertEqual(edited["version"], first["version"] + 1)
        self.assertIn("<h1>Restored</h1>", edited["html"])
        self.assertNotIn("<h1>Second</h1>", edited["html"])
        self.assertEqual(canvases.current(self.path, self.canvas["id"])["version"], 2)

    def test_after_a_write_the_undo_goes_back_to_what_the_write_replaced(self) -> None:
        one = canvases.write(
            self.path, self.canvas["id"], DOCUMENT.replace("<h1>Tip</h1>", "<h1>One</h1>")
        )
        two = canvases.write(
            self.path, self.canvas["id"], DOCUMENT.replace("<h1>Tip</h1>", "<h1>Two</h1>")
        )
        canvases.write(
            self.path, self.canvas["id"], DOCUMENT.replace("<h1>Tip</h1>", "<h1>Three</h1>")
        )
        self.assertEqual(canvases.undo(self.path, self.canvas["id"])["version"], two["version"])
        # The write lands on the version the user is looking at, replacing the history they walked
        # off — so the undo after it goes back to that version, never into the abandoned one.
        four = canvases.write(
            self.path, self.canvas["id"], DOCUMENT.replace("<h1>Tip</h1>", "<h1>Four</h1>")
        )
        self.assertEqual(four["version"], two["version"] + 1)
        back = canvases.undo(self.path, self.canvas["id"])
        self.assertEqual((back["version"], back["html"]), (two["version"], two["html"]))
        self.assertGreater(one["version"], 0)


class DataTest(unittest.TestCase):
    """A canvas's own data: the host's clock, its own cap, and untouched by versions and undo."""

    def setUp(self) -> None:
        self.path = store_of(self)
        self.canvas = make_canvas(self.path)
        self.other = make_canvas(self.path)

    def test_a_data_write_never_reads_the_record_and_so_never_its_picture(self) -> None:
        # A data write asks only that the canvas is there. The record carries the tile's picture, up
        # to 192 KB, and this path holds the store's write lock, so reading it would make every other
        # writer wait behind a row nobody asked for.
        canvas_id = self.canvas["id"]

        def broad(*_args, **_kwargs):
            raise AssertionError("a data write read the whole record")

        with mock.patch.object(canvases, "_record", broad):
            stored = canvases.put_doc(self.path, canvas_id, "notes", "a", {"text": "one"})
            self.assertEqual(stored["doc"], {"text": "one"})
            self.assertEqual([row["id"] for row in canvases.data(self.path, canvas_id)], ["a"])
            self.assertTrue(canvases.remove_doc(self.path, canvas_id, "notes", "a")["removed"])

    def test_data_writes_win_by_host_clock_survive_an_undo_and_stop_at_the_cap(self) -> None:
        canvas_id = self.canvas["id"]
        # A document is answered as it was stored, stamped with the host's clock.
        first = canvases.put_doc(self.path, canvas_id, "notes", "a", {"text": "one"})
        self.assertEqual(
            (first["collection"], first["id"], first["doc"]), ("notes", "a", {"text": "one"})
        )
        self.assertLessEqual(first["at"], int(time.time() * 1000))
        self.assertGreater(first["at"], int(time.time() * 1000) - 60_000)

        # A second write of the same row replaces the first, and its `at` is the host's: an `at` in
        # the document is the caller's own data, never the clock.
        second = canvases.put_doc(self.path, canvas_id, "notes", "a", {"text": "two", "at": 1})
        self.assertGreaterEqual(second["at"], first["at"])
        self.assertEqual(second["doc"], {"text": "two", "at": 1})
        rows = canvases.data(self.path, canvas_id)
        self.assertEqual([(row["collection"], row["id"]) for row in rows], [("notes", "a")])
        self.assertEqual(rows[0]["doc"], {"text": "two", "at": 1})
        self.assertEqual(rows[0]["at"], second["at"])
        self.assertNotEqual(rows[0]["at"], 1)

        canvases.put_doc(self.path, self.other["id"], "notes", "a", {"text": "theirs"})
        self.assertEqual(
            [row["doc"] for row in canvases.data(self.path, self.other["id"])],
            [{"text": "theirs"}],
        )
        self.assertEqual(
            [row["doc"] for row in canvases.data(self.path, canvas_id)],
            [{"text": "two", "at": 1}],
        )

        # Data is not versioned: two versions, a document, an undo — and the documents are as they
        # were, which is what a page keeping its state across a rejected page relies on.
        canvases.write(self.path, canvas_id, DOCUMENT)
        canvases.write(
            self.path, canvas_id, DOCUMENT.replace("<h1>Tip</h1>", "<h1>Split</h1>")
        )
        canvases.put_doc(self.path, canvas_id, "notes", "kept", {"text": "kept"})
        before = canvases.data(self.path, canvas_id)
        restored = canvases.undo(self.path, canvas_id)
        self.assertEqual(restored["version"], 1)
        # An undo answers the canvas's data with its page, and leaves every document where it was.
        self.assertEqual(restored["data"], before)
        self.assertEqual(canvases.data(self.path, canvas_id), before)
        self.assertEqual(canvases.current(self.path, canvas_id)["data"], before)

        # A write past the cap is refused whole — the canvas keeps the documents it had — and the
        # words name the cap and what the data would have become.
        huge = {"text": "x" * (canvases.DATA_BYTES + 1)}
        with self.assertRaises(canvases.CanvasError) as refused:
            canvases.put_doc(self.path, canvas_id, "notes", "big", huge)
        self.assertIn("1 MB", str(refused.exception))
        self.assertIn("KB", str(refused.exception))
        self.assertIn("Remove something first", str(refused.exception))
        self.assertEqual(canvases.data(self.path, canvas_id), before)
        # The size is the canvas's whole data after the write, rounded up a KB: on a canvas holding
        # nothing else it is that one row's collection, id and JSON value as UTF-8 bytes.
        blank = make_canvas(self.path)
        with self.assertRaises(canvases.CanvasError) as too_big:
            canvases.put_doc(self.path, blank["id"], "notes", "big", huge)
        would_be = (
            len("notes") + len("big") + len(json.dumps(huge, allow_nan=False)) + canvases.DOC_BYTES
        )
        self.assertIn(f"{-(-would_be // 1024)} KB", str(too_big.exception))
        self.assertEqual(canvases.data(self.path, blank["id"]), [])

        # Removing takes one document and leaves the rest, and removing what is not there is not an
        # error: a page asks again on a slow answer.
        self.assertEqual(
            canvases.remove_doc(self.path, canvas_id, "notes", "a"),
            {"collection": "notes", "id": "a", "removed": True},
        )
        self.assertEqual([row["id"] for row in canvases.data(self.path, canvas_id)], ["kept"])
        self.assertEqual(
            canvases.remove_doc(self.path, canvas_id, "notes", "a")["removed"], False
        )
        self.assertEqual([row["id"] for row in canvases.data(self.path, canvas_id)], ["kept"])

        # A canvas that isn't there is a 404 for a write and for a read of its data, as it is for a
        # read of its page: one rule for "there is no such canvas".
        for call in (
            lambda: canvases.put_doc(self.path, "nope", "notes", "a", {}),
            lambda: canvases.remove_doc(self.path, "nope", "notes", "a"),
            lambda: canvases.data(self.path, "nope"),
        ):
            with self.assertRaises(canvases.CanvasError) as missing:
                call()
            self.assertEqual(missing.exception.status, 404)

    def test_a_name_has_to_be_a_name_and_a_document_json(self) -> None:
        canvas_id = self.canvas["id"]
        for bad, named in (
            ("", "collection"),
            ("x" * (canvases.NAME_CHARS + 1), "collection"),
            ("notes\n", "collection"),
            ("", "id"),
            ("x" * (canvases.NAME_CHARS + 1), "id"),
            ("a\x00b", "id"),
        ):
            with self.subTest(bad=bad, named=named):
                collection, doc_id = (bad, "a") if named == "collection" else ("notes", bad)
                with self.assertRaises(canvases.CanvasError) as refused:
                    canvases.put_doc(self.path, canvas_id, collection, doc_id, {})
                self.assertIn(named, str(refused.exception))
                self.assertEqual(refused.exception.status, 400)
        # A value JSON can't carry — a NaN, a set — is refused rather than stored as something else.
        for value in ({"when": float("nan")}, {"tags": {"a"}}):
            with self.assertRaises(canvases.CanvasError) as refused:
                canvases.put_doc(self.path, canvas_id, "notes", "a", value)
            self.assertIn("JSON", str(refused.exception))
            self.assertEqual(refused.exception.status, 400)
        # A read takes the same names a write does: the page's names are checked on both paths.
        with self.assertRaises(canvases.CanvasError) as refused:
            canvases.data(self.path, canvas_id, "")
        self.assertEqual(refused.exception.status, 400)
        self.assertIn("collection", str(refused.exception))
        self.assertEqual(canvases.data(self.path, canvas_id), [])

    def test_the_cap_counts_each_document_beside_its_content(self) -> None:
        # A page could otherwise keep a hundred thousand one-byte documents and hand every open an
        # answer many times the cap: the envelope a read carries for each one is counted too.
        canvas_id = self.canvas["id"]
        with mock.patch.object(canvases, "DATA_BYTES", 1000):
            for n in range(14):
                canvases.put_doc(self.path, canvas_id, "c", f"d{n}", 0)
            with self.assertRaises(canvases.CanvasError) as refused:
                canvases.put_doc(self.path, canvas_id, "c", "d14", 0)
        self.assertIn("capped at 1 MB", str(refused.exception))
        self.assertEqual(len(canvases.data(self.path, canvas_id)), 14)


class NamingTest(unittest.TestCase):
    """A canvas's data read or written from a session that isn't its own, by its title or its id."""

    def setUp(self) -> None:
        self.home = temp_hermes_home(self)
        self.path = db_path(self.home)
        self.canvas = make_canvas(self.path)
        self.other = canvases.create(
            self.path, request_profile="default", bot_id="bot-1", prompt="A run log", body=BODY
        )
        self.plain = triage.open_thread(self.path, "bot-1")[1]

    def test_a_session_outside_a_canvas_reads_its_data_by_id_or_title(self) -> None:
        canvas_id = self.canvas["id"]
        title = self.canvas["title"]
        canvases.put_doc(self.path, canvas_id, "runs", "a", {"km": 5})
        canvases.put_doc(self.path, canvas_id, "runs", "b", {"km": 7})
        canvases.put_doc(self.path, canvas_id, "notes", "n", {"text": "hello"})
        canvases.put_doc(self.path, self.other["id"], "notes", "n", {"text": "theirs"})

        # A plain chat names the canvas by its title, by its id, and by its title in another case,
        # and is answered the same documents — never the other canvas's.
        for named in (title, canvas_id, title.upper()):
            with self.subTest(named=named):
                every = json.loads(
                    canvases.handle_data_read({"canvas": named}, session_id=self.plain)
                )
                self.assertEqual(list(every), ["documents"])
                self.assertEqual(
                    [(row["collection"], row["id"], row["doc"]) for row in every["documents"]],
                    [
                        ("notes", "n", {"text": "hello"}),
                        ("runs", "a", {"km": 5}),
                        ("runs", "b", {"km": 7}),
                    ],
                )
        # One collection's documents, then one document of it — each answered as a read always was,
        # with no `canvas` key of its own.
        runs = json.loads(
            canvases.handle_data_read(
                {"canvas": title, "collection": "runs"}, session_id=self.plain
            )
        )
        self.assertEqual(list(runs), ["documents"])
        self.assertEqual([row["id"] for row in runs["documents"]], ["a", "b"])
        one = json.loads(
            canvases.handle_data_read(
                {"canvas": canvas_id, "collection": "runs", "id": "b"}, session_id=self.plain
            )
        )
        self.assertEqual(list(one), ["document"])
        self.assertEqual(one["document"]["doc"], {"km": 7})

        # The schema offers the name and says who may use it, and it is never required.
        self.assertEqual(
            set(canvases.DATA_READ_SCHEMA["parameters"]["properties"]),
            {"canvas", "collection", "id"},
        )
        self.assertNotIn("canvas", canvases.DATA_READ_SCHEMA["parameters"].get("required", []))
        self.assertNotIn("Canvas sessions only", canvases.DATA_READ_SCHEMA["description"])

    def test_a_session_outside_a_canvas_writes_and_removes_its_document(self) -> None:
        canvas_id = self.canvas["id"]
        title = self.canvas["title"]

        # A plain chat names the canvas by its title in another case and stores one document in it,
        # and is answered a stored document's answer — never a `canvas` key of its own.
        written = json.loads(
            canvases.handle_data_write(
                {"canvas": title.upper(), "collection": "runs", "id": "a", "doc": {"km": 5}},
                session_id=self.plain,
            )
        )
        self.assertEqual(set(written), {"collection", "id", "doc", "at"})
        self.assertEqual(
            (written["collection"], written["id"], written["doc"]), ("runs", "a", {"km": 5})
        )
        self.assertLessEqual(written["at"], int(time.time() * 1000))

        # A second write of the same row replaces it — last write wins, on the host's clock — and is
        # answered as the document now is.
        second = json.loads(
            canvases.handle_data_write(
                {"canvas": canvas_id, "collection": "runs", "id": "a", "doc": {"km": 6}},
                session_id=self.plain,
            )
        )
        self.assertEqual(second["doc"], {"km": 6})
        self.assertGreaterEqual(second["at"], written["at"])

        # Read back by its title, the canvas holds that one document and the other canvas holds
        # nothing: a write from outside reaches the canvas it named and no neighbour.
        read = json.loads(
            canvases.handle_data_read(
                {"canvas": title, "collection": "runs", "id": "a"}, session_id=self.plain
            )
        )
        self.assertEqual(read["document"]["doc"], {"km": 6})
        self.assertEqual(
            json.loads(
                canvases.handle_data_read({"canvas": self.other["id"]}, session_id=self.plain)
            ),
            {"documents": []},
        )

        # A remove takes the document out and says so; the same remove again takes nothing out and
        # says that, rather than failing.
        gone = json.loads(
            canvases.handle_data_write(
                {"canvas": title, "collection": "runs", "id": "a", "remove": True},
                session_id=self.plain,
            )
        )
        self.assertEqual(gone, {"collection": "runs", "id": "a", "removed": True})
        again = json.loads(
            canvases.handle_data_write(
                {"canvas": title, "collection": "runs", "id": "a", "remove": True},
                session_id=self.plain,
            )
        )
        self.assertEqual(again, {"collection": "runs", "id": "a", "removed": False})

        # The cap holds from outside too: a write past it is refused whole, and the documents the
        # canvas had are where they were.
        kept = json.loads(
            canvases.handle_data_write(
                {"canvas": title, "collection": "notes", "id": "n", "doc": {"text": "kept"}},
                session_id=self.plain,
            )
        )
        self.assertEqual(kept["doc"], {"text": "kept"})
        huge = {"text": "x" * (canvases.DATA_BYTES + 1)}
        refused = json.loads(
            canvases.handle_data_write(
                {"canvas": title, "collection": "notes", "id": "big", "doc": huge},
                session_id=self.plain,
            )
        )
        self.assertEqual(list(refused), ["error"])
        self.assertIn("1 MB", refused["error"])
        still = json.loads(canvases.handle_data_read({"canvas": title}, session_id=self.plain))
        self.assertEqual([row["doc"] for row in still["documents"]], [{"text": "kept"}])

        # A canvas's own session naming another canvas is refused, and nothing lands in that one.
        another = json.loads(
            canvases.handle_data_write(
                {"canvas": self.other["id"], "collection": "notes", "id": "x", "doc": 1},
                session_id=self.canvas["session_id"],
            )
        )
        self.assertEqual(list(another), ["error"])
        for other_id in (self.other["id"], canvas_id):
            self.assertIn(other_id, another["error"])
        self.assertEqual(
            json.loads(
                canvases.handle_data_read({"canvas": self.other["id"]}, session_id=self.plain)
            ),
            {"documents": []},
        )

        # The schema offers the same name the read does, never requires it, and says a canvas's own
        # session may leave it out rather than "Canvas sessions only".
        self.assertEqual(
            set(canvases.DATA_WRITE_SCHEMA["parameters"]["properties"]),
            {"canvas", "collection", "id", "doc", "remove"},
        )
        self.assertNotIn("canvas", canvases.DATA_WRITE_SCHEMA["parameters"].get("required", []))
        self.assertNotIn("Canvas sessions only", canvases.DATA_WRITE_SCHEMA["description"])
        self.assertIn("leave `canvas` out", canvases.DATA_WRITE_SCHEMA["description"])

    def test_a_name_no_canvas_answers_to_is_refused(self) -> None:
        # A name the store holds nothing for — a title's words or something id-shaped alike — is
        # refused with what was looked for, and where the names are.
        for named in ("Run log", "not-a-canvas"):
            with self.subTest(named=named):
                refused = json.loads(
                    canvases.handle_data_read({"canvas": named}, session_id=self.plain)
                )
                self.assertEqual(list(refused), ["error"])
                self.assertIn(named, refused["error"])
                self.assertIn(canvases.TOOL_LIST, refused["error"])

    def test_a_name_two_canvases_answer_to_is_refused(self) -> None:
        # Two canvases from the same words share a title, so the name is refused with their ids
        # rather than a guess at which one the caller meant.
        twin = make_canvas(self.path)
        title = self.canvas["title"]
        self.assertEqual(twin["title"], title)
        refused = json.loads(
            canvases.handle_data_read({"canvas": title}, session_id=self.plain)
        )
        self.assertEqual(list(refused), ["error"])
        for canvas_id in (self.canvas["id"], twin["id"]):
            self.assertIn(canvas_id, refused["error"])
        self.assertIn(canvases.TOOL_LIST, refused["error"])
        # An id is never ambiguous: each canvas is still read by its own.
        self.assertEqual(
            json.loads(
                canvases.handle_data_read({"canvas": twin["id"]}, session_id=self.plain)
            ),
            {"documents": []},
        )

    def test_a_canvas_session_names_only_its_own_canvas(self) -> None:
        canvases.put_doc(self.path, self.canvas["id"], "notes", "mine", {"text": "mine"})
        canvases.put_doc(self.path, self.other["id"], "notes", "theirs", {"text": "theirs"})
        title = self.canvas["title"]
        # No name, its id and its title all mean this canvas, and answer this canvas's documents.
        for named in ({}, {"canvas": self.canvas["id"]}, {"canvas": title, "collection": "notes"}):
            with self.subTest(named=named):
                read = json.loads(
                    canvases.handle_data_read(named, session_id=self.canvas["session_id"])
                )
                self.assertEqual([row["doc"] for row in read["documents"]], [{"text": "mine"}])
        # Another canvas's id is that canvas in every session, so this one refuses it — and names
        # both canvases, since a caller has to know which session it is in.
        another = json.loads(
            canvases.handle_data_read(
                {"canvas": self.other["id"]}, session_id=self.canvas["session_id"]
            )
        )
        self.assertEqual(list(another), ["error"])
        for canvas_id in (self.canvas["id"], self.other["id"]):
            self.assertIn(canvas_id, another["error"])

    def test_a_canvas_session_refuses_a_title_two_canvases_answer_to(self) -> None:
        # A title is not unique, so a name two canvases answer to is refused from a canvas's own
        # session too, with both ids: being one of them is no reason to guess, and a name means one
        # canvas in every session or none.
        twin = make_canvas(self.path)
        title = self.canvas["title"]
        self.assertEqual(twin["title"], title)
        refused = json.loads(
            canvases.handle_data_read({"canvas": title}, session_id=self.canvas["session_id"])
        )
        self.assertEqual(list(refused), ["error"])
        for canvas_id in (self.canvas["id"], twin["id"]):
            self.assertIn(canvas_id, refused["error"])
        self.assertIn(canvases.TOOL_LIST, refused["error"])

    def test_a_canvas_session_refuses_a_blank_canvas(self) -> None:
        # Leaving `canvas` out means this canvas; a blank name is not left out. It is a name no
        # canvas answers to, so it is refused rather than quietly read as this session's data.
        canvases.put_doc(self.path, self.canvas["id"], "notes", "mine", {"text": "mine"})
        for named in ("", "   "):
            with self.subTest(named=named):
                refused = json.loads(
                    canvases.handle_data_read(
                        {"canvas": named}, session_id=self.canvas["session_id"]
                    )
                )
                self.assertEqual(list(refused), ["error"])
                self.assertIn(canvases.TOOL_LIST, refused["error"])
        kept = json.loads(canvases.handle_data_read({}, session_id=self.canvas["session_id"]))
        self.assertEqual([row["doc"] for row in kept["documents"]], [{"text": "mine"}])

    def test_a_name_that_is_no_text_is_refused_rather_than_raising(self) -> None:
        # A surrogate code point has no UTF-8 bytes, so a name holding one has nowhere to be stored:
        # it is a name no document can have, refused here as a control character is.
        canvases.put_doc(self.path, self.canvas["id"], "notes", "a", {"text": "mine"})
        for named in ("\ud800", "a\udfff"):
            with self.subTest(named=named):
                for args in (
                    {"canvas": self.canvas["id"], "collection": named},
                    {"canvas": self.canvas["id"], "collection": "notes", "id": named},
                ):
                    refused = json.loads(
                        canvases.handle_data_read(args, session_id=self.plain)
                    )
                    self.assertEqual(list(refused), ["error"])
                    self.assertIn("surrogate", refused["error"])
                written = json.loads(
                    canvases.handle_data_write(
                        {"canvas": self.canvas["id"], "collection": named, "id": "a", "doc": 1},
                        session_id=self.plain,
                    )
                )
                self.assertEqual(list(written), ["error"])
                self.assertIn("surrogate", written["error"])

    def test_a_title_that_is_another_canvass_id_names_the_id_in_every_session(self) -> None:
        # A title is free text, so one canvas may be given another canvas's id as its name. A title
        # can never shadow an id: the name is the canvas whose key it is, everywhere — so this
        # session refuses the other canvas's id instead of writing into itself what was meant for
        # its neighbour.
        canvases.update(self.path, self.canvas["id"], {"title": self.other["id"]})
        canvases.put_doc(self.path, self.other["id"], "notes", "theirs", {"text": "theirs"})
        refused = json.loads(
            canvases.handle_data_write(
                {"canvas": self.other["id"], "collection": "notes", "id": "landed", "doc": 1},
                session_id=self.canvas["session_id"],
            )
        )
        self.assertEqual(list(refused), ["error"])
        for canvas_id in (self.canvas["id"], self.other["id"]):
            self.assertIn(canvas_id, refused["error"])
        # It landed in neither canvas: the id is still that canvas's key from a plain chat, and this
        # session holds nothing it didn't have.
        theirs = json.loads(
            canvases.handle_data_read(
                {"canvas": self.other["id"], "collection": "notes"}, session_id=self.plain
            )
        )
        self.assertEqual([row["id"] for row in theirs["documents"]], ["theirs"])
        mine = json.loads(
            canvases.handle_data_read(
                {"canvas": self.canvas["id"], "collection": "notes"}, session_id=self.plain
            )
        )
        self.assertEqual(mine, {"documents": []})

    def test_a_canvas_session_names_its_own_title_in_another_case(self) -> None:
        # A canvas's own session naming its own title in another case is that canvas, as it is
        # from a plain chat: what a name answers to is one rule, whichever session asks it.
        canvases.put_doc(self.path, self.canvas["id"], "notes", "mine", {"text": "mine"})
        canvases.put_doc(self.path, self.other["id"], "notes", "theirs", {"text": "theirs"})
        named = {"canvas": self.canvas["title"].upper()}
        outside = json.loads(canvases.handle_data_read(named, session_id=self.plain))
        own = json.loads(canvases.handle_data_read(named, session_id=self.canvas["session_id"]))
        self.assertEqual([row["doc"] for row in outside["documents"]], [{"text": "mine"}])
        self.assertEqual(own, outside)


class RouteTest(unittest.TestCase):
    def setUp(self) -> None:
        temp_hermes_home(self)
        self.app = wire(self, RouteAdapter())
        self.path = db_path(Path(__import__("hermes_constants").get_hermes_home()))

    def call(self, path: str, method: str = "GET", body: dict | None = None, **match: str) -> dict:
        request = FakeWeb.Request()
        request.match_info, request.headers = match, {}
        request.json = mock.AsyncMock(return_value=body)
        return asyncio.run(route(self.app, plugin.PREFIX + path, method)(request))

    def make(self) -> str:
        """A canvas made through the route, as the app makes one, by its id."""
        made = self.call(
            "/canvases", "POST", {"prompt": PROMPT, "profile_id": "bot-1", "body": BODY}
        )
        return made["payload"]["canvas"]["id"]

    def documents(self, canvas_id: str) -> list:
        """The documents the canvas's GET answers."""
        return self.call("/canvases/{canvas_id}", canvas_id=canvas_id)["payload"]["canvas"]["data"]

    def test_a_canvas_is_made_listed_and_read_through_the_routes(self) -> None:
        made = self.call("/canvases", "POST", {"prompt": PROMPT, "profile_id": "bot-1", "body": BODY})
        self.assertEqual(made["status"], 202)
        found = made["payload"]["canvas"]
        self.assertEqual(made["payload"]["object"], "gots.canvas")
        self.assertEqual(found["title"], canvases.title_of(PROMPT))
        listed = self.call("/canvases")
        self.assertEqual([row["id"] for row in listed["payload"]["canvases"]], [found["id"]])
        read = self.call("/canvases/{canvas_id}", canvas_id=found["id"])
        self.assertEqual((read["status"], read["payload"]["canvas"]["html"]), (200, ""))
        missing = self.call("/canvases/{canvas_id}", canvas_id="nope")
        self.assertEqual(missing["status"], 404)

    def test_a_prompt_the_rules_refuse_is_a_400(self) -> None:
        refused = self.call("/canvases", "POST", {"prompt": "  "})
        self.assertEqual(refused["status"], 400)
        self.assertIn("prompt", refused["payload"]["error"]["message"])
        # And a request that names no run is the caller's mistake, not a canvas half made.
        without_run = self.call("/canvases", "POST", {"prompt": PROMPT})
        self.assertEqual(without_run["status"], 400)
        self.assertIn("run request", without_run["payload"]["error"]["message"])
        self.assertEqual(self.call("/canvases")["payload"]["canvases"], [])

    def test_undo_moves_the_canvas_back_one_version(self) -> None:
        made = self.call("/canvases", "POST", {"prompt": PROMPT, "profile_id": "bot-1", "body": BODY})
        canvas_id = made["payload"]["canvas"]["id"]
        canvases.write(self.path, canvas_id, DOCUMENT)
        canvases.write(
            self.path, canvas_id, DOCUMENT.replace("<h1>Tip</h1>", "<h1>Split</h1>")
        )
        undone = self.call("/canvases/{canvas_id}/undo", "POST", canvas_id=canvas_id)
        self.assertEqual(undone["status"], 200)
        self.assertEqual(undone["payload"]["object"], "gots.canvas")
        found = undone["payload"]["canvas"]
        self.assertEqual((found["version"], found["html"]), (1, DOCUMENT))
        # At the first version there is nothing left to walk back to.
        again = self.call("/canvases/{canvas_id}/undo", "POST", canvas_id=canvas_id)
        self.assertEqual(again["status"], 409)

    def test_the_get_carries_the_canvas_s_own_data(self) -> None:
        canvas_id = self.make()
        self.assertEqual(self.documents(canvas_id), [])
        canvases.put_doc(self.path, canvas_id, "notes", "a", {"text": "one"})
        documents = self.documents(canvas_id)
        self.assertEqual(len(documents), 1)
        self.assertEqual(
            (documents[0]["collection"], documents[0]["id"], documents[0]["doc"]),
            ("notes", "a", {"text": "one"}),
        )
        self.assertIsInstance(documents[0]["at"], int)

    def test_a_call_puts_and_removes_the_canvas_s_own_data(self) -> None:
        canvas_id = self.make()
        put = self.call(
            "/canvases/{canvas_id}/call",
            "POST",
            {
                "shape": "data.put",
                "args": {"collection": "notes", "id": "a", "doc": {"text": "one"}, "at": 5},
            },
            canvas_id=canvas_id,
        )
        self.assertEqual((put["status"], put["payload"]["object"]), (200, "gots.canvas.call"))
        result = put["payload"]["result"]
        self.assertEqual(
            (result["collection"], result["id"], result["doc"]),
            ("notes", "a", {"text": "one"}),
        )
        # The caller's `at` is not the clock: the host stamps the row itself.
        self.assertNotEqual(result["at"], 5)
        documents = self.documents(canvas_id)
        self.assertEqual([row["doc"] for row in documents], [{"text": "one"}])
        self.assertEqual(documents[0]["at"], result["at"])

        removed = self.call(
            "/canvases/{canvas_id}/call",
            "POST",
            {"shape": "data.remove", "args": {"collection": "notes", "id": "a"}},
            canvas_id=canvas_id,
        )
        self.assertEqual(
            (removed["status"], removed["payload"]["object"]), (200, "gots.canvas.call")
        )
        self.assertEqual(
            removed["payload"]["result"],
            {"collection": "notes", "id": "a", "removed": True},
        )
        self.assertEqual(self.documents(canvas_id), [])

    def test_a_call_for_a_canvas_that_is_not_there_is_a_404_and_a_bad_one_a_400(self) -> None:
        put = {"shape": "data.put", "args": {"collection": "notes", "id": "a", "doc": {}}}
        missing = self.call("/canvases/{canvas_id}/call", "POST", put, canvas_id="nope")
        self.assertEqual(missing["status"], 404)
        self.assertIn("no such canvas", missing["payload"]["error"]["message"])
        # A body that isn't a JSON object is the caller's mistake.
        for body in (None, ["data.put"]):
            refused = self.call("/canvases/{canvas_id}/call", "POST", body, canvas_id="nope")
            self.assertEqual(refused["status"], 400)
            self.assertIn("JSON object", refused["payload"]["error"]["message"])

        canvas_id = self.make()
        # The data rules' own refusal reaches the caller with its status.
        bad = self.call(
            "/canvases/{canvas_id}/call",
            "POST",
            {"shape": "data.put", "args": {"collection": "", "id": "a", "doc": {}}},
            canvas_id=canvas_id,
        )
        self.assertEqual(bad["status"], 400)
        self.assertIn("collection", bad["payload"]["error"]["message"])
        # A put that names no document is refused rather than storing a null nothing wrote.
        without_doc = self.call(
            "/canvases/{canvas_id}/call",
            "POST",
            {"shape": "data.put", "args": {"collection": "notes", "id": "a"}},
            canvas_id=canvas_id,
        )
        self.assertEqual(without_doc["status"], 400)
        self.assertIn("doc", without_doc["payload"]["error"]["message"])
        self.assertEqual(self.documents(canvas_id), [])
        # A tool the version doesn't declare is a refusal that says so, not a host without tools.
        unknown = self.call(
            "/canvases/{canvas_id}/call",
            "POST",
            {"shape": "home.light", "args": {}},
            canvas_id=canvas_id,
        )
        self.assertEqual(unknown["status"], 403)
        self.assertEqual(unknown["payload"]["error"]["code"], "not_declared")
        self.assertIn("home.light", unknown["payload"]["error"]["message"])
        self.assertEqual(self.documents(canvas_id), [])

    def test_an_undeclared_tool_is_refused_a_declared_one_asks_and_a_granted_one_is_called(self) -> None:
        # A page calls the tools its own version declared, and the user's answer for each is kept on
        # the host: refused before the user is asked, asked once, and called forever after.
        canvas_id = self.make()
        ask = mock.Mock(return_value={"matches": ["notes.md"]})
        body = {"shape": "files.search", "args": {"query": "notes"}}
        with mock.patch.object(page_calls.mcp_call, "call", ask):
            undeclared = self.call(
                "/canvases/{canvas_id}/call", "POST", body, canvas_id=canvas_id
            )
            self.assertEqual(undeclared["status"], 403)
            self.assertEqual(undeclared["payload"]["error"]["code"], "not_declared")
            self.assertEqual(ask.call_count, 0)

            # The bot writes a version declaring two tools: the page may ask for either, and the
            # first call of one is the user's to answer.
            canvases.write(self.path, canvas_id, DOCUMENT, tools=["files.search", "mail.send"])
            asking = self.call("/canvases/{canvas_id}/call", "POST", body, canvas_id=canvas_id)
            self.assertEqual(asking["status"], 403)
            self.assertEqual(asking["payload"]["error"]["code"], "consent_required")
            self.assertEqual(ask.call_count, 0)

            allowed = self.call(
                "/canvases/{canvas_id}/grants",
                "POST",
                {"tool": "files.search", "allow": True},
                canvas_id=canvas_id,
            )
            self.assertEqual(allowed["status"], 200)
            self.assertEqual(allowed["payload"]["object"], "gots.canvas.grant")
            # The row is the answer and the host's clock for it: the device compares clocks, so an
            # answer that began before this one can't walk it back.
            grant = allowed["payload"]["grant"]
            self.assertEqual(
                {field: grant[field] for field in ("tool", "allowed")},
                {"tool": "files.search", "allowed": True},
            )
            self.assertIsInstance(grant["at"], int)
            # The row is answered with the canvas's answers after it, in one write's answer.
            self.assertEqual(allowed["payload"]["grants"], [grant])
            # The answer is the canvas's, so every one-canvas read carries it.
            read = self.call("/canvases/{canvas_id}", canvas_id=canvas_id)
            self.assertEqual(read["payload"]["canvas"]["grants"], [grant])

            answered = self.call("/canvases/{canvas_id}/call", "POST", body, canvas_id=canvas_id)
            self.assertEqual(answered["status"], 200)
            self.assertEqual(answered["payload"]["object"], "gots.canvas.call")
            self.assertEqual(answered["payload"]["result"], {"matches": ["notes.md"]})
            self.assertEqual(ask.call_count, 1)
            self.assertEqual(ask.call_args.args[1:], ("files.search", {"query": "notes"}))

            # The other tool is not the one that was allowed: a refusal of its own, and no call.
            refused = self.call(
                "/canvases/{canvas_id}/grants",
                "POST",
                {"tool": "mail.send", "allow": False},
                canvas_id=canvas_id,
            )
            self.assertEqual(refused["status"], 200)
            denied = self.call(
                "/canvases/{canvas_id}/call",
                "POST",
                {"shape": "mail.send", "args": {}},
                canvas_id=canvas_id,
            )
            self.assertEqual(denied["status"], 403)
            self.assertEqual(denied["payload"]["error"]["code"], "denied")
            self.assertEqual(ask.call_count, 1)

    def test_the_four_host_reads_answer_without_a_tool_or_a_grant(self) -> None:
        canvas_id = self.make()
        # The chats a page may list are this bot's own, newest first, and a chat the user deleted is
        # no chat at all: the flat projection is what a page draws, not the sync envelope.
        chats.merge(
            self.path,
            {
                "chat-1": {"at": 5, "value": {"title": "Groceries"}},
                "chat-2": {"at": 9, "deleted": True},
                "chat-3": {"at": 7, "value": {"title": "Trip"}},
            },
        )
        sessions = self.call(
            "/canvases/{canvas_id}/call", "POST", {"shape": "sessions"}, canvas_id=canvas_id
        )
        self.assertEqual(sessions["status"], 200)
        self.assertEqual(
            sessions["payload"]["result"]["sessions"],
            [
                {"id": "chat-3", "title": "Trip", "at": 7},
                {"id": "chat-1", "title": "Groceries", "at": 5},
            ],
        )
        # The host's read keeps its own argument rule: usage is read for one provider.
        unnamed = self.call(
            "/canvases/{canvas_id}/call", "POST", {"shape": "usage", "args": {}}, canvas_id=canvas_id
        )
        self.assertEqual(unnamed["status"], 400)
        self.assertIn("provider", unnamed["payload"]["error"]["message"])

    def test_the_sessions_read_lists_only_this_bots_own_chats(self) -> None:
        # The route says it answers this bot's chats, so a room, a project session and a canvas's
        # own chat are absent: the app's listsAsChat rule, held where the page's call reaches it.
        canvas_id = self.make()
        own = canvases.page(self.path, canvas_id)["chat_id"]
        chats.merge(
            self.path,
            {
                "plain": {"at": 5, "value": {"title": "Groceries"}},
                "room": {"at": 6, "value": {"title": "The crew", "room": "r1"}},
                "project": {"at": 7, "value": {"title": "Ship it", "projectId": "p1"}},
                "canvas": {"at": 8, "value": {"title": "Tip", "canvasId": "c9"}},
                # An empty string is no room, no project and no canvas: the app's rule reads it so.
                "emptied": {
                    "at": 9,
                    "value": {"title": "Back to chats", "room": "", "projectId": "", "canvasId": ""},
                },
                "main": {"at": 10, "value": {"title": "Main", "main": True}},
            },
        )
        listed = self.call(
            "/canvases/{canvas_id}/call", "POST", {"shape": "sessions"}, canvas_id=canvas_id
        )["payload"]["result"]["sessions"]
        self.assertEqual([row["id"] for row in listed], ["main", "emptied", "plain"])
        self.assertNotIn(own, [row["id"] for row in listed])

    def test_every_shape_is_a_404_for_a_canvas_that_is_not_there(self) -> None:
        # A tab left open on a deleted canvas must not keep reading the user's chats while every
        # write of it is a 404: the record is read once, before anything is dispatched.
        for shape in page_calls.HOST_SHAPES:
            with self.subTest(shape=shape):
                refused = self.call(
                    "/canvases/{canvas_id}/call", "POST", {"shape": shape}, canvas_id="ghost"
                )
                self.assertEqual(refused["status"], 404)
                self.assertIn("no such canvas", refused["payload"]["error"]["message"])
        # And a canvas its own creation took back is as absent as one that never was.
        made = self.make()
        canvases._drop(self.path, made)
        for shape in page_calls.HOST_SHAPES:
            with self.subTest(shape=shape):
                dropped = self.call(
                    "/canvases/{canvas_id}/call", "POST", {"shape": shape}, canvas_id=made
                )
                self.assertEqual(dropped["status"], 404)
        tool = self.call(
            "/canvases/{canvas_id}/call",
            "POST",
            {"shape": "data.put", "args": {"collection": "notes", "id": "a", "doc": {}}},
            canvas_id="ghost",
        )
        self.assertEqual(tool["status"], 404)

    def test_the_routines_read_projects_the_hosts_jobs_and_reads_no_run(self) -> None:
        # A page draws a routine's name, whether it is on and when it runs — not every run of every
        # job, which was one SQLite connection per job, per call, and not the host's schedule object.
        canvas_id = self.make()
        jobs = [
            {
                "id": "j1",
                "name": "Morning brief",
                "schedule": {"kind": "cron", "expr": "0 8 * * *", "display": "Every day at 8"},
                "enabled": False,
            },
            {"id": "j2", "name": "Nightly", "schedule": {"kind": "cron", "expr": "0 2 * * *"}},
            {
                "id": "j3",
                "name": "Said by the job",
                "schedule": {"expr": "1 1 * * *", "display": "Not this one"},
                "schedule_display": "Every hour",
            },
            {"id": "j4", "name": "No schedule", "schedule": {}},
        ]
        with cron_modules(jobs) as runs:
            routine = self.call(
                "/canvases/{canvas_id}/call", "POST", {"shape": "routines"}, canvas_id=canvas_id
            )
            self.assertEqual(routine["status"], 200)
            # The display is the same fallback the app's own routines screen reads: the job's, the
            # schedule's, its expression, else nothing — never the schedule object itself.
            self.assertEqual(
                routine["payload"]["result"],
                {
                    "routines": [
                        {
                            "id": "j1",
                            "name": "Morning brief",
                            "enabled": False,
                            "schedule_display": "Every day at 8",
                        },
                        {
                            "id": "j2",
                            "name": "Nightly",
                            "enabled": True,
                            "schedule_display": "0 2 * * *",
                        },
                        {
                            "id": "j3",
                            "name": "Said by the job",
                            "enabled": True,
                            "schedule_display": "Every hour",
                        },
                        {
                            "id": "j4",
                            "name": "No schedule",
                            "enabled": True,
                            "schedule_display": "",
                        },
                    ]
                },
            )
            self.assertEqual(runs.call_count, 0, "a routines read never opens the run ledger")
            # At most the read's cap, in the host's own order: a page draws a list, not a ledger.
            many = [
                {"id": f"j{index}", "name": f"Job {index}", "schedule": {"expr": "* * * * *"}}
                for index in range(plugin.CANVAS_READS_MAX + 10)
            ]
            with cron_modules(many):
                capped = self.call(
                    "/canvases/{canvas_id}/call",
                    "POST",
                    {"shape": "routines"},
                    canvas_id=canvas_id,
                )
            self.assertEqual(
                [row["id"] for row in capped["payload"]["result"]["routines"]],
                [f"j{index}" for index in range(plugin.CANVAS_READS_MAX)],
            )

    def test_a_declared_tool_is_named_server_and_tool_and_so_is_a_grant(self) -> None:
        # A name that isn't `<server>.<tool>` would be a row nothing can ever use: a version that
        # declares one gets no option row, no dialog, and a grant that can never be called.
        canvas_id = self.make()
        for tools, named in ((["search"], "search"), (["files."], "files."), (["ok.tool", ".search"], ".search")):
            with self.subTest(tools=tools):
                with self.assertRaises(canvases.CanvasError) as caught:
                    canvases.write(self.path, canvas_id, DOCUMENT, tools=tools)
                self.assertEqual(caught.exception.status, 400)
                self.assertIn(named, str(caught.exception))
                self.assertIn("<server>.<tool>", str(caught.exception))
        # Nothing was written, so the canvas still declares nothing at all.
        self.assertEqual(canvases.page(self.path, canvas_id)["version"], 0)

        canvases.write(self.path, canvas_id, DOCUMENT, tools=["files.search"])
        for tool in ("search", "files.", ".search", ""):
            with self.subTest(tool=tool):
                with self.assertRaises(canvases.CanvasError) as caught:
                    canvases.grant(self.path, canvas_id, tool, True)
                self.assertEqual(caught.exception.status, 400)
                self.assertIn("<server>.<tool>", str(caught.exception))
                if tool:
                    self.assertIn(tool, str(caught.exception))

    def test_a_grant_names_a_declared_tool_of_a_canvas_that_is_there(self) -> None:
        canvas_id = self.make()
        for body, status, named in (
            ({"tool": "", "allow": True}, 400, "tool"),
            ({"tool": 3, "allow": True}, 400, "tool"),
            ({"tool": "files.search", "allow": True}, 400, "files.search"),
        ):
            with self.subTest(body=body):
                refused = self.call(
                    "/canvases/{canvas_id}/grants", "POST", body, canvas_id=canvas_id
                )
                self.assertEqual(refused["status"], status)
                self.assertIn(named, refused["payload"]["error"]["message"])
        gone = self.call(
            "/canvases/{canvas_id}/grants",
            "POST",
            {"tool": "files.search", "allow": True},
            canvas_id="nope",
        )
        self.assertEqual(gone["status"], 404)

    def test_a_grant_for_a_tool_the_version_dropped_can_be_changed(self) -> None:
        # The options list the union of what this version declares and what the host holds an answer
        # for, so an answer outlives the version that asked: one already recorded can be changed —
        # at least revoked — while a brand-new answer for an undeclared tool is still refused.
        canvas_id = self.make()
        canvases.write(self.path, canvas_id, DOCUMENT, tools=["files.search"])
        granted = self.call(
            "/canvases/{canvas_id}/grants",
            "POST",
            {"tool": "files.search", "allow": True},
            canvas_id=canvas_id,
        )
        self.assertEqual(granted["status"], 200)
        # A later version stops declaring it, and the row stays on the host.
        canvases.write(self.path, canvas_id, DOCUMENT.replace("<h1>Tip</h1>", "<h1>Split</h1>"))
        self.assertEqual(canvases.page(self.path, canvas_id)["tools"], [])
        revoked = self.call(
            "/canvases/{canvas_id}/grants",
            "POST",
            {"tool": "files.search", "allow": False},
            canvas_id=canvas_id,
        )
        self.assertEqual(revoked["status"], 200)
        self.assertIs(revoked["payload"]["grant"]["allowed"], False)
        # A tool with no row and no declaration is a question this version never asked.
        refused = self.call(
            "/canvases/{canvas_id}/grants",
            "POST",
            {"tool": "mail.send", "allow": True},
            canvas_id=canvas_id,
        )
        self.assertEqual(refused["status"], 400)
        self.assertIn("mail.send", refused["payload"]["error"]["message"])

    def test_info_advertises_canvas_only_where_it_can_be_worked(self) -> None:
        # The tools have to reach a canvas's session and that session has to be told its guide: a
        # canvas with either half missing is a page nothing can build or change.
        for wired, told, listed in ((True, True, True), (False, True, False), (True, False, False)):
            with self.subTest(wired=wired, told=told):
                with mock.patch.object(canvases, "ready", return_value=wired), mock.patch.object(
                    openui, "canvas_ready", return_value=told
                ):
                    self.assertEqual("canvas" in self.call("/info")["payload"]["features"], listed)

    def test_pin_archive_rename_and_delete(self) -> None:
        deleted_sessions: list = []

        class SessionDb:
            def delete_session(self, session_id: str) -> None:
                deleted_sessions.append(session_id)

        adapter = RouteAdapter()
        adapter.session_db = SessionDb()
        self.app = wire(self, adapter)

        canvas_id = self.make()
        made = canvases.record(self.path, canvas_id)
        chat_id, session_id = made["chat_id"], made["session_id"]
        canvases.write(self.path, canvas_id, DOCUMENT, tools=["files.search"])
        # A second version, so there is something under the pointer and Undo has to survive the pin.
        canvases.write(self.path, canvas_id, DOCUMENT, tools=["files.search"])
        canvases.put_doc(self.path, canvas_id, "notes", "a", {"text": "one"})
        canvases.grant(self.path, canvas_id, "files.search", True)

        pinned = self.call("/canvases/{canvas_id}", "POST", {"pinned": True}, canvas_id=canvas_id)
        self.assertEqual((pinned["status"], pinned["payload"]["object"]), (200, "gots.canvas"))
        answered = pinned["payload"]["canvas"]
        self.assertIs(answered["pinned"], True)
        self.assertIs(answered["can_undo"], True, "the record answer still carries Undo")
        self.assertNotIn("html", answered)
        self.assertNotIn("data", answered)
        read = self.call("/canvases/{canvas_id}", canvas_id=canvas_id)["payload"]["canvas"]
        self.assertEqual(read["html"], DOCUMENT)
        self.assertEqual([row["doc"] for row in read["data"]], [{"text": "one"}])
        self.assertEqual(
            {field: answered[field] for field in ("id", "title", "version", "pinned", "archived", "at")},
            {field: read[field] for field in ("id", "title", "version", "pinned", "archived", "at")},
        )
        self.assertIs(canvases.record(self.path, canvas_id)["pinned"], True)
        listed = self.call("/canvases")["payload"]["canvases"]
        self.assertEqual(
            [(row["id"], row["pinned"], row["archived"]) for row in listed],
            [(canvas_id, True, False)],
        )

        hid = self.call("/canvases/{canvas_id}", "POST", {"archived": True}, canvas_id=canvas_id)
        self.assertIs(hid["payload"]["canvas"]["archived"], True)
        self.assertIs(hid["payload"]["canvas"]["pinned"], True)
        self.assertEqual(
            [
                (row["id"], row["pinned"], row["archived"])
                for row in self.call("/canvases")["payload"]["canvases"]
            ],
            [(canvas_id, True, True)],
        )

        renamed = self.call(
            "/canvases/{canvas_id}", "POST", {"title": "Split the bill"}, canvas_id=canvas_id
        )
        self.assertEqual(renamed["status"], 200)
        self.assertEqual(renamed["payload"]["canvas"]["title"], "Split the bill")
        self.assertEqual(canvases.record(self.path, canvas_id)["title"], "Split the bill")
        chat = chats.one(self.path, chat_id)["value"]
        self.assertEqual(chat["title"], "Split the bill")
        self.assertIs(chat["titleEdited"], True)
        self.assertGreaterEqual(renamed["payload"]["canvas"]["at"], made["at"])

        for body, named in (
            ({}, None),
            ({"pinned": "yes"}, "pinned"),
            ({"archived": 1}, "archived"),
            ({"title": 3}, "title"),
            ({"title": "   "}, "title"),
        ):
            with self.subTest(body=body):
                refused = self.call("/canvases/{canvas_id}", "POST", body, canvas_id=canvas_id)
                self.assertEqual(refused["status"], 400)
                if named is not None:
                    self.assertIn(named, refused["payload"]["error"]["message"])

        for method, body in (("POST", {"pinned": True}), ("DELETE", None)):
            with self.subTest(method=method):
                refused = self.call("/canvases/{canvas_id}", method, body, canvas_id="nope")
                self.assertEqual(refused["status"], 404)

        # The chat's clock is ahead of the canvas's, as a fast device leaves it: the tombstone still lands.
        ahead = int(time.time() * 1000) + 60_000
        chats.merge(
            self.path,
            {chat_id: {"at": ahead, "value": chats.one(self.path, chat_id)["value"]}},
        )

        gone = self.call("/canvases/{canvas_id}", "DELETE", canvas_id=canvas_id)
        self.assertEqual(gone["status"], 200)
        self.assertEqual(
            gone["payload"],
            {"object": "gots.canvas.deleted", "deleted": True, "id": canvas_id},
        )
        self.assertEqual(self.call("/canvases/{canvas_id}", canvas_id=canvas_id)["status"], 404)
        self.assertEqual(self.call("/canvases")["payload"]["canvases"], [])
        self.assertIs(chats.one(self.path, chat_id)["deleted"], True)
        self.assertGreater(chats.one(self.path, chat_id)["at"], ahead)
        self.assertEqual(deleted_sessions, [session_id])
        # And the first turn the canvas was made with is not left queued for a session that is gone.
        self.assertEqual(outbox.read(self.path, session_id)["items"], [])
        conn = connect(self.path)
        try:
            left = {
                table: conn.execute(
                    f"SELECT COUNT(*) FROM {table} WHERE {key} = ?", (canvas_id,)
                ).fetchone()[0]
                for table, key in (
                    ("canvases", "id"),
                    ("canvas_versions", "canvas_id"),
                    ("canvas_docs", "canvas_id"),
                    ("canvas_grants", "canvas_id"),
                )
            }
        finally:
            conn.close()
        self.assertEqual(left, {
            "canvases": 0,
            "canvas_versions": 0,
            "canvas_docs": 0,
            "canvas_grants": 0,
        })


if __name__ == "__main__":
    unittest.main()
