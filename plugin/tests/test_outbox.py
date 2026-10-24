"""The queue the plugin holds for a session's next turn.

Run: python3 -m unittest plugin.tests.test_outbox -v
"""

from __future__ import annotations

import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from plugin import outbox


def body(text: str) -> dict:
    return {"model": "m", "input": [{"role": "user", "content": text}], "session_id": "s1"}


def parts(*texts: str) -> dict:
    """A message the app sends with files: its words, then a marker line per file."""
    return {
        "model": "m",
        "input": [{"role": "user", "content": [{"type": "text", "text": text} for text in texts]}],
        "session_id": "s1",
    }


class Adapter:
    def __init__(self) -> None:
        self._run_statuses: dict = {}

    def run(self, run_id: str, status: str, at: float, **extra) -> None:
        self._run_statuses[run_id] = {
            "run_id": run_id,
            "session_id": "s1",
            "status": status,
            "created_at": at,
            "updated_at": at,
            **extra,
        }


class OutboxTest(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = tempfile.TemporaryDirectory()
        self.path = Path(self.dir.name) / "memento.db"
        self.adapter = Adapter()
        self.posted: list = []

        async def post(adapter, profile, path, request, authorization=None, idempotency_key=None):
            self.posted.append((path, request, idempotency_key))
            return {"run_id": f"run_{len(self.posted)}"}

        patch = mock.patch.object(outbox, "post", post)
        patch.start()
        self.addCleanup(patch.stop)
        ids = mock.patch.object(outbox, "session_ids", mock.AsyncMock(return_value={"s1"}))
        ids.start()
        self.addCleanup(ids.stop)

    def tearDown(self) -> None:
        self.dir.cleanup()

    def tick(self) -> None:
        asyncio.run(outbox.tick(self.adapter, "s1", None, self.path))

    def test_waits_for_the_run_then_sends_in_order(self) -> None:
        first = outbox.add(self.path, "s1", None, "one", [], body("one"))
        outbox.add(self.path, "s1", None, "two", [], body("two"))
        self.adapter.run("r0", "running", 1)
        self.tick()
        self.assertEqual(self.posted, [])

        self.adapter.run("r0", "completed", 1)
        self.tick()
        self.assertEqual(self.posted[0][0], "/v1/runs")
        self.assertEqual(self.posted[0][2], first["id"])
        found = outbox.read(self.path, "s1")
        self.assertEqual([item["text"] for item in found["items"]], ["two"])
        self.assertEqual(found["sent"][0]["run_id"], "run_1")

        self.adapter.run("run_1", "running", 2)
        self.tick()
        self.assertEqual(len(self.posted), 1)

    def test_a_stopped_run_pauses_until_sent(self) -> None:
        item = outbox.add(self.path, "s1", None, "one", [], body("one"))
        self.adapter.run("r0", "cancelled", 1)
        self.tick()
        self.assertEqual(self.posted, [])
        self.assertTrue(outbox.promote(self.path, "s1", item["id"]))
        self.tick()
        self.assertEqual(len(self.posted), 1)

    def test_an_unread_steer_goes_first(self) -> None:
        outbox.add(self.path, "s1", None, "later", [], body("later"))
        self.adapter.run("r0", "completed", 1, pending_steer="also this")
        self.tick()
        sent = self.posted[0][1]
        self.assertEqual(sent["input"], [{"role": "user", "content": "also this"}])
        self.assertEqual(sent["model"], "m")
        # Once only, even though the finished run still reports it.
        self.adapter.run("run_1", "completed", 2)
        self.tick()
        self.assertEqual(self.posted[1][1]["input"][0]["content"], "later")
        self.tick()
        self.assertEqual(len(self.posted), 2)

    def test_a_refused_start_stops_the_queue(self) -> None:
        outbox.add(self.path, "s1", None, "one", [], body("one"))

        async def refuse(*args, **kwargs):
            raise outbox.StartError("bad model", True)

        with mock.patch.object(outbox, "post", refuse):
            self.tick()
        found = outbox.read(self.path, "s1")
        self.assertEqual(found["items"][0]["error"], "bad model")
        self.tick()
        self.assertEqual(self.posted, [])

    def test_take_and_put_back(self) -> None:
        item = outbox.add(self.path, "s1", None, "one", [], body("one"))
        row = outbox.take(self.path, "s1", item["id"])
        self.assertEqual(outbox.read(self.path, "s1")["items"], [])
        outbox.put_back(self.path, row)
        self.assertEqual(outbox.read(self.path, "s1")["items"][0]["id"], item["id"])

    def test_clean_body_keeps_the_run_fields(self) -> None:
        run = outbox.clean_body("s1", {"model": "m", "input": [], "stream": True, "session_id": "x"})
        self.assertEqual(run, {"model": "m", "input": [], "session_id": "s1"})

    def steer(self, item_id: str):
        return asyncio.run(outbox.steer(self.adapter, None, self.path, "s1", item_id))

    def test_a_file_steers_as_the_markers_its_message_carries(self) -> None:
        """A file's content reaches the model as a marker line, which a steer can carry."""
        marker = '<attachment name="notes.txt" type="text/plain" size="3" path="/h/notes.txt" />'
        item = outbox.add(
            self.path,
            "s1",
            None,
            "read this",
            [{"name": "notes.txt", "type": "text/plain", "size": 3, "path": "/h/notes.txt"}],
            parts("read this", marker, "The content of each file is not included in this message."),
        )
        self.adapter.run("r1", "running", 1)
        steered, refusal = self.steer(item["id"])
        self.assertIsNone(refusal)
        self.assertEqual(
            self.posted[0][:2],
            (
                "/v1/runs/r1/steer",
                {
                    "input": "read this\n"
                    f"{marker}\n"
                    "The content of each file is not included in this message."
                },
            ),
        )
        self.assertEqual(len(self.posted), 1)
        self.assertEqual(steered["run_id"], "r1")
        self.assertEqual(outbox.read(self.path, "s1")["items"], [])

    def test_a_message_carrying_a_photo_waits_instead(self) -> None:
        """A photo's content rides in the message itself, and a steer is text alone."""
        item = outbox.add(
            self.path,
            "s1",
            None,
            "look",
            [{"name": "cat.png", "type": "image/png", "size": 3, "path": "/h/cat.png"}],
            {
                "model": "m",
                "input": [
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": "look"},
                            {"type": "image", "source": {"type": "base64", "data": "aGk="}},
                        ],
                    }
                ],
                "session_id": "s1",
            },
        )
        self.adapter.run("r1", "running", 1)
        steered, refusal = self.steer(item["id"])
        self.assertIsNone(steered)
        self.assertIsNotNone(refusal)
        self.assertEqual(self.posted, [], "nothing reaches the run")
        found = outbox.read(self.path, "s1")
        self.assertEqual([row["id"] for row in found["items"]], [item["id"]], "it stays queued")

    def test_a_photo_the_message_cant_hold_steers_as_text(self) -> None:
        """A model that takes no images reads a photo's marker line, which a steer carries."""
        photo = '<attachment name="scan.png" type="image/png" size="3" path="/h/scan.png" />'
        item = outbox.add(
            self.path,
            "s1",
            None,
            "look",
            [{"name": "scan.png", "type": "image/png", "size": 3, "path": "/h/scan.png"}],
            parts("look", photo),
        )
        self.adapter.run("r1", "running", 1)
        steered, refusal = self.steer(item["id"])
        self.assertIsNone(refusal)
        self.assertEqual(self.posted[0][:2], ("/v1/runs/r1/steer", {"input": f"look\n{photo}"}))
        self.assertEqual(steered["run_id"], "r1")


if __name__ == "__main__":
    unittest.main()
