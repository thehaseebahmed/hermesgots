"""Tests for a dictation heard while it is spoken (``plugin/dictation_stream.py``).

The transcriber and the decoder are injected, so these assert the take's own promises and nothing
about faster-whisper: what a window commits, what a pause closes, what a quiet take does, how a
decode that fails reads, and how a slow host paces itself. No model, no audio, no network.
"""

from __future__ import annotations

import unittest
from unittest import mock

from plugin import dictation, dictation_stream
from plugin.tests.test_dictation import hermes

SLICE_S = 0.25
RATE = 16000


class Clock:
    """A clock a test moves by hand, so pacing and expiry are rules rather than sleeps."""

    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class Scripted:
    """A transcriber that answers the next hypothesis it was given, and can take its time."""

    def __init__(self, answers, clock: Clock = None, took: float = 0.0) -> None:
        self.answers = list(answers)
        self.clock = clock
        self.took = took
        self.calls = []

    def __call__(self, samples, prompt):
        self.calls.append({"samples": list(samples), "prompt": prompt})
        if self.clock is not None and self.took:
            self.clock.advance(self.took)
        if not self.answers:
            return ""
        answer = self.answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer


def slice_samples(seconds: float = SLICE_S) -> list:
    return [0.0] * int(seconds * RATE)


def take(transcribe=None, clock: Clock = None, **options):
    clock = clock or Clock()
    heard = transcribe or Scripted([])
    return (
        dictation_stream.Take(
            heard,
            lambda data, first: slice_samples(),
            clock=clock,
            **options,
        ),
        heard,
        clock,
    )


def push(heard: dictation_stream.Take, clock: Clock, count: int = 1, pause: bool = False) -> list:
    """Slices the app would send, a quarter of a second apart."""
    answers = []
    for index in range(count):
        clock.advance(SLICE_S)
        answers.append(heard.add(b"opus", pause=pause and index == count - 1))
    return answers


class AgreeTest(unittest.TestCase):
    def test_two_hypotheses_agree_up_to_their_first_difference(self) -> None:
        self.assertEqual(dictation_stream.agree(["a", "b", "c"], ["a", "b", "d"]), ["a", "b"])
        self.assertEqual(dictation_stream.agree([], ["a"]), [])
        self.assertEqual(dictation_stream.agree(["a"], ["b"]), [])
        self.assertEqual(dictation_stream.agree(["a", "b"], ["a", "b"]), ["a", "b"])


class NewlyCommittedTest(unittest.TestCase):
    def test_a_stable_text_that_starts_at_the_committed_words_adds_what_follows(self) -> None:
        self.assertEqual(
            dictation_stream.newly_committed(["hello", "there"], ["hello", "there", "my", "friend"]),
            ["my", "friend"],
        )

    def test_a_window_that_rolled_past_them_commits_all_of_itself(self) -> None:
        self.assertEqual(
            dictation_stream.newly_committed(["hello", "there"], ["my", "friend"]),
            ["my", "friend"],
        )

    def test_nothing_new_is_committed_twice(self) -> None:
        self.assertEqual(dictation_stream.newly_committed(["a", "b"], ["a", "b"]), [])
        self.assertEqual(dictation_stream.newly_committed([], ["a", "b"]), ["a", "b"])


class WindowTest(unittest.TestCase):
    def test_the_words_two_windows_agree_on_are_the_words_committed(self) -> None:
        scripted = Scripted(["hello there", "hello there my friend", "hello there my friend how"])
        heard, _, clock = take(scripted)
        answers = push(heard, clock, count=6)
        # The first window has nothing to agree with, so it commits nothing; each later one commits
        # only the words it shares with the one before it.
        self.assertEqual([answer["words"] for answer in answers], ["", "", "", "hello there", "", "my friend"])
        self.assertEqual(heard.committed, ["hello", "there", "my", "friend"])

    def test_a_slice_with_no_new_window_answers_without_asking_the_model(self) -> None:
        scripted = Scripted(["hello there"] * 5)
        heard, _, clock = take(scripted)
        heard.add(b"opus")
        clock.advance(0.1)
        answer = heard.add(b"opus")
        self.assertEqual(scripted.calls, [])
        self.assertEqual(answer, {"words": "", "phrases": [], "behind": False})

    def test_the_window_is_the_last_few_seconds_and_carries_what_was_heard_before_it(self) -> None:
        scripted = Scripted(["hello there", "hello there friend"])
        heard, _, clock = take(scripted, hint="Gots", window_s=1.0)
        push(heard, clock, count=8)
        # A one-second window is 16000 samples of the take's 8 slices, never the whole take.
        self.assertLessEqual(len(scripted.calls[-1]["samples"]), RATE + 1)
        self.assertTrue(scripted.calls[-1]["prompt"].startswith("Gots"))
        self.assertTrue(scripted.calls[-1]["prompt"].endswith("hello there"))


