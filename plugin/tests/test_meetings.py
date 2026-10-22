"""Tests for meetings (``plugin/meetings.py``): a recording uploaded in chunks, joined and cut into
windows on the host, their transcription and the notes written from the transcript.

Hermes's transcription module and the decoder aren't on a test run's path, so each test stands in
for them (as ``test_dictation`` does) and asserts this module's own rules: chunk limits,
meeting-level timestamps, resuming, and what a failure leaves behind.
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
        def transcribe(self, window, **kwargs):
            calls.append({"window": window, **kwargs})
            return iter(per_part.pop(0)), types.SimpleNamespace()

    tt._get_or_load_local_model = lambda name, cfg: Model()
    tt.calls = calls


class FakeLlm:
    """A host model whose ``complete_structured`` answers the next entry of ``answers``."""

    def __init__(self, *answers):
        self.answers = list(answers)
        self.calls = []

    def complete_structured(self, **kwargs):
        self.calls.append(kwargs)
        answer = self.answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return types.SimpleNamespace(parsed=answer)


def notes(summary="Short.", **sections):
    return {"summary": summary, "key_points": [], "decisions": [], "action_items": [], "open_questions": [], **sections}


class MeetingsTest(unittest.TestCase):
    def setUp(self):
        self.llm = FakeLlm()
        patcher = mock.patch.object(meetings, "ctx", types.SimpleNamespace(llm=self.llm))
        patcher.start()
        self.addCleanup(patcher.stop)
        pusher = mock.patch.object(meetings.push, "notify")
        self.notify = pusher.start()
        self.addCleanup(pusher.stop)
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.path = Path(self.dir.name) / "memento" / "memento.db"

    def audio(self, chunks=2, seconds=400):
        """A host that decodes any recording to ``seconds`` of silence: two 5-minute windows by default."""
        tt, patch = hermes()
        patch.start()
        self.addCleanup(patch.stop)
        decoder = mock.patch.object(meetings, "_decode", lambda file: bytes(seconds * meetings.SAMPLE_RATE))
        decoder.start()
        self.addCleanup(decoder.stop)
        return tt, meetings.create(self.path, None, "Standup", None, chunks)

    def upload(self, meeting_id, n, data=b"audio"):
        return meetings.add_part(self.path, meeting_id, n, data, "audio/webm")

    def test_a_transcript_goes_straight_to_the_notes(self):
        found = meetings.create(
            self.path, None, " Weekly  sync ", "p1", None, [{"at": 5, "text": "Second"}, {"at": 0, "text": "First"}]
        )
        self.assertEqual(found["stage"], "writing")
        self.assertEqual(found["title"], "Weekly sync")
        self.assertEqual([line["text"] for line in found["transcript"]], ["First", "Second"])
        self.assertEqual(found["duration"], 5)

    def test_a_malformed_transcript_is_refused(self):
        for bad in ([], [{"at": -1, "text": "x"}], ["x"], [{"at": "0", "text": "x"}], [{"at": 0, "text": " "}]):
            with self.assertRaises(meetings.MeetingError):
                meetings.create(self.path, None, "T", None, None, bad)

    def test_the_size_limit_is_a_chunk_count(self):
        _, patch = hermes()
        with patch:
            meetings.create(self.path, None, "T", None, meetings.MAX_CHUNKS)
            with self.assertRaises(meetings.MeetingError) as raised:
                meetings.create(self.path, None, "T", None, meetings.MAX_CHUNKS + 1)
        self.assertEqual(raised.exception.status, 413)

    def test_a_recording_over_three_hours_fails_once_decoded(self):
        tt, found = self.audio(1, seconds=meetings.MAX_SECONDS + 1)
        self.upload(found["id"], 0)
        meetings.finish(self.path, found["id"])
        with self.assertRaisesRegex(meetings.MeetingError, "longer than 3 hours"):
            meetings._transcribe(self.path, found["id"])

    def test_a_recording_the_decoder_cannot_read_fails_with_why(self):
        tt, found = self.audio(1)
        self.upload(found["id"], 0)
        meetings.finish(self.path, found["id"])
        with mock.patch.object(meetings, "_decode", side_effect=ValueError("no moov atom")):
            with self.assertRaisesRegex(meetings.MeetingError, "couldn't be read: no moov atom"):
                meetings._transcribe(self.path, found["id"])

    def test_a_host_that_cannot_transcribe_refuses_audio(self):
        _, patch = hermes(is_stt_enabled=lambda cfg: False)
        with patch, self.assertRaises(meetings.MeetingError) as raised:
            meetings.create(self.path, None, "T", None, 1)
        self.assertEqual(raised.exception.status, 501)

    def test_finish_waits_for_every_chunk(self):
        _, found = self.audio(2)
        self.upload(found["id"], 0)
        with self.assertRaisesRegex(meetings.MeetingError, "1 of the 2 chunks"):
            meetings.finish(self.path, found["id"])
        self.upload(found["id"], 1)
        self.assertEqual(meetings.finish(self.path, found["id"])["stage"], "transcribing")

    def test_a_chunk_outside_the_meeting_is_refused(self):
        _, found = self.audio(1)
        for n in (-1, 1):
            with self.assertRaises(meetings.MeetingError):
                self.upload(found["id"], n)
        with self.assertRaises(meetings.MeetingError):
            meetings.add_part(self.path, found["id"], 0, b"", "audio/webm")

    def test_a_chunk_sent_again_replaces_the_first(self):
        _, found = self.audio(1)
        self.upload(found["id"], 0, b"one")
        self.upload(found["id"], 0, b"two")
        files = list(meetings.folder(self.path, found["id"]).glob("part-0.*"))
        self.assertEqual([f.read_bytes() for f in files], [b"two"])

    def test_segments_carry_the_meeting_level_second(self):
        tt, found = self.audio(2)
        with_model(tt, [[Segment(1.2, " Hello "), Segment(8, "there")], [Segment(3, "Back")]])
        self.upload(found["id"], 0)
        self.upload(found["id"], 1)
        meetings.finish(self.path, found["id"])
        meetings._transcribe(self.path, found["id"])
        done = meetings.meeting(self.path, found["id"])
        self.assertEqual(done["stage"], "writing")
        self.assertEqual(
            done["transcript"],
            [{"at": 1, "text": "Hello"}, {"at": 8, "text": "there"}, {"at": 303, "text": "Back"}],
        )
        self.assertEqual(done["duration"], 303)
        self.assertFalse(meetings.folder(self.path, found["id"]).exists())

    def test_the_chunks_are_joined_in_order_and_cut_into_windows(self):
        tt, found = self.audio(2, seconds=700)
        seen = {}

        def decode(file):
            seen["bytes"] = Path(file).read_bytes()
            seen["name"] = Path(file).name
            return bytes(700 * meetings.SAMPLE_RATE)

        with_model(tt, [[], [], []])
        self.upload(found["id"], 1, b"-two")
        self.upload(found["id"], 0, b"one")
        meetings.finish(self.path, found["id"])
        with mock.patch.object(meetings, "_decode", decode), self.assertRaises(meetings.MeetingError):
            meetings._transcribe(self.path, found["id"])
        self.assertEqual(seen, {"bytes": b"one-two", "name": "audio.webm"})
        windows = meetings.meeting(self.path, found["id"])
        self.assertEqual((windows["parts"], windows["parts_done"]), (3, 3))
        self.assertEqual([len(call["window"]) for call in tt.calls], [300 * 16000, 300 * 16000, 100 * 16000])

    def test_each_part_is_prompted_with_the_text_before_it(self):
        tt, found = self.audio(2)
        with_model(tt, [[Segment(0, "We ship Friday")], [Segment(0, "ok")]])
        self.upload(found["id"], 0)
        self.upload(found["id"], 1)
        meetings.finish(self.path, found["id"])
        meetings._transcribe(self.path, found["id"])
        self.assertIsNone(tt.calls[0]["initial_prompt"])
        self.assertEqual(tt.calls[1]["initial_prompt"], "We ship Friday")

    def test_a_window_is_one_segment_when_the_model_cannot_be_reached(self):
        tt, found = self.audio(1, seconds=100)
        tt._get_or_load_local_model = mock.Mock(side_effect=RuntimeError("no model"))
        self.upload(found["id"], 0)
        meetings.finish(self.path, found["id"])
        meetings._transcribe(self.path, found["id"])
        self.assertEqual(meetings.meeting(self.path, found["id"])["transcript"], [{"at": 0, "text": "Hello there."}])

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
        self.upload(found["id"], 0)
        self.upload(found["id"], 1)
        meetings.finish(self.path, found["id"])
        with self.assertRaisesRegex(Exception, "boom"):
            meetings._transcribe(self.path, found["id"])
        meetings._fail(self.path, found["id"], "boom")
        failed = meetings.meeting(self.path, found["id"])
        self.assertEqual((failed["error"], failed["parts_done"], failed["stage"]), ("boom", 1, "transcribing"))
        meetings.retry(self.path, found["id"])
        meetings._transcribe(self.path, found["id"])
        done = meetings.meeting(self.path, found["id"])
        self.assertEqual([line["text"] for line in done["transcript"]], ["One", "Two"])

    def test_a_recording_nobody_spoke_in_fails(self):
        tt, found = self.audio(1, seconds=100)
        with_model(tt, [[]])
        self.upload(found["id"], 0)
        meetings.finish(self.path, found["id"])
        with self.assertRaisesRegex(meetings.MeetingError, "Nobody could be heard"):
            meetings._transcribe(self.path, found["id"])

    def test_retry_needs_a_failure(self):
        _, found = self.audio(1)
        with self.assertRaises(meetings.MeetingError):
            meetings.retry(self.path, found["id"])

    def test_resume_continues_meetings_that_were_transcribing(self):
        _, found = self.audio(1)
        self.upload(found["id"], 0)
        meetings.finish(self.path, found["id"])
        with mock.patch.object(meetings, "spawn") as spawn:
            meetings.resume(self.path)
            meetings.resume(self.path)
        spawn.assert_called_once_with(self.path, found["id"])

    def test_remove_deletes_the_meeting_and_its_audio(self):
        _, found = self.audio(1)
        self.upload(found["id"], 0)
        self.assertIsNotNone(meetings.remove(self.path, found["id"]))
        self.assertIsNone(meetings.meeting(self.path, found["id"]))
        self.assertFalse(meetings.folder(self.path, found["id"]).exists())
        self.assertIsNone(meetings.remove(self.path, found["id"]))

    def test_the_list_is_the_profiles_own(self):
        meetings.create(self.path, "a", "A", None, None, [{"at": 0, "text": "x"}])
        meetings.create(self.path, "b", "B", None, None, [{"at": 0, "text": "x"}])
        self.assertEqual([m["title"] for m in meetings.meetings(self.path, "a")], ["A"])
        self.assertEqual(len(meetings.meetings(self.path)), 2)

    def test_a_host_without_model_calls_refuses_a_meeting(self):
        with mock.patch.object(meetings, "ctx", types.SimpleNamespace(llm=None)):
            with self.assertRaises(meetings.MeetingError) as raised:
                meetings.create(self.path, None, "T", None, None, [{"at": 0, "text": "x"}])
        self.assertEqual(raised.exception.status, 501)

    def written(self, lines, *answers):
        found = meetings.create(self.path, None, "Sync", None, None, lines)
        self.llm.answers.extend(answers)
        meetings._job(self.path, found["id"])
        return meetings.meeting(self.path, found["id"])

    def test_notes_keep_the_stamps_the_transcript_has_and_mark_the_rest(self):
        lines = [{"at": 0, "text": "Ana: ship Friday"}, {"at": 724, "text": "Budget is fixed"}]
        done = self.written(
            lines,
            notes(
                key_points=[
                    {"text": "Ship Friday", "cites": ["[0:00]", "99:99"]},
                    {"text": "Budget is fixed", "cites": ["12:04"]},
                    {"text": "Invented", "cites": ["50:00"]},
                    {"text": "", "cites": ["0:00"]},
                ],
                action_items=[
                    {"text": "Send the plan", "owner": "Ana", "cites": ["0:00"]},
                    {"text": "Book a room", "owner": "Zed", "cites": ["0:00"]},
                ],
            ),
        )
        self.assertEqual(done["stage"], "ready")
        points = done["notes"]["key_points"]
        self.assertEqual([(p["text"], p["cites"], p["unsourced"]) for p in points], [
            ("Ship Friday", ["0:00"], False),
            ("Budget is fixed", ["12:04"], False),
            ("Invented", [], True),
        ])
        self.assertEqual([a["owner"] for a in done["notes"]["action_items"]], ["Ana", meetings.NO_OWNER])
        self.notify.assert_called_once()
        self.assertEqual(self.notify.call_args.args[0], "meeting_done")

    def test_stamps_run_to_hours_after_the_first(self):
        self.assertEqual([meetings.stamp(s) for s in (0, 724, 3724)], ["0:00", "12:04", "1:02:04"])

    def test_a_long_transcript_is_written_in_sections_and_merged(self):
        text = "word " * 780
        lines = [{"at": i * 60, "text": text} for i in range(8)]
        self.assertGreater(len(meetings.sections(lines)), 1)
        piece = notes("Part.", decisions=[{"text": "Go", "cites": ["0:00"]}])
        parts = len(meetings.sections(lines))
        done = self.written(
            lines, *([piece] * parts), notes("Whole.", decisions=[{"text": "Go", "cites": ["0:00", "1:00"]}])
        )
        written = [c for c in self.llm.calls if c["purpose"] != "memento.meetings.topics"]
        self.assertEqual(len(written), parts + 1)
        self.assertEqual(done["notes"]["summary"], "Whole.")
        self.assertEqual(done["notes"]["decisions"][0]["cites"], ["0:00", "1:00"])

    def topic(self, title, start, end, summary="Said.", quote="", quote_at=""):
        return {"title": title, "start": start, "end": end, "summary": summary, "quote": quote, "quote_at": quote_at}

    def test_topics_are_held_to_the_transcript(self):
        lines = [
            {"at": 0, "text": "Let's start with the beta date."},
            {"at": 60, "text": "Thursday works if we freeze Tuesday."},
            {"at": 120, "text": "Now the sidebar."},
            {"at": 200, "text": "Keep it as it is."},
        ]
        raw = {"topics": [
            self.topic("Sidebar", "2:00", "9:99", quote="Keep it", quote_at="3:20"),
            self.topic("Beta", "0:00", "2:00", quote="Thursday works", quote_at="1:00"),
            self.topic("Invented", "50:00", "51:00"),
            self.topic("Overlap", "0:00", "1:00"),
            self.topic("", "1:00", "2:00"),
        ]}
        topics = meetings.check_topics(raw, lines)
        self.assertEqual([t["title"] for t in topics], ["Beta", "Sidebar"])
        self.assertEqual((topics[0]["start"], topics[0]["end"]), (0, 120))
        self.assertEqual(topics[0]["quote"], {"text": "Thursday works", "at": 60})
        # An end that is not a stamp of the transcript falls to the last line.
        self.assertEqual((topics[1]["start"], topics[1]["end"]), (120, 200))
        self.assertEqual(topics[1]["quote"], {"text": "Keep it", "at": 200})

    def test_a_quote_the_line_does_not_say_is_dropped(self):
        lines = [{"at": 0, "text": "Hello there"}, {"at": 30, "text": "Goodbye"}]
        raw = {"topics": [self.topic("All", "0:00", "0:30", quote="We agreed to ship", quote_at="0:30")]}
        self.assertNotIn("quote", meetings.check_topics(raw, lines)[0])

    def test_the_notes_carry_the_topics_and_survive_a_topic_failure(self):
        lines = [{"at": 0, "text": "Alpha"}, {"at": 90, "text": "Beta"}]
        done = self.written(lines, notes("S."), {"topics": [self.topic("A", "0:00", "1:30")]})
        self.assertEqual([t["title"] for t in done["notes"]["topics"]], ["A"])
        again = self.written(lines, notes("S."), ValueError("bad"))
        self.assertEqual(again["stage"], "ready")
        self.assertEqual(again["notes"]["topics"], [])

    def ready(self):
        lines = [
            {"at": 0, "text": "Let's start with the beta date."},
            {"at": 60, "text": "Thursday works if we freeze Tuesday."},
        ]
        found = self.written(lines, notes("S.", decisions=[{"text": "Beta Thursday", "cites": ["1:00"]}]), {"topics": []})
        return found["id"]

    def answered(self, meeting_id, question, *answers):
        self.llm.answers.extend(answers)
        meetings.ask(self.path, meeting_id, question)
        meetings.spawn_answer(self.path, meeting_id)
        for thread in __import__("threading").enumerate():
            if thread.name.startswith("memento-meeting-ask"):
                thread.join(5)
        return meetings.meeting(self.path, meeting_id)["chat"]

    def test_a_question_is_answered_with_the_stamps_the_transcript_has(self):
        meeting_id = self.ready()
        chat = self.answered(meeting_id, " What did we decide? ", {"answer": "Thursday.", "cites": ["[1:00]", "9:99"]})
        self.assertEqual([(c["from"], c["text"], c["cites"]) for c in chat], [
            ("user", "What did we decide?", []),
            ("bot", "Thursday.", ["1:00"]),
        ])
        asked = [c for c in self.llm.calls if c["purpose"] == "memento.meetings.ask"][0]
        self.assertIn("[1:00] Thursday works", asked["input"][0]["text"])

    def test_a_question_that_cannot_be_answered_says_why(self):
        meeting_id = self.ready()
        chat = self.answered(meeting_id, "Anything?", ValueError("bad"), ValueError("bad"))
        self.assertTrue(chat[-1]["text"].startswith("I couldn't answer that:"))

    def test_a_question_needs_a_ready_meeting_and_waits_for_its_answer(self):
        found = meetings.create(self.path, None, "Sync", None, None, [{"at": 0, "text": "x"}])
        with self.assertRaises(meetings.MeetingError) as early:
            meetings.ask(self.path, found["id"], "Why?")
        self.assertEqual(early.exception.status, 409)
        meeting_id = self.ready()
        meetings.ask(self.path, meeting_id, "One?")
        with self.assertRaises(meetings.MeetingError) as busy:
            meetings.ask(self.path, meeting_id, "Two?")
        self.assertEqual(busy.exception.status, 409)
        with self.assertRaises(meetings.MeetingError):
            meetings.ask(self.path, meeting_id, "  ")

    def test_a_long_transcript_is_read_for_the_lines_a_question_names(self):
        filler = "word " * 400
        lines = [{"at": i * 10, "text": filler} for i in range(200)]
        lines[120]["text"] = "The registry needs a status page soon."
        picked = meetings.pick_lines(lines, "Does the registry need a status page?")
        self.assertLess(len(picked), len(lines))
        self.assertIn(lines[120], picked)
        self.assertEqual(picked, sorted(picked, key=lambda line: line["at"]))
        self.assertEqual(meetings.pick_lines(lines[:5], "anything"), lines[:5])

    def test_resume_answers_a_question_a_restart_left_open(self):
        meeting_id = self.ready()
        meetings.ask(self.path, meeting_id, "Open?")
        with mock.patch.object(meetings, "spawn_answer") as answer:
            meetings.resume(self.path)
        answer.assert_called_once_with(self.path, meeting_id)

    def test_a_model_that_never_answers_in_shape_fails_the_meeting(self):
        found = meetings.create(self.path, None, "Sync", None, None, [{"at": 0, "text": "x"}])
        self.llm.answers.extend([ValueError("bad"), ValueError("bad")])
        with self.assertRaises(meetings.MeetingError):
            meetings._job(self.path, found["id"])
        meetings._fail(self.path, found["id"], "bad")
        failed = meetings.meeting(self.path, found["id"])
        self.assertEqual((failed["stage"], failed["error"]), ("writing", "bad"))
        self.assertEqual(self.notify.call_args.args[0], "meeting_failed")
        meetings.retry(self.path, found["id"])
        self.llm.answers.append(notes("Fine."))
        meetings._job(self.path, found["id"])
        self.assertEqual(meetings.meeting(self.path, found["id"])["stage"], "ready")

    def test_resume_continues_a_meeting_that_was_writing(self):
        found = meetings.create(self.path, None, "Sync", None, None, [{"at": 0, "text": "x"}])
        with mock.patch.object(meetings, "spawn") as spawn:
            meetings.resume(self.path)
        spawn.assert_called_once_with(self.path, found["id"])


if __name__ == "__main__":
    unittest.main()
