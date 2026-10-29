"""Tests for a finished dictation's cleanup (``plugin/dictation_cleanup.py``, ADR 0066).

The model is scripted, and these assert what a level promises rather than how it is spelled: the
rules its prompt carries, the deadline and answer budget it sets, the bounds its answer is held to,
and that a call which fails, misses its budget or answers outside those bounds leaves the words
exactly as they were heard. The level that makes no call is asserted to make none. No model, no
network.
"""

from __future__ import annotations

import dataclasses
import time
import unittest
from unittest import mock

from plugin import dictation_cleanup
from plugin.tests._helpers import with_model

LIGHT = dictation_cleanup.DictationCleanupPrompt.WithLightCleanup()
MEDIUM = dictation_cleanup.DictationCleanupPrompt.WithMediumCleanup()
HIGH = dictation_cleanup.DictationCleanupPrompt.WithHighCleanup()
NONE = dictation_cleanup.DictationCleanupPrompt.WithNoCleanup()


def cleaned(level, answer, text="um hello there", vocabulary=(), **options):
    """One cleanup at ``level`` with the model scripted, answering what it came to and its calls."""
    llm, patch = with_model(answer)
    with patch:
        got = dictation_cleanup.finish(text, vocabulary, prompt=level.Build(), **options)
    return got, llm


class BuilderTest(unittest.TestCase):

    def test_each_level_is_reached_by_its_own_builder(self) -> None:
        self.assertEqual(
            [
                NONE.Build().level,
                LIGHT.Build().level,
                MEDIUM.Build().level,
                HIGH.Build().level,
            ],
            ["none", "light", "medium", "high"],
        )

    def test_a_level_a_host_does_not_name_is_the_default_one(self) -> None:
        self.assertEqual(dictation_cleanup.DictationCleanupPrompt.ForLevel("HIGH").level, "high")
        self.assertEqual(dictation_cleanup.DictationCleanupPrompt.ForLevel("loud").level, "light")
        self.assertEqual(dictation_cleanup.DictationCleanupPrompt.ForLevel(None).level, "light")

    def test_a_level_that_is_not_one_raises(self) -> None:
        with self.assertRaises(ValueError):
            dictation_cleanup.DictationCleanupPrompt("loud")

    def test_none_cleans_nothing_and_asks_nothing(self) -> None:
        asked = NONE.Build()
        self.assertFalse(asked.cleaning)
        self.assertEqual(asked.instructions, "")

    def test_high_reads_longer_than_the_rest(self) -> None:
        self.assertEqual(LIGHT.Build().deadline_s, dictation_cleanup.DEADLINE_S)
        self.assertEqual(MEDIUM.Build().deadline_s, dictation_cleanup.DEADLINE_S)
        self.assertEqual(HIGH.Build().deadline_s, dictation_cleanup.HIGH_DEADLINE_S)
        self.assertGreater(dictation_cleanup.HIGH_DEADLINE_S, dictation_cleanup.DEADLINE_S)

    def test_the_answer_budget_is_sized_from_the_words_and_never_tiny(self) -> None:
        asked = LIGHT.Build()
        self.assertEqual(asked.tokens("hello there"), dictation_cleanup.MIN_TOKENS)
        self.assertEqual(
            asked.tokens("word " * 4000), dictation_cleanup.MAX_TOKENS, "a runaway take is bounded"
        )


class RulesTest(unittest.TestCase):

    def rules(self, level) -> str:
        return level.Build().instructions

    def test_light_takes_out_what_was_stumbled_over_and_repairs_the_grammar(self) -> None:
        rules = self.rules(LIGHT)
        self.assertIn('"um"', rules)
        self.assertIn('"uh"', rules)
        self.assertIn("false start", rules)
        self.assertIn("the the", rules)
        self.assertIn("I'm just wanted to", rules)
        self.assertIn("Repair grammar", rules)
        self.assertIn("Keep every other word", rules)

    def test_light_no_longer_forbids_repairing_a_sentence(self) -> None:
        self.assertNotIn("Never reword", self.rules(LIGHT))

    def test_medium_tightens_without_dropping_anything(self) -> None:
        rules = self.rules(MEDIUM)
        self.assertIn("Then tighten it", rules)
        self.assertIn("fewer words", rules)
        self.assertIn("Keep every fact", rules)
        self.assertNotIn("Then compress it", rules)

    def test_high_compresses_but_keeps_the_content(self) -> None:
        rules = self.rules(HIGH)
        self.assertIn("Then tighten it", rules)
        self.assertIn("Then compress it", rules)
        self.assertIn("Drop words, never content", rules)
        self.assertIn("every fact, decision, number, name and request stays", rules)

    def test_every_level_that_calls_answers_one_json_object(self) -> None:
        for level in (LIGHT, MEDIUM, HIGH):
            rules = self.rules(level)
            self.assertIn('{"text"', rules)
            self.assertIn("as one JSON object", rules)
            self.assertIn("as digits", rules)
            self.assertIn('"- "', rules)
            self.assertIn("vocabulary exactly as the vocabulary spells it", rules)

    def test_no_level_answers_the_dictation_or_adds_to_it(self) -> None:
        for level in (LIGHT, MEDIUM, HIGH):
            rules = self.rules(level)
            self.assertIn("Never add anything the person did not say", rules)
            self.assertIn("never answer the dictation", rules)

    def test_the_answer_is_one_json_object_holding_the_text(self) -> None:
        self.assertEqual(dictation_cleanup.SCHEMA["type"], "object")
        self.assertEqual(dictation_cleanup.SCHEMA["properties"]["text"]["type"], "string")
        self.assertEqual(dictation_cleanup.SCHEMA["required"], ["text"])


