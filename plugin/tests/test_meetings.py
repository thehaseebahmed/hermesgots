"""Tests for meetings (``plugin/meetings.py``): uploads in parts and their transcription on the host.

Hermes's transcription module isn't on a test run's path, so each test stands in for it (as
``test_dictation`` does) and asserts this module's own rules: part limits, meeting-level timestamps,
resuming, and what a failure leaves behind.
"""

from __future__ import annotations

import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

from plugin import meetings

from plugin.tests.test_dictation import hermes


class Segment:
    def __init__(self, start, text):
        self.start, self.text = start, text


def with_model(tt, per_part):
    """Gives the fake host a loaded model whose ``transcribe`` answers the next entry of ``per_part``."""
    calls = []

    class Model:
        def transcribe(self, path, **kwargs):
            calls.append({"path": path, **kwargs})
            return iter(per_part.pop(0)), types.SimpleNamespace()

    tt._get_or_load_local_model = lambda name, cfg: Model()
    tt.calls = calls


class MeetingsTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.path = Path(self.dir.name) / "memento" / "memento.db"

    def audio(self, parts=2):
        tt, patch = hermes()
        patch.start()
        self.addCleanup(patch.stop)
        return tt, meetings.create(self.path, None, "Standup", None, parts)

    def upload(self, meeting_id, n, start, data=b"audio"):
        return meetings.add_part(self.path, meeting_id, n, start, data, "audio/webm")

    def test_a_transcript_is_ready_for_notes_at_once(self):
        found = meetings.create(
            self.path, None, " Weekly  sync ", "p1", None, [{"at": 5, "text": "Second"}, {"at": 0, "text": "First"}]
        )
        self.assertEqual(found["stage"], "transcribed")
        self.assertEqual(found["title"], "Weekly sync")
        self.assertEqual([line["text"] for line in found["transcript"]], ["First", "Second"])
        self.assertEqual(found["duration"], 5)

    def test_a_malformed_transcript_is_refused(self):
        for bad in ([], [{"at": -1, "text": "x"}], ["x"], [{"at": "0", "text": "x"}], [{"at": 0, "text": " "}]):
            with self.assertRaises(meetings.MeetingError):
                meetings.create(self.path, None, "T", None, None, bad)

    def test_the_length_limit_is_three_hours(self):
        _, patch = hermes()
        with patch:
            meetings.create(self.path, None, "T", None, meetings.MAX_PARTS)
            with self.assertRaises(meetings.MeetingError) as raised:
                meetings.create(self.path, None, "T", None, meetings.MAX_PARTS + 1)
        self.assertEqual(raised.exception.status, 413)

    def test_a_host_that_cannot_transcribe_refuses_audio(self):
        _, patch = hermes(is_stt_enabled=lambda cfg: False)
        with patch, self.assertRaises(meetings.MeetingError) as raised:
            meetings.create(self.path, None, "T", None, 1)
        self.assertEqual(raised.exception.status, 501)

    def test_finish_waits_for_every_part(self):
        _, found = self.audio(2)
        self.upload(found["id"], 0, 0)
        with self.assertRaisesRegex(meetings.MeetingError, "1 of the 2 parts"):
            meetings.finish(self.path, found["id"])
        self.upload(found["id"], 1, 300)
        self.assertEqual(meetings.finish(self.path, found["id"])["stage"], "transcribing")

    def test_a_part_outside_the_meeting_is_refused(self):
        _, found = self.audio(1)
        for n in (-1, 1):
            with self.assertRaises(meetings.MeetingError):
                self.upload(found["id"], n, 0)
        with self.assertRaises(meetings.MeetingError):
            meetings.add_part(self.path, found["id"], 0, 0, b"", "audio/webm")

    def test_a_part_sent_again_replaces_the_first(self):
        _, found = self.audio(1)
        self.upload(found["id"], 0, 0, b"one")
        self.upload(found["id"], 0, 0, b"two")
        files = list(meetings.folder(self.path, found["id"]).glob("part-0.*"))
        self.assertEqual([f.read_bytes() for f in files], [b"two"])

    def test_segments_carry_the_meeting_level_second(self):
        tt, found = self.audio(2)
        with_model(tt, [[Segment(1.2, " Hello "), Segment(8, "there")], [Segment(3, "Back")]])
        self.upload(found["id"], 0, 0)
        self.upload(found["id"], 1, 300)
        meetings.finish(self.path, found["id"])
        meetings._job(self.path, found["id"])
        done = meetings.meeting(self.path, found["id"])
        self.assertEqual(done["stage"], "transcribed")
        self.assertEqual(
            done["transcript"],
            [{"at": 1, "text": "Hello"}, {"at": 8, "text": "there"}, {"at": 303, "text": "Back"}],
        )
        self.assertEqual(done["duration"], 303)
        self.assertFalse(meetings.folder(self.path, found["id"]).exists())

    def test_each_part_is_prompted_with_the_text_before_it(self):
        tt, found = self.audio(2)
        with_model(tt, [[Segment(0, "We ship Friday")], [Segment(0, "ok")]])
        self.upload(found["id"], 0, 0)
        self.upload(found["id"], 1, 300)
        meetings.finish(self.path, found["id"])
        meetings._job(self.path, found["id"])
        self.assertIsNone(tt.calls[0]["initial_prompt"])
        self.assertEqual(tt.calls[1]["initial_prompt"], "We ship Friday")

    def test_a_part_is_one_segment_when_the_model_cannot_be_reached(self):
        tt, found = self.audio(1)
        tt._get_or_load_local_model = mock.Mock(side_effect=RuntimeError("no model"))
        self.upload(found["id"], 0, 600)
        meetings.finish(self.path, found["id"])
        meetings._job(self.path, found["id"])
        self.assertEqual(meetings.meeting(self.path, found["id"])["transcript"], [{"at": 600, "text": "Hello there."}])

    def test_a_failed_part_keeps_the_ones_done_and_retry_resumes(self):
        tt, found = self.audio(2)
        answers = [[Segment(0, "One")], RuntimeError("out of memory"), [Segment(0, "Two")]]

        class Model:
            def transcribe(self, path, **kwargs):
                answer = answers.pop(0)
                if isinstance(answer, Exception):
                    raise answer
                return iter(answer), None

        tt._get_or_load_local_model = lambda name, cfg: Model()
        # The whole-part fallback fails too for the second part.
        results = iter([{"success": False, "error": "boom"}])
        real = tt._transcribe_local
        tt._transcribe_local = lambda path, model, prompt=None: next(results, None) or real(path, model, prompt=prompt)
        self.upload(found["id"], 0, 0)
        self.upload(found["id"], 1, 300)
        meetings.finish(self.path, found["id"])
        with self.assertRaisesRegex(Exception, "boom"):
            meetings._job(self.path, found["id"])
        meetings._fail(self.path, found["id"], "boom")
        failed = meetings.meeting(self.path, found["id"])
        self.assertEqual((failed["error"], failed["parts_done"], failed["stage"]), ("boom", 1, "transcribing"))
        meetings.retry(self.path, found["id"])
        meetings._job(self.path, found["id"])
        done = meetings.meeting(self.path, found["id"])
        self.assertEqual([line["text"] for line in done["transcript"]], ["One", "Two"])

    def test_a_recording_nobody_spoke_in_fails(self):
        tt, found = self.audio(1)
        with_model(tt, [[]])
        self.upload(found["id"], 0, 0)
        meetings.finish(self.path, found["id"])
        with self.assertRaisesRegex(meetings.MeetingError, "Nobody could be heard"):
            meetings._job(self.path, found["id"])

    def test_retry_needs_a_failure(self):
        _, found = self.audio(1)
        with self.assertRaises(meetings.MeetingError):
            meetings.retry(self.path, found["id"])

    def test_resume_continues_meetings_that_were_transcribing(self):
        _, found = self.audio(1)
        self.upload(found["id"], 0, 0)
        meetings.finish(self.path, found["id"])
        with mock.patch.object(meetings, "spawn") as spawn:
            meetings.resume(self.path)
            meetings.resume(self.path)
        spawn.assert_called_once_with(self.path, found["id"])

    def test_remove_deletes_the_meeting_and_its_audio(self):
        _, found = self.audio(1)
        self.upload(found["id"], 0, 0)
        self.assertIsNotNone(meetings.remove(self.path, found["id"]))
        self.assertIsNone(meetings.meeting(self.path, found["id"]))
        self.assertFalse(meetings.folder(self.path, found["id"]).exists())
        self.assertIsNone(meetings.remove(self.path, found["id"]))

    def test_the_list_is_the_profiles_own(self):
        meetings.create(self.path, "a", "A", None, None, [{"at": 0, "text": "x"}])
        meetings.create(self.path, "b", "B", None, None, [{"at": 0, "text": "x"}])
        self.assertEqual([m["title"] for m in meetings.meetings(self.path, "a")], ["A"])
        self.assertEqual(len(meetings.meetings(self.path)), 2)


if __name__ == "__main__":
    unittest.main()