class PhraseTest(unittest.TestCase):
    def test_a_pause_closes_the_phrase_the_take_has_heard(self) -> None:
        # Two windows commit the words they agree on; the pause decodes the phrase whole, which is
        # the answer "hello there my friend" for a take that only got as far as that.
        scripted = Scripted(["hello there", "hello there my friend", "hello there my friend"])
        heard, _, clock = take(scripted)
        push(heard, clock, count=5)
        answer = heard.add(b"opus", pause=True)
        self.assertEqual([phrase["text"] for phrase in answer["phrases"]], ["hello there my friend"])
        self.assertEqual(heard.phrases[0]["id"], 1)

    def test_the_next_phrase_does_not_repeat_the_words_before_it(self) -> None:
        scripted = Scripted(
            [
                "hello there",
                "hello there my friend",
                "hello there my friend",
                "hello there my friend how",
                # The phrase starts a little before the pause, so it hears a word or two of the
                # one before it and commits only what follows them.
                "my friend how are you today",
            ]
        )
        heard, _, clock = take(scripted)
        push(heard, clock, count=5)
        heard.add(b"opus", pause=True)
        last = heard.phrases[-1]
        push(heard, clock, count=3)
        answer = heard.add(b"opus", pause=True)
        self.assertEqual([phrase["text"] for phrase in answer["phrases"]], ["how are you today"])
        self.assertEqual(heard.phrases[0], last)

    def test_a_pause_with_nothing_new_closes_no_phrase(self) -> None:
        heard, _, clock = take(Scripted([]))
        clock.advance(SLICE_S)
        self.assertEqual(heard.add(b"opus", pause=True)["phrases"], [])


class StopTest(unittest.TestCase):
    def test_a_stop_before_any_audio_answers_nothing_and_lets_the_take_go(self) -> None:
        heard, _, _ = take()
        self.assertEqual(heard.stop(), {"words": "", "phrases": [], "behind": False})
        self.assertTrue(heard.dropped)
        with self.assertRaises(dictation_stream.TakeError) as caught:
            heard.add(b"opus")
        self.assertEqual(caught.exception.status, 410)

    def test_a_stop_finishes_the_tail_phrase(self) -> None:
        scripted = Scripted(["hello there", "hello there my friend"])
        heard, _, clock = take(scripted)
        push(heard, clock, count=2)
        answer = heard.stop()
        self.assertEqual([phrase["text"] for phrase in answer["phrases"]], ["hello there my friend"])
        self.assertTrue(heard.dropped)

    def test_a_cancel_lets_everything_go_at_once(self) -> None:
        heard, _, clock = take(Scripted(["hello there"]))
        push(heard, clock, count=3)
        self.assertGreater(heard.buffered, 0)
        heard.cancel()
        self.assertEqual(heard.buffered, 0)
        self.assertTrue(heard.dropped)


class ExpiryTest(unittest.TestCase):
    def test_a_take_that_hears_nothing_for_fifteen_seconds_is_dropped(self) -> None:
        heard, _, clock = take()
        clock.advance(14.0)
        self.assertFalse(heard.expired())
        clock.advance(2.0)
        self.assertTrue(heard.expired())

    def test_audio_keeps_a_take_alive(self) -> None:
        heard, _, clock = take(Scripted([]))
        clock.advance(10.0)
        heard.add(b"opus")
        clock.advance(10.0)
        self.assertFalse(heard.expired())


class TakesTest(unittest.TestCase):
    def test_only_one_take_is_heard_per_profile(self) -> None:
        profiles = dictation_stream.Takes()
        clock = Clock()
        first = dictation_stream.Take(Scripted([]), clock=clock)
        profiles.open("haseeb", first)
        with self.assertRaises(dictation_stream.TakeError) as caught:
            profiles.open("haseeb", dictation_stream.Take(Scripted([]), clock=clock))
        self.assertEqual(caught.exception.status, 409)
        # Another profile hears its own take.
        profiles.open("someone-else", dictation_stream.Take(Scripted([]), clock=clock))

    def test_a_quiet_take_is_swept_and_its_audio_let_go(self) -> None:
        clock = Clock()
        profiles = dictation_stream.Takes(clock=clock)
        heard = dictation_stream.Take(
            Scripted([]), lambda data, first: slice_samples(), clock=clock
        )
        profiles.open("haseeb", heard)
        heard.add(b"opus")
        self.assertGreater(heard.buffered, 0)
        clock.advance(dictation_stream.QUIET_S + 1)
        self.assertEqual(profiles.sweep(), 0)
        self.assertTrue(heard.dropped)
        self.assertEqual(heard.buffered, 0)
        with self.assertRaises(dictation_stream.TakeError):
            profiles.get("haseeb", heard.id)

    def test_a_take_that_ended_is_not_answered_again(self) -> None:
        profiles = dictation_stream.Takes()
        clock = Clock()
        heard = dictation_stream.Take(Scripted([]), clock=clock)
        profiles.open("haseeb", heard)
        self.assertIs(profiles.get("haseeb", heard.id), heard)
        with self.assertRaises(dictation_stream.TakeError) as caught:
            profiles.get("haseeb", "dt-someone-else")
        self.assertEqual(caught.exception.status, 410)
        profiles.release("haseeb", heard)
        with self.assertRaises(dictation_stream.TakeError):
            profiles.get("haseeb", heard.id)


