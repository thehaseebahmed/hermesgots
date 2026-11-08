"""A canvas: the run its prompt starts, the chat record that carries it, the scan every write passes,
and the session — compression's children included — that is the only one told its tools and guide.

Run: python3 -m unittest plugin.tests.test_canvases -v
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
import sys
import unittest
from contextlib import contextmanager
from types import ModuleType
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import plugin
from plugin import canvases, chats, openui, outbox, triage
from plugin.store import connect, db_path
from plugin.tests._helpers import FakeWeb, RouteAdapter, route, temp_hermes_home, wire

PROMPT = "A tip calculator for a restaurant bill, in the app's own colours"
BODY = {
    "input": [{"role": "user", "content": PROMPT}],
    "provider": "anthropic",
    "model": "claude-opus-5-5",
}
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
    module.registry = registry  # type: ignore[attr-defined]
    package = ModuleType("tools")
    package.registry = module  # type: ignore[attr-defined]
    with mock.patch.dict(
        sys.modules, {"tools": package, "tools.registry": module}
    ):
        yield


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
        conn = connect(self.path)
        try:
            body = json.loads(
                conn.execute("SELECT body FROM outbox WHERE id = ?", (item["id"],)).fetchone()[0]
            )
        finally:
            conn.close()
        self.assertEqual(body["input"][0]["content"], PROMPT)
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
        first = canvases.write(self.path, self.canvas["id"], DOCUMENT, tools=["todo_list"])
        self.assertEqual((first["version"], first["html"]), (1, DOCUMENT))
        self.assertEqual(first["tools"], ["todo_list"])
        second = canvases.write(self.path, self.canvas["id"], DOCUMENT.replace("Tip", "Split"))
        self.assertEqual(second["version"], 2)
        self.assertEqual(canvases.listing(self.path)[0]["version"], 2)

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
        ):
            with self.subTest(hole=hole):
                with self.assertRaises(canvases.CanvasError):
                    canvases.write(self.path, self.canvas["id"], DOCUMENT.replace("<body>", hole + "<body>"))
        self.assertEqual(canvases.record(self.path, self.canvas["id"])["version"], 0)

    def test_a_link_the_reader_could_tap_is_not_a_resource(self) -> None:
        html = DOCUMENT.replace("<body>", '<body><a href="https://example.com">Read more</a>')
        self.assertEqual(canvases.write(self.path, self.canvas["id"], html)["version"], 1)


class SessionTest(unittest.TestCase):
    """The tools and the guide reach a canvas's session and no other, a compacted one included."""

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
            [canvases.TOOL_EDIT, canvases.TOOL_READ, canvases.TOOL_WRITE],
        )
        self.assertEqual(len(canvas_agent.tools), 3)
        self.assertEqual(plain_agent.tools, [])
        self.assertEqual(plain_agent.valid_tool_names, set())

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
        # Outside a canvas's session neither tool answers anything of a canvas.
        with mock.patch.object(canvases, "_session_canvas", return_value=None):
            self.assertIn("error", json.loads(canvases.handle_write({"html": DOCUMENT}, session_id="s")))
            self.assertIn("error", json.loads(canvases.handle_read({}, session_id="s")))


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
        first = canvases.write(self.path, self.canvas["id"], DOCUMENT, tools=["todo_list"])
        second = canvases.write(
            self.path,
            self.canvas["id"],
            DOCUMENT.replace("<h1>Tip</h1>", "<h1>Split</h1>"),
            tools=["todo_list", "media_url"],
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

    def test_info_advertises_canvas_only_where_it_can_be_worked(self) -> None:
        # The tools have to reach a canvas's session and that session has to be told its guide: a
        # canvas with either half missing is a page nothing can build or change.
        for wired, told, listed in ((True, True, True), (False, True, False), (True, False, False)):
            with self.subTest(wired=wired, told=told):
                with mock.patch.object(canvases, "ready", return_value=wired), mock.patch.object(
                    openui, "canvas_ready", return_value=told
                ):
                    self.assertEqual("canvas" in self.call("/info")["payload"]["features"], listed)


if __name__ == "__main__":
    unittest.main()
