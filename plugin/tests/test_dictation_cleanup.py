"""Tests for a finished phrase's cleanup (``plugin/dictation_cleanup.py``).

The model is scripted, and these assert the promise a user's text rests on: the tidying the
instructions ask for, the phrase reaching the model with the bot's words spelled as listed, and
every answer that isn't a tidying of the phrase — late, failed, the wrong shape, much longer or
shorter — leaving the phrase exactly as it was heard. No model, no network.
"""

from __future__ import annotations

import time
import types
import unittest
from unittest import mock

from plugin import dictation_cleanup


class FakeLlm:
    """A host model whose ``complete_structured`` answers the next entry, or raises it."""

    def __init__(self, *answers) -> None:
        self.answers = list(answers)
        self.calls = []

    def complete_structured(self, **kwargs):
        self.calls.append(kwargs)
        answer = self.answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return types.SimpleNamespace(parsed=answer)


def with_model(*answers):
    """The plugin's model access, with a scripted model behind it."""
    llm = FakeLlm(*answers)
    return llm, mock.patch.object(
        dictation_cleanup, "ctx", types.SimpleNamespace(llm=llm)
    )


def tidied(phrase, answer, vocabulary=(), **options):
    """What a phrase's cleanup commits: the model's answer, or the phrase as it was heard."""
    llm, patch = with_model(answer)
    with patch:
        return dictation_cleanup.Cleaner(vocabulary, **options)(phrase)


class InstructionsTest(unittest.TestCase):
    """What the bot's model is asked for: the tidying a phrase may get, and never a rewrite."""

    def test_fillers_go_and_like_where_it_compares_stays(self) -> None:
        rules = dictation_cleanup.INSTRUCTIONS
        self.assertIn('"um"', rules)
        self.assertIn('"uh"', rules)
        self.assertIn('"Like" stays where it compares', rules)

    def test_numbers_dates_and_a_spoken_list_are_writing_not_transcript(self) -> None:
        rules = dictation_cleanup.INSTRUCTIONS
        self.assertIn("as digits", rules)
        self.assertIn("25", rules)
        self.assertIn("3 March", rules)
        self.assertIn('"- "', rules)
        self.assertIn("each line", rules)

    def test_the_vocabulary_is_spelled_as_it_is_listed(self) -> None:
        self.assertIn("vocabulary exactly as the vocabulary spells it", dictation_cleanup.INSTRUCTIONS)

    def test_the_phrase_is_never_reworded_or_answered(self) -> None:
        rules = dictation_cleanup.INSTRUCTIONS
        self.assertIn("Never reword", rules)
        self.assertIn("never answer it", rules)

    def test_the_answer_is_one_json_object_holding_the_text(self) -> None:
        self.assertEqual(dictation_cleanup.SCHEMA["type"], "object")
        self.assertEqual(dictation_cleanup.SCHEMA["properties"]["text"]["type"], "string")
        self.assertEqual(dictation_cleanup.SCHEMA["required"], ["text"])
        self.assertIn("{\"text\"", dictation_cleanup.INSTRUCTIONS)

    def test_the_phrase_rides_with_the_bot_s_words_in_front_of_it(self) -> None:
        llm, patch = with_model({"text": "Gots ships it."})
        with patch:
            dictation_cleanup.Cleaner(["Gots", "DeepSeek"])("gots ships it")
        self.assertEqual(
            llm.calls[0]["input"], [{"type": "text", "text": "Vocabulary: Gots DeepSeek\nPhrase: gots ships it"}]
        )

    def test_a_take_with_no_words_asks_without_a_vocabulary_line(self) -> None:
        llm, patch = with_model({"text": "Hello there."})
        with patch:
            dictation_cleanup.Cleaner()("um hello there")
        self.assertEqual(llm.calls[0]["input"][0]["text"], "Phrase: um hello there")

    def test_the_call_is_one_of_the_plugin_s_own(self) -> None:
        llm, patch = with_model({"text": "Hello there."})
        with patch:
            dictation_cleanup.Cleaner()("hello there")
        call = llm.calls[0]
        self.assertEqual(call["purpose"], "memento.dictation.cleanup")
        self.assertEqual(call["temperature"], 0)
        self.assertEqual(call["json_schema"], dictation_cleanup.SCHEMA)


class IsTidyingTest(unittest.TestCase):
    """How much of a phrase an answer may lose or gain and still be a tidying of it."""

    def test_a_phrase_that_lost_its_fillers_is_a_tidying(self) -> None:
        self.assertTrue(
            dictation_cleanup.is_tidying(
                "um let us ship uh the dictation today for the team",
                "Let us ship the dictation today for the team.",
            )
        )

    def test_a_number_written_as_digits_is_a_tidying(self) -> None:
        # Two words become one, which is half of a short phrase: the slack keeps it a tidying.
        self.assertTrue(dictation_cleanup.is_tidying("twenty five", "25"))

    def test_an_answer_much_shorter_than_the_phrase_is_not(self) -> None:
        self.assertFalse(
            dictation_cleanup.is_tidying(
                "let us ship the whole dictation today for the team", "Yes."
            )
        )

    def test_an_answer_much_longer_than_the_phrase_is_not(self) -> None:
        self.assertFalse(
            dictation_cleanup.is_tidying(
                "ship the boat now",
                "Shipping the boat is a good idea, and here is how the crew would do it today.",
            )
        )

    def test_an_empty_answer_is_not_a_tidying(self) -> None:
        self.assertFalse(dictation_cleanup.is_tidying("um uh", ""))
        self.assertFalse(dictation_cleanup.is_tidying("", "Hello."))