class HoldsTest(unittest.TestCase):

    def holds(self, level, said, answer) -> bool:
        return level.Build().holds(said, answer)

    def test_light_keeps_its_words(self) -> None:
        said = "let us ship the whole dictation today for the team"
        self.assertTrue(
            self.holds(LIGHT, said, "Let us ship the whole dictation today, for the team.")
        )
        self.assertFalse(self.holds(LIGHT, said, "Ship the dictation today."))

    def test_medium_may_tighten(self) -> None:
        said = "let us ship the whole dictation today for the team"
        self.assertTrue(self.holds(MEDIUM, said, "Let us ship the dictation today, for the team."))
        self.assertFalse(self.holds(MEDIUM, said, "Ship it."))

    def test_high_may_compress_far_more(self) -> None:
        said = "so i was thinking that we should probably ship the whole dictation today for the team"
        self.assertTrue(self.holds(HIGH, said, "Ship the dictation today."))
        self.assertFalse(self.holds(HIGH, said, "Ship it."))

    def test_no_level_may_grow_the_text(self) -> None:
        said = "ship the boat now"
        grown = "Ship the boat now, and while you are at it tidy the deck and the sails."
        for level in (LIGHT, MEDIUM, HIGH):
            self.assertFalse(self.holds(level, said, grown), level.Build().level)

    def test_an_empty_answer_or_text_is_not_a_tidying(self) -> None:
        self.assertFalse(self.holds(HIGH, "um uh", ""))
        self.assertFalse(self.holds(HIGH, "", "Hello."))