class PacingTest(unittest.TestCase):
    def test_a_slow_decode_stretches_the_hop_instead_of_building_a_backlog(self) -> None:
        clock = Clock()
        scripted = Scripted(["hello there", "hello there friend"], clock=clock, took=2.0)
        heard, _, _ = take(scripted, clock=clock)
        push(heard, clock, count=2)
        self.assertEqual(heard.committed, [])  # the first window has nothing to agree with
        self.assertEqual(len(scripted.calls), 1)
        # The hop is now the decode's own two seconds, so the next window is not due at two slices.
        push(heard, clock, count=4)
        self.assertEqual(len(scripted.calls), 1)
        clock.advance(2.0)
        heard.add(b"opus")
        self.assertEqual(len(scripted.calls), 2)

    def test_a_decode_slower_than_the_audio_it_covers_says_it_is_behind(self) -> None:
        clock = Clock()
        # A four-second window, and a decode that takes five.
        scripted = Scripted(["hello there", "hello there friend"], clock=clock, took=5.0)
        heard, _, _ = take(scripted, clock=clock)
        push(heard, clock, count=2)
        self.assertTrue(heard.behind)
        self.assertTrue(heard.behind)

    def test_a_decode_that_keeps_up_does_not_say_it_is_behind(self) -> None:
        clock = Clock()
        scripted = Scripted(["hello there", "hello there friend"], clock=clock, took=0.2)
        heard, _, _ = take(scripted, clock=clock)
        push(heard, clock, count=2)
        self.assertFalse(heard.behind)


class FailureTest(unittest.TestCase):
    def test_a_slice_that_cannot_be_decoded_is_that_slice_s_failure(self) -> None:
        def broken(data, first):
            raise ValueError("bad container")

        clock = Clock()
        heard = dictation_stream.Take(Scripted(["hello there"]), broken, clock=clock)
        with self.assertRaises(dictation_stream.TakeError) as caught:
            push(heard, clock, count=1)
        self.assertEqual(caught.exception.status, 502)
        self.assertFalse(heard.dropped)

    def test_a_transcriber_that_raises_leaves_the_take_able_to_finish(self) -> None:
        clock = Clock()
        scripted = Scripted(
            [dictation.DictationError("CUDA out of memory"), "hello there", "hello there"],
            clock=clock,
        )
        heard, _, _ = take(scripted, clock=clock)
        push(heard, clock, count=1)
        with self.assertRaises(dictation.DictationError):
            push(heard, clock, count=1)
        push(heard, clock, count=2)
        answer = heard.stop()
        self.assertEqual([phrase["text"] for phrase in answer["phrases"]], ["hello there"])


class StartTest(unittest.TestCase):
    def test_a_take_reports_the_host_s_model_and_language(self) -> None:
        _, patch = hermes()
        profiles = dictation_stream.Takes()
        with patch:
            started = dictation_stream.start(profiles, "haseeb", "Gots")
        self.assertTrue(started["ready"])
        self.assertEqual((started["model"], started["language"]), ("small", "en"))
        self.assertTrue(started["take"].startswith("dt-"))
        self.assertIs(profiles.get("haseeb", started["take"]).__class__, dictation_stream.Take)

    def test_a_host_that_cannot_dictate_refuses_the_take(self) -> None:
        _, patch = hermes(_load_stt_config=lambda: {"enabled": False})
        profiles = dictation_stream.Takes()
        with patch, self.assertRaises(dictation.DictationError) as caught:
            dictation_stream.start(profiles, "haseeb")
        self.assertEqual(caught.exception.status, 409)

    def test_a_model_that_will_not_load_is_an_error_rather_than_a_take(self) -> None:
        _, patch = hermes(_get_or_load_local_model=mock.Mock(side_effect=RuntimeError("no disk")))
        profiles = dictation_stream.Takes()
        with patch, self.assertRaises(dictation.DictationError) as caught:
            dictation_stream.start(profiles, "haseeb")
        self.assertEqual(caught.exception.status, 502)

    def test_the_host_s_language_is_pinned_for_the_take(self) -> None:
        calls = []

        def transcribe(path, model, prompt=None, language=None):
            with open(path, "rb") as file:
                calls.append({"bytes": len(file.read()), "prompt": prompt, "language": language})
            return {"success": True, "transcript": "hello there"}

        tt, patch = hermes(_transcribe_local=transcribe)
        with patch:
            heard = dictation_stream.transcriber(tt, "small", "en")([0.0] * 16000, "Gots")
        self.assertEqual(calls[0]["language"], "en")
        self.assertEqual(calls[0]["prompt"], "Gots")
        self.assertGreater(calls[0]["bytes"], 44)
        self.assertEqual(heard, "hello there")

    def test_a_host_without_a_language_argument_still_hears(self) -> None:
        tt, patch = hermes()
        with patch:
            heard = dictation_stream.transcriber(tt, "small", "en")([0.0] * 16000, "")
        self.assertEqual(heard, "Hello there.")


if __name__ == "__main__":
    unittest.main()