class CleanTest(unittest.TestCase):
    """What a phrase commits: the model's tidying, or the words the host heard."""

    def test_a_finished_phrase_comes_back_tidied(self) -> None:
        heard = tidied(
            "um Gots ships twenty five on the third of March",
            {"text": "Gots ships 25 on 3 March."},
            ["Gots"],
        )
        self.assertEqual(heard, "Gots ships 25 on 3 March.")

    def test_like_where_it_compares_is_left_alone(self) -> None:
        # The cleanup keeps what the model answered: what does not reword can't lose a comparison.
        self.assertEqual(
            tidied("it's like a boat uh not a ship", {"text": "It's like a boat, not a ship."}),
            "It's like a boat, not a ship.",
        )

    def test_a_spoken_list_keeps_the_lines_it_was_set_out_on(self) -> None:
        self.assertEqual(
            tidied(
                "buy milk eggs and bread",
                {"text": "Buy:\n- milk\n- eggs\n- bread"},
            ),
            "Buy:\n- milk\n- eggs\n- bread",
        )

    def test_a_listed_name_is_spelled_as_listed(self) -> None:
        # The words ride in the call, so a model that leans on them corrects what the host misheard.
        self.assertEqual(
            tidied("gots is the app", {"text": "Gots is the app."}, ["Gots"]),
            "Gots is the app.",
        )

    def test_a_call_that_misses_its_budget_commits_the_phrase_as_heard(self) -> None:
        def slow(phrase, vocabulary, model):
            time.sleep(0.2)
            return "Tidied."

        started = time.monotonic()
        heard = dictation_cleanup.Cleaner(ask=slow, deadline_s=0.02)("um hello there")
        self.assertEqual(heard, "um hello there")
        self.assertLess(time.monotonic() - started, 0.2, "the phrase did not wait for the model")

    def test_a_call_that_raises_commits_the_phrase_as_heard(self) -> None:
        self.assertEqual(
            tidied("um hello there", RuntimeError("the host's model is down")), "um hello there"
        )

    def test_a_call_that_answers_in_the_wrong_shape_commits_the_phrase_as_heard(self) -> None:
        self.assertEqual(tidied("um hello there", None), "um hello there")
        self.assertEqual(tidied("um hello there", {"words": "Hello there."}), "um hello there")
        self.assertEqual(tidied("um hello there", {"text": 7}), "um hello there")

    def test_an_answer_much_longer_than_the_phrase_is_discarded(self) -> None:
        self.assertEqual(
            tidied(
                "ship the boat now",
                {"text": "Ship the boat now, and while you are at it tidy the deck and the sails."},
            ),
            "ship the boat now",
        )

    def test_an_answer_much_shorter_than_the_phrase_is_discarded(self) -> None:
        self.assertEqual(
            tidied(
                "let us ship the whole dictation today for the team",
                {"text": "Ship it."},
            ),
            "let us ship the whole dictation today for the team",
        )

    def test_a_host_that_cannot_make_model_calls_commits_the_phrase_as_heard(self) -> None:
        with mock.patch.object(dictation_cleanup, "ctx", None):
            self.assertEqual(dictation_cleanup.Cleaner()("um hello there"), "um hello there")

    def test_an_empty_phrase_asks_nothing(self) -> None:
        llm, patch = with_model()
        with patch:
            self.assertEqual(dictation_cleanup.Cleaner()("  "), "  ")
        self.assertEqual(llm.calls, [])

    def test_every_phrase_costs_one_call(self) -> None:
        llm, patch = with_model({"text": "One."}, {"text": "Two."})
        cleaner = dictation_cleanup.Cleaner()
        with patch:
            self.assertEqual([cleaner("um one"), cleaner("um two")], ["One.", "Two."])
        self.assertEqual(len(llm.calls), 2)

    def test_a_picked_model_answers_and_its_failure_falls_back_to_the_bot_s_own(self) -> None:
        # The seam the Dictation tab's pick fits into (#295): the pick is asked first, and a host
        # that refuses it still tidies the phrase on the bot's own model.
        llm, patch = with_model(RuntimeError("override denied"), {"text": "Hello there."})
        cleaner = dictation_cleanup.Cleaner(model={"provider": "acme", "model": "fast"})
        with patch:
            self.assertEqual(cleaner("um hello there"), "Hello there.")
        self.assertEqual((llm.calls[0]["provider"], llm.calls[0]["model"]), ("acme", "fast"))
        self.assertNotIn("provider", llm.calls[1])
        self.assertNotIn("model", llm.calls[1])

    def test_a_pick_that_is_not_a_provider_and_model_is_not_passed_on(self) -> None:
        llm, patch = with_model({"text": "Hello there."})
        with patch:
            dictation_cleanup.Cleaner(model={"temperature": 2, "model": "fast"})("um hello there")
        self.assertEqual(llm.calls[0]["model"], "fast")
        self.assertEqual(llm.calls[0]["temperature"], 0)


if __name__ == "__main__":
    unittest.main()