class FinishTest(unittest.TestCase):

    def test_none_makes_no_call_and_lands_the_words_as_heard(self) -> None:
        got, llm = cleaned(NONE, {"text": "Hello there."})
        self.assertEqual(got["text"], "um hello there")
        self.assertFalse(got["cleaned"])
        self.assertEqual(got["level"], "none")
        self.assertEqual(llm.calls, [])

    def test_a_light_cleanup_tidies_the_text_and_says_which_level(self) -> None:
        got, _ = cleaned(
            LIGHT,
            {"text": "Gots ships 25 on 3 March."},
            text="um Gots ships twenty five on the third of March",
            vocabulary=["Gots"],
        )
        self.assertEqual(got["text"], "Gots ships 25 on 3 March.")
        self.assertTrue(got["cleaned"])
        self.assertEqual(got["level"], "light")

    def test_the_text_rides_with_the_bot_s_words_in_front_of_it(self) -> None:
        _, llm = cleaned(
            LIGHT,
            {"text": "Gots ships it."},
            text="gots ships it",
            vocabulary=["Gots", "DeepSeek"],
        )
        self.assertEqual(
            llm.calls[0]["input"],
            [{"type": "text", "text": "Vocabulary: Gots DeepSeek\nDictation: gots ships it"}],
        )

    def test_a_take_with_no_words_asks_without_a_vocabulary_line(self) -> None:
        _, llm = cleaned(LIGHT, {"text": "Hello there."})
        self.assertEqual(llm.calls[0]["input"][0]["text"], "Dictation: um hello there")

    def test_the_call_carries_the_level_s_prompt(self) -> None:
        _, llm = cleaned(HIGH, {"text": "Hello there."})
        call = llm.calls[0]
        self.assertEqual(call["purpose"], "memento.dictation.cleanup")
        self.assertEqual(call["temperature"], 0)
        self.assertEqual(call["json_schema"], dictation_cleanup.SCHEMA)
        self.assertEqual(call["system_prompt"], dictation_cleanup.SYSTEM)
        self.assertEqual(call["instructions"], HIGH.Build().instructions)
        self.assertEqual(call["max_tokens"], HIGH.Build().tokens("um hello there"))

    def test_a_call_that_misses_its_budget_lands_the_words_as_heard(self) -> None:
        def slow(prompt, input_text, model):
            time.sleep(0.2)
            return "Tidied."

        started = time.monotonic()
        got = dictation_cleanup.finish(
            "um hello there",
            prompt=dataclasses.replace(LIGHT.Build(), deadline_s=0.02),
            ask=slow,
        )
        self.assertEqual(got["text"], "um hello there")
        self.assertFalse(got["cleaned"])
        self.assertLess(time.monotonic() - started, 0.2, "the dictation did not wait for the model")

    def test_a_call_that_raises_lands_the_words_as_heard(self) -> None:
        got, _ = cleaned(LIGHT, RuntimeError("the host's model is down"))
        self.assertEqual(got["text"], "um hello there")

    def test_a_call_that_answers_in_the_wrong_shape_lands_the_words_as_heard(self) -> None:
        for answer in (None, {"words": "Hello there."}, {"text": 7}):
            got, _ = cleaned(LIGHT, answer)
            self.assertEqual(got["text"], "um hello there", repr(answer))

    def test_an_answer_outside_its_level_s_bounds_is_discarded(self) -> None:
        said = "let us ship the whole dictation today for the team"
        got, _ = cleaned(LIGHT, {"text": "Ship it."}, text=said)
        self.assertEqual(got["text"], said)

    def test_what_high_may_answer_light_would_have_discarded(self) -> None:
        said = "so i was thinking that we should probably ship the whole dictation today for the team"
        mid = {"text": "So I was thinking we should ship the whole dictation today, for the team."}
        got, _ = cleaned(HIGH, mid, text=said)
        self.assertEqual(got["text"], mid["text"])

    def test_a_host_with_no_model_lands_the_words_as_heard(self) -> None:
        with mock.patch.object(dictation_cleanup, "ctx", None):
            got = dictation_cleanup.finish("um hello there", prompt=LIGHT.Build())
        self.assertEqual(got["text"], "um hello there")

    def test_an_empty_take_asks_nothing(self) -> None:
        got, llm = cleaned(LIGHT, {"text": "Hello there."}, text="   ")
        self.assertEqual(got["text"], "   ")
        self.assertEqual(llm.calls, [])

    def test_a_body_that_is_not_text_is_refused(self) -> None:
        with self.assertRaises(dictation_cleanup.DictationError):
            dictation_cleanup.finish(None, prompt=LIGHT.Build())

    def test_the_scripted_ask_is_handed_the_level_s_prompt_and_its_input(self) -> None:
        asked = []

        def script(prompt, input_text, model):
            asked.append((prompt.level, input_text, model))
            return "Hello there."

        got = dictation_cleanup.finish(
            "um hello there", ["Gots"], hint="Gots, ship it", prompt=MEDIUM.Build(), ask=script
        )
        self.assertEqual(got["text"], "Hello there.")
        self.assertEqual(
            asked,
            [
                (
                    "medium",
                    "Names: Gots, ship it\nVocabulary: Gots\nDictation: um hello there",
                    None,
                )
            ],
        )

    def test_the_names_a_take_may_mention_ride_in_front_of_its_words(self) -> None:
        _, llm = cleaned(
            LIGHT,
            {"text": "Gots ships it."},
            text="gots ships it",
            vocabulary=["Gots"],
            hint="Gots, memento",
        )
        self.assertEqual(
            llm.calls[0]["input"],
            [
                {
                    "type": "text",
                    "text": "Names: Gots, memento\nVocabulary: Gots\nDictation: gots ships it",
                }
            ],
        )

    def test_a_picked_model_answers_and_its_failure_falls_back_to_the_bot_s_own(self) -> None:
        # The seam the Speech-to-text page's pick fits into: the pick is asked first, and a host
        # that refuses it still tidies the dictation on the bot's own model.
        llm, patch = with_model(RuntimeError("override denied"), {"text": "Hello there."})
        with patch:
            got = dictation_cleanup.finish(
                "um hello there",
                prompt=LIGHT.Build(),
                model={"provider": "acme", "model": "fast"},
            )
        self.assertEqual(got["text"], "Hello there.")
        self.assertEqual((llm.calls[0]["provider"], llm.calls[0]["model"]), ("acme", "fast"))
        self.assertNotIn("provider", llm.calls[1])
        self.assertNotIn("model", llm.calls[1])

    def test_a_pick_that_is_not_a_provider_and_model_is_not_passed_on(self) -> None:
        llm, patch = with_model({"text": "Hello there."})
        with patch:
            dictation_cleanup.finish(
                "um hello there", prompt=LIGHT.Build(), model={"temperature": 2, "model": "fast"}
            )
        self.assertEqual(llm.calls[0]["model"], "fast")
        self.assertEqual(llm.calls[0]["temperature"], 0)


if __name__ == "__main__":
    unittest.main()
