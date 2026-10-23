"""Tests for a dictation heard while it is spoken (``plugin/dictation_stream.py``).

The transcriber and the decoder are injected, so these assert the take's own promises and nothing
about faster-whisper: what a window commits, what a pause closes, what a quiet take does, how a
decode that fails reads, and how a slow host paces itself. No model, no audio, no network.
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from plugin import dictation, dictation_cleanup, dictation_stream, speech
from plugin.tests.test_dictation import hermes
from plugin.tests.test_dictation_cleanup import FakeLlm

SLICE_S = 0.25
RATE = 16000


class Clock:

    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class Scripted:

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
    answers = []
    for index in range(count):
        clock.advance(SLICE_S)
        answers.append(heard.add(b"opus", pause=pause and index == count - 1))
    return answers


class Tidy:

    def __init__(self, *answers, error=None) -> None:
        self.answers = list(answers)
        self.error = error
        self.calls = []

    def __call__(self, text):
        self.calls.append(text)
        if self.error is not None:
            raise self.error
        return self.answers.pop(0) if self.answers else text


class AgreeTest(unittest.TestCase):
    def test_two_hypotheses_agree_up_to_their_first_difference(self) -> None:
        self.assertEqual(dictation_stream.agree(["a", "b", "c"], ["a", "b", "d"]), ["a", "b"])
        self.assertEqual(dictation_stream.agree([], ["a"]), [])
        self.assertEqual(dictation_stream.agree(["a"], ["b"]), [])
        self.assertEqual(dictation_stream.agree(["a", "b"], ["a", "b"]), ["a", "b"])

    def test_windows_that_share_nothing_agree_on_nothing(self) -> None:
        self.assertEqual(dictation_stream.agree(["let", "us", "ship"], ["so", "then"]), [])

    def test_a_repeated_phrase_is_agreed_word_for_word(self) -> None:
        self.assertEqual(
            dictation_stream.agree(["no", "no", "no", "more"], ["no", "no", "no", "more"]),
            ["no", "no", "no", "more"],
        )

    def test_a_revision_of_only_the_last_word_agrees_short_of_it(self) -> None:
        self.assertEqual(
            dictation_stream.agree(
                ["let", "us", "ship", "the", "boat"], ["let", "us", "ship", "the", "bait"]
            ),
            ["let", "us", "ship", "the"],
        )


class SettledTest(unittest.TestCase):
    def test_the_newest_word_two_windows_agree_on_is_held_back(self) -> None:
        self.assertEqual(dictation_stream.settled(["a", "b"], ["a", "b", "c"]), ["a"])
        self.assertEqual(dictation_stream.settled(["a"], ["a", "b"]), [])
        self.assertEqual(dictation_stream.settled([], ["a", "b"]), [])

    def test_windows_that_share_nothing_settle_nothing(self) -> None:
        self.assertEqual(dictation_stream.settled(["let", "us"], ["so", "then"]), [])

    def test_a_repeated_phrase_settles_all_but_its_last_word(self) -> None:
        self.assertEqual(
            dictation_stream.settled(
                ["go", "go", "go", "go", "and"], ["go", "go", "go", "go", "and"]
            ),
            ["go", "go", "go", "go"],
        )

    def test_a_revision_of_the_last_word_holds_the_agreement_before_it(self) -> None:
        self.assertEqual(
            dictation_stream.settled(
                ["we", "ship", "the", "boat"], ["we", "ship", "the", "bait"]
            ),
            ["we", "ship"],
        )
        self.assertEqual(
            dictation_stream.settled(["we", "ship", "the"], ["we", "ship", "it"]), ["we"]
        )
        self.assertEqual(dictation_stream.settled(["we", "ship"], ["we", "ship", "the"]), ["we"])


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

    def test_a_window_that_only_re_heard_committed_words_adds_nothing(self) -> None:
        self.assertEqual(dictation_stream.newly_committed(["a", "b", "c", "d"], ["a", "b"]), [])
        self.assertEqual(
            dictation_stream.newly_committed(
                ["let", "us", "ship", "the"], ["let", "us", "ship", "the"]
            ),
            [],
        )

    def test_a_window_that_starts_inside_the_committed_words_adds_only_what_follows(self) -> None:
        self.assertEqual(
            dictation_stream.newly_committed(
                ["one", "two", "three", "four"], ["three", "four", "five", "six"]
            ),
            ["five", "six"],
        )

    def test_a_close_that_re_hears_a_long_run_still_adds_only_what_follows(self) -> None:
        known = [f"w{index}" for index in range(100)]
        stable = [f"w{index}" for index in range(20, 120)]
        self.assertEqual(
            dictation_stream.newly_committed(known, stable),
            [f"w{index}" for index in range(100, 120)],
        )

    def test_a_close_whose_first_word_is_a_fragment_commits_only_what_follows(self) -> None:
        self.assertEqual(
            dictation_stream.newly_committed(
                ["and", "then"], ["an", "then", "more"], revise_head=True
            ),
            ["more"],
        )

    def test_a_hop_keeps_the_exact_rule_the_close_alone_relaxes(self) -> None:
        self.assertEqual(
            dictation_stream.newly_committed(["and", "then"], ["an", "then", "more"]),
            ["an", "then", "more"],
        )


class WindowTest(unittest.TestCase):
    def test_a_word_is_committed_once_windows_after_it_have_stopped_moving_it(self) -> None:
        scripted = Scripted(["hello there", "hello there my friend", "hello there my friend how"])
        heard, _, clock = take(scripted)
        answers = push(heard, clock, count=6)
        self.assertEqual(
            [answer["words"] for answer in answers], ["", "", "", "hello", "", "there my"]
        )
        self.assertEqual(heard.committed, ["hello", "there", "my"])

    def test_a_word_the_take_has_committed_is_never_taken_back(self) -> None:
        scripted = Scripted(
            [
                "let us ship the dictation",
                "let us ship the dictation today",
                "let us ship the dictionary today",
                "let us ship the dictionary today",
            ]
        )
        heard, _, clock = take(scripted)
        seen = [heard.committed]
        for _ in range(8):
            clock.advance(SLICE_S)
            heard.add(b"opus")
            seen.append(heard.committed)
        for before, after in zip(seen, seen[1:]):
            self.assertEqual(after[: len(before)], before, after)
        self.assertEqual(heard.committed[:4], ["let", "us", "ship", "the"])

    def test_a_phrase_s_close_commits_the_words_the_windows_were_holding_back(self) -> None:
        scripted = Scripted(
            [
                "let us ship the dictation",
                "let us ship the dictation today",
                "let us ship the dictation today",
            ]
        )
        heard, _, clock = take(scripted)
        push(heard, clock, count=4)
        self.assertEqual(heard.committed, ["let", "us", "ship", "the"])
        answer = heard.add(b"opus", pause=True)
        self.assertEqual(
            [phrase["text"] for phrase in answer["phrases"]], ["let us ship the dictation today"]
        )
        self.assertEqual(heard.committed, ["let", "us", "ship", "the", "dictation", "today"])

    def test_a_slice_with_no_new_window_answers_without_asking_the_model(self) -> None:
        scripted = Scripted(["hello there"] * 5)
        heard, _, clock = take(scripted)
        heard.add(b"opus")
        clock.advance(0.1)
        answer = heard.add(b"opus")
        self.assertEqual(scripted.calls, [])
        self.assertEqual(answer, {"words": "", "phrases": [], "behind": False})

    def test_the_window_is_the_last_few_seconds_and_carries_what_was_heard_before_it(self) -> None:
        scripted = Scripted(["hello there", "hello there friend", "hello there friend of mine"])
        heard, _, clock = take(scripted, hint="Gots", window_s=1.0)
        push(heard, clock, count=8)
        self.assertLessEqual(len(scripted.calls[-1]["samples"]), RATE + 1)
        self.assertTrue(scripted.calls[-1]["prompt"].startswith("Gots"))
        self.assertEqual(heard.committed, ["hello", "there"])
        self.assertTrue(scripted.calls[-1]["prompt"].endswith("hello there"))


class PhraseTest(unittest.TestCase):
    def test_a_pause_closes_the_phrase_the_take_has_heard(self) -> None:
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

    def test_two_phrases_meet_without_losing_or_doubling_the_words_between_them(self) -> None:
        scripted = Scripted(
            [
                "let us ship the dictation",
                "let us ship the dictation",
                "let us ship the dictation",
                "dictation today",
                "dictation today and then some",
            ]
        )
        heard, _, clock = take(scripted)
        push(heard, clock, count=4)
        heard.add(b"opus", pause=True)
        push(heard, clock, count=3)
        heard.add(b"opus", pause=True)
        self.assertEqual(
            [phrase["text"] for phrase in heard.phrases],
            ["let us ship the dictation", "today and then some"],
        )
        self.assertEqual(
            " ".join(phrase["text"] for phrase in heard.phrases),
            "let us ship the dictation today and then some",
        )

    def test_a_pause_with_nothing_new_closes_no_phrase(self) -> None:
        heard, _, clock = take(Scripted([]))
        clock.advance(SLICE_S)
        self.assertEqual(heard.add(b"opus", pause=True)["phrases"], [])


    def test_a_closed_phrase_lets_its_audio_go_keeping_only_the_next_overlap(self) -> None:
        scripted = Scripted(["hello there my friend", "hello there my friend"])
        heard, _, clock = take(scripted)
        push(heard, clock, count=8, pause=True)
        self.assertLessEqual(
            heard.buffered, int(dictation_stream.OVERLAP_S * heard.rate) + len(slice_samples())
        )


class CleanupTest(unittest.TestCase):

    def test_a_finished_phrase_is_committed_as_its_tidied_text(self) -> None:
        tidy = Tidy("Hello there, my friend.")
        heard, _, clock = take(Scripted(["um hello there my friend"] * 6), clean=tidy)
        push(heard, clock, count=5)
        answer = heard.add(b"opus", pause=True)
        self.assertEqual(
            [phrase["text"] for phrase in answer["phrases"]], ["Hello there, my friend."]
        )
        self.assertEqual(tidy.calls, ["um hello there my friend"])
        self.assertEqual(heard.committed, ["um", "hello", "there", "my", "friend"])

    def test_the_tail_phrase_is_tidied_before_stop_answers_with_it(self) -> None:
        heard, _, clock = take(Scripted(["um hello there"] * 4), clean=Tidy("Hello there."))
        push(heard, clock, count=2)
        self.assertEqual(
            [phrase["text"] for phrase in heard.stop()["phrases"]], ["Hello there."]
        )

    def test_a_phrase_is_tidied_once_and_never_again(self) -> None:
        tidy = Tidy("Hello there, my friend.", "And then some.")
        heard, _, clock = take(
            Scripted(["um hello there my friend"] * 3 + ["and then some"] * 4), clean=tidy
        )
        push(heard, clock, count=5)
        first = heard.add(b"opus", pause=True)["phrases"][0]
        push(heard, clock, count=4)
        heard.add(b"opus", pause=True)
        heard.stop()
        self.assertEqual(
            [phrase["text"] for phrase in heard.phrases],
            ["Hello there, my friend.", "And then some."],
        )
        self.assertEqual(len(tidy.calls), 2, "one call for each phrase, and none for the take")
        self.assertEqual(heard.phrases[0], first)

    def test_a_cleanup_that_raises_leaves_the_phrase_as_it_was_heard(self) -> None:
        heard, _, clock = take(
            Scripted(["um hello there my friend"] * 3 + ["and then some"] * 5),
            clean=Tidy(error=RuntimeError("the host's model is down")),
        )
        push(heard, clock, count=5)
        answer = heard.add(b"opus", pause=True)
        self.assertEqual(
            [phrase["text"] for phrase in answer["phrases"]], ["um hello there my friend"]
        )
        push(heard, clock, count=3)
        self.assertEqual(
            [phrase["text"] for phrase in heard.stop()["phrases"]], ["and then some"]
        )

    def test_a_cleanup_that_answers_nothing_leaves_the_phrase_as_it_was_heard(self) -> None:
        heard, _, clock = take(Scripted(["um hello there my friend"] * 6), clean=Tidy(""))
        push(heard, clock, count=5)
        answer = heard.add(b"opus", pause=True)
        self.assertEqual(
            [phrase["text"] for phrase in answer["phrases"]], ["um hello there my friend"]
        )

    def test_a_take_s_cleanup_is_asked_with_its_own_words(self) -> None:
        llm = FakeLlm({"text": "Gots ships it."})
        with mock.patch.object(dictation_cleanup, "ctx", mock.Mock(llm=llm)):
            heard, _, clock = take(Scripted(["gots ships it"] * 4), vocabulary=["Gots"])
            push(heard, clock, count=2)
            answer = heard.stop()
        self.assertEqual([phrase["text"] for phrase in answer["phrases"]], ["Gots ships it."])
        self.assertIn("Vocabulary: Gots", llm.calls[0]["input"][0]["text"])


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
        push(heard, clock, count=4)
        self.assertEqual(len(scripted.calls), 1)
        clock.advance(2.0)
        heard.add(b"opus")
        self.assertEqual(len(scripted.calls), 2)

    def test_a_decode_slower_than_the_audio_it_covers_says_it_is_behind(self) -> None:
        clock = Clock()
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


class VocabularyTest(unittest.TestCase):

    def test_every_window_of_a_take_carries_the_bot_s_words(self) -> None:
        scripted = Scripted(["hello there", "hello there my friend", "hello there my friend how"])
        heard, _, clock = take(scripted, vocabulary=["Gots", "DeepSeek"])
        push(heard, clock, count=5)
        heard.add(b"opus", pause=True)
        heard.stop()
        self.assertGreaterEqual(len(scripted.calls), 4)
        for call in scripted.calls:
            self.assertIn("Gots DeepSeek", call["prompt"])

    def test_a_listed_name_is_heard_as_it_is_spelled(self) -> None:
        # A decoder that leans on its prompt, as Whisper does: with the name in front of it, it
        # writes the name; without it, it hears the common word. This is the spelling promise with
        # a scripted model in place of a real one.
        def leaning(samples, prompt):
            return "Gots ships it" if "Gots" in prompt else "gots ships it"

        heard, _, clock = take(leaning, vocabulary=["Gots"])
        push(heard, clock, count=5)
        heard.add(b"opus", pause=True)
        self.assertEqual(heard.phrases[-1]["text"], "Gots ships it")

    def test_the_host_s_prompt_comes_first_and_the_heard_tail_last(self) -> None:
        scripted = Scripted(["hello there friend", "hello there friend how"])
        heard, _, clock = take(scripted, hint="Gots, the chat", vocabulary=["Haseeb"], window_s=1.0)
        push(heard, clock, count=8)
        prompt = scripted.calls[-1]["prompt"]
        self.assertTrue(prompt.startswith("Gots, the chat Haseeb"))
        self.assertTrue(prompt.endswith("hello there"))

    def test_a_take_with_no_words_prompts_as_it_did_before(self) -> None:
        scripted = Scripted(["hello there friend", "hello there friend how"])
        heard, _, clock = take(scripted, hint="Gots")
        push(heard, clock, count=8)
        self.assertTrue(scripted.calls[-1]["prompt"].startswith("Gots hello there"))


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

    def test_a_take_carries_the_words_the_start_was_given(self) -> None:
        _, patch = hermes()
        profiles = dictation_stream.Takes()
        with patch:
            started = dictation_stream.start(
                profiles, "haseeb", "Gots", ["Gots", " gots ", "DeepSeek"]
            )
        heard = profiles.get("haseeb", started["take"])
        self.assertEqual(heard.vocabulary, ["Gots", "DeepSeek"])
        self.assertIn("Gots DeepSeek", heard._prompt())

    def test_a_take_carries_the_cleanup_model_it_was_opened_with(self) -> None:
        # The seam the Dictation tab's pick fits into (#295): the take's cleaner holds the model,
        # and the bot's own model is what answers without one.
        _, patch = hermes()
        profiles = dictation_stream.Takes()
        with patch:
            started = dictation_stream.start(
                profiles, "haseeb", "Gots", [], {"provider": "acme", "model": "fast"}
            )
        heard = profiles.get("haseeb", started["take"])
        self.assertEqual(heard._clean.model, {"provider": "acme", "model": "fast"})

    def test_a_take_with_no_cleanup_model_tidies_on_the_bot_s_own(self) -> None:
        _, patch = hermes()
        profiles = dictation_stream.Takes()
        with patch:
            started = dictation_stream.start(profiles, "haseeb", "Gots", [])
        heard = profiles.get("haseeb", started["take"])
        self.assertIsNone(heard._clean.model)

    def test_a_pick_that_will_not_load_fails_the_take_with_the_host_s_reason(self) -> None:
        _, patch = hermes()
        profiles = dictation_stream.Takes()

        def warm(model=None):
            if model == "small":
                return {"warmed": False, "error": "the model's file is corrupt"}
            return {"warmed": True, "model": model}

        with patch, mock.patch.object(dictation, "warm", warm):
            with self.assertRaises(speech.SpeechError) as caught:
                dictation_stream.start(profiles, "haseeb", "Gots", [], None)
        self.assertEqual(caught.exception.status, 502)
        self.assertIn("corrupt", str(caught.exception))

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
