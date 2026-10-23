"""Tests for dictation (``plugin/dictation.py``).

Hermes's transcription module isn't on a test run's path, so each test stands in for
``tools.transcription_tools`` and asserts only this module's own rules: when the host counts as
ready, what reaches faster-whisper, and how its answers come back.
"""

from __future__ import annotations

import os
import time
import types
import unittest
from unittest import mock

from plugin import dictation, dictation_cleanup
from plugin.tests._helpers import with_model


def hermes(**overrides):
    """A fake ``tools`` package whose transcription module has faster-whisper and stt on."""
    tt = types.ModuleType("tools.transcription_tools")
    tt._HAS_FASTER_WHISPER = True
    tt.calls = []

    def transcribe(path, model, prompt=None):
        with open(path, "rb") as file:
            tt.calls.append({"path": path, "model": model, "prompt": prompt, "data": file.read()})
        return {"success": True, "transcript": " Hello there. ", "provider": "local"}

    tt._transcribe_local = transcribe
    tt._load_stt_config = lambda: {"local": {"model": "small"}}
    tt.is_stt_enabled = lambda cfg: cfg.get("enabled", True)
    tt._resolve_stt_language = lambda provider, cfg: "en"
    tt._get_or_load_local_model = mock.Mock()
    for key, value in overrides.items():
        setattr(tt, key, value)
    tools = types.ModuleType("tools")
    tools.transcription_tools = tt
    modules = {"tools": tools, "tools.transcription_tools": tt}
    return tt, mock.patch.dict("sys.modules", modules)


class InfoTest(unittest.TestCase):
    def test_ready_with_faster_whisper_and_stt_on(self) -> None:
        _, patch = hermes()
        with patch:
            self.assertEqual(dictation.info(), {"ready": True, "model": "small", "language": "en"})

    def test_off_without_faster_whisper(self) -> None:
        _, patch = hermes(_HAS_FASTER_WHISPER=False)
        with patch, mock.patch("importlib.util.find_spec", return_value=None):
            state = dictation.info()
        self.assertFalse(state["ready"])
        self.assertIn("faster-whisper", state["reason"])

    def test_off_when_stt_is_turned_off(self) -> None:
        _, patch = hermes(_load_stt_config=lambda: {"enabled": False})
        with patch:
            self.assertFalse(dictation.info()["ready"])

    def test_off_on_a_hermes_without_the_local_path(self) -> None:
        tt, patch = hermes()
        del tt._transcribe_local
        with patch:
            self.assertFalse(dictation.info()["ready"])


class TranscribeTest(unittest.TestCase):
    def test_sends_the_clip_to_the_local_model_and_deletes_it(self) -> None:
        tt, patch = hermes()
        with patch:
            result = dictation.transcribe(b"opus", "audio/webm;codecs=opus", "Gots Hermes")
        self.assertEqual(result["text"], "Hello there.")
        call = tt.calls[0]
        self.assertEqual((call["model"], call["prompt"], call["data"]), ("small", "Gots Hermes", b"opus"))
        self.assertTrue(call["path"].endswith(".webm"))
        self.assertFalse(os.path.exists(call["path"]))

    def test_keeps_the_hosts_own_prompt_first(self) -> None:
        cfg = {"local": {"model": "base", "initial_prompt": "Haseeb"}}
        tt, patch = hermes(_load_stt_config=lambda: cfg)
        with patch:
            dictation.transcribe(b"x", "audio/mp4", "Gots")
        self.assertEqual(tt.calls[0]["prompt"], "Haseeb Gots")
        self.assertTrue(tt.calls[0]["path"].endswith(".mp4"))

    def test_the_text_before_the_clip_goes_last(self) -> None:
        cfg = {"local": {"model": "base", "initial_prompt": "Haseeb"}}
        tt, patch = hermes(_load_stt_config=lambda: cfg)
        with patch:
            dictation.transcribe(b"x", "audio/webm", "Gots", "We should ship it")
        self.assertEqual(tt.calls[0]["prompt"], "Haseeb Gots We should ship it")

    def test_the_bot_s_words_ride_between_the_hint_and_the_text_before(self) -> None:
        cfg = {"local": {"model": "base", "initial_prompt": "Haseeb"}}
        tt, patch = hermes(_load_stt_config=lambda: cfg)
        with patch:
            dictation.transcribe(
                b"x",
                "audio/webm",
                "Gots",
                "We should ship it",
                vocabulary=["DeepSeek", "Hermes"],
            )
        self.assertEqual(
            tt.calls[0]["prompt"], "Haseeb Gots DeepSeek Hermes We should ship it"
        )

    def test_a_clip_with_no_words_asks_with_only_its_hint(self) -> None:
        tt, patch = hermes()
        with patch:
            dictation.transcribe(b"x", "audio/webm", "Gots", vocabulary=None)
        self.assertEqual(tt.calls[0]["prompt"], "Gots")

    def test_no_speech_is_empty_text(self) -> None:
        empty = lambda path, model, prompt=None: {"success": False, "error": "Empty transcript"}
        _, patch = hermes(_transcribe_local=empty)
        with patch:
            self.assertEqual(dictation.transcribe(b"x", "audio/webm")["text"], "")

    def test_a_failure_is_an_error_with_hermes_reason(self) -> None:
        broken = lambda path, model, prompt=None: {"success": False, "error": "CUDA out of memory"}
        _, patch = hermes(_transcribe_local=broken)
        with patch, self.assertRaises(dictation.DictationError) as caught:
            dictation.transcribe(b"x", "audio/webm")
        self.assertEqual((str(caught.exception), caught.exception.status), ("CUDA out of memory", 502))

    def test_refuses_when_not_ready(self) -> None:
        _, patch = hermes(_load_stt_config=lambda: {"enabled": False})
        with patch, self.assertRaises(dictation.DictationError) as caught:
            dictation.transcribe(b"x", "audio/webm")
        self.assertEqual(caught.exception.status, 409)


class WarmTest(unittest.TestCase):
    def test_fills_the_model_slot_without_the_lease_helper(self) -> None:
        tt, patch = hermes()
        with patch:
            self.assertTrue(dictation.warm()["warmed"])
        tt._get_or_load_local_model.assert_called_once_with("small", {"model": "small"})

    def test_never_raises(self) -> None:
        _, patch = hermes(_get_or_load_local_model=mock.Mock(side_effect=RuntimeError("no network")))
        with patch:
            self.assertEqual(dictation.warm(), {"warmed": False, "error": "no network"})

    def test_warms_the_model_it_is_named_rather_than_the_one_configured(self) -> None:
        tt, patch = hermes()
        with patch:
            warmed = dictation.warm("large-v3")
        self.assertEqual(warmed["warmed"], True)
        self.assertEqual(warmed["model"], "large-v3")
        tt._get_or_load_local_model.assert_called_once_with("large-v3", {"model": "small"})


class HintTest(unittest.TestCase):
    def test_squashes_and_caps(self) -> None:
        self.assertEqual(dictation.clean_hint("  a\n b  "), "a b")
        self.assertEqual(len(dictation.clean_hint("x" * 1000)), dictation.MAX_HINT)


class ContextTest(unittest.TestCase):
    def test_keeps_the_end_from_a_whole_word(self) -> None:
        self.assertEqual(dictation.clean_context(" so\n  far "), "so far")
        said = " ".join(f"word{n}" for n in range(200))
        kept = dictation.clean_context(said)
        self.assertLessEqual(len(kept), dictation.MAX_CONTEXT)
        self.assertTrue(said.endswith(kept))
        self.assertTrue(kept.startswith("word"))


class CleanVocabularyTest(unittest.TestCase):
    def test_a_word_is_one_line(self) -> None:
        self.assertEqual(dictation.clean_vocabulary(["  Foo \n bar "]), ["Foo bar"])

    def test_a_word_the_list_already_holds_is_not_added_again(self) -> None:
        self.assertEqual(dictation.clean_vocabulary(["Gots", "gots", "GOTS"]), ["Gots"])

    def test_the_list_is_capped(self) -> None:
        many = [f"word{index}" for index in range(dictation.MAX_VOCABULARY + 20)]
        self.assertEqual(len(dictation.clean_vocabulary(many)), dictation.MAX_VOCABULARY)

    def test_anything_that_is_not_a_list_of_words_is_no_vocabulary(self) -> None:
        self.assertEqual(dictation.clean_vocabulary(None), [])
        self.assertEqual(dictation.clean_vocabulary("Gots"), [])
        self.assertEqual(dictation.clean_vocabulary([1, "", "  ", None, "Gots"]), ["Gots"])

    def test_a_word_carries_no_more_than_the_cap(self) -> None:
        self.assertEqual(
            len(dictation.clean_vocabulary(["x" * 200])[0]), dictation.MAX_WORD
        )


class CleanupTest(unittest.TestCase):
    HEARD = (
        "um hello there. uh we should ship the dictation today. the third of March works for me "
        "and the team."
    )

    def test_a_finished_dictation_comes_back_tidied(self) -> None:
        llm, patch = with_model({"text": "Gots ships 25 on 3 March."})
        with patch:
            answer = dictation_cleanup.finish(
                "um Gots ships twenty five on the third of March", ["Gots"]
            )
        self.assertEqual(answer["text"], "Gots ships 25 on 3 March.")
        self.assertTrue(answer["cleaned"])
        self.assertGreaterEqual(answer["ms"], 0)
        self.assertEqual(len(llm.calls), 1)
        self.assertEqual(
            llm.calls[0]["input"],
            [
                {
                    "type": "text",
                    "text": "Vocabulary: Gots\nDictation: um Gots ships twenty five on the third of March",
                }
            ],
        )
        self.assertEqual(
            llm.calls[0]["system_prompt"],
            dictation_cleanup.WHOLE_TEXT_SYSTEM,
            "the model is told it tidies a finished dictation, not one phrase of one",
        )
        self.assertEqual(llm.calls[0]["instructions"], dictation_cleanup.WHOLE_TEXT_INSTRUCTIONS)

    def test_a_whole_text_is_tidied_in_one_call(self) -> None:
        tidied = (
            "Hello there. We should ship the dictation today. 3 March works for me and the team."
        )
        llm, patch = with_model({"text": tidied})
        with patch:
            answer = dictation_cleanup.finish(self.HEARD)
        self.assertEqual(answer["text"], tidied)
        self.assertEqual(len(llm.calls), 1)
        self.assertEqual(llm.calls[0]["input"][0]["text"], f"Dictation: {self.HEARD}")

    def test_a_several_hundred_word_dictation_s_answer_is_not_discarded(self) -> None:
        said = [f"word{index}" for index in range(300)]
        heard = "um " + " ".join(said)
        tidied = " ".join(said) + "."
        llm, patch = with_model({"text": tidied})
        with patch:
            answer = dictation_cleanup.finish(heard)
        self.assertEqual(answer["text"], tidied)
        self.assertTrue(answer["cleaned"], "the tidied dictation is what lands")
        budget = llm.calls[0]["max_tokens"]
        self.assertGreater(budget, dictation_cleanup.PHRASE_TOKENS, "the budget scales with it")
        self.assertLessEqual(budget, dictation_cleanup.MAX_TOKENS, "and stays bounded")

    def test_the_whole_text_budget_outlasts_a_phrase_s(self) -> None:
        self.assertGreater(
            dictation_cleanup.WHOLE_TEXT_DEADLINE_S, dictation_cleanup.DEADLINE_S
        )

    def test_a_cleanup_that_misses_the_whole_text_budget_lands_the_raw_words(self) -> None:
        def slow(text, vocabulary, model):
            time.sleep(0.2)
            return "Tidied."

        started = time.monotonic()
        answer = dictation_cleanup.finish(self.HEARD, deadline_s=0.02, ask=slow)
        self.assertEqual(answer["text"], self.HEARD)
        self.assertFalse(answer["cleaned"])
        self.assertLess(time.monotonic() - started, 0.2, "the text did not wait for the model")

    def test_a_cleanup_that_fails_lands_the_raw_words(self) -> None:
        _, patch = with_model(RuntimeError("the host's model is down"))
        with patch:
            answer = dictation_cleanup.finish(self.HEARD)
        self.assertEqual(answer["text"], self.HEARD)
        self.assertFalse(answer["cleaned"])

    def test_a_host_that_cannot_make_model_calls_lands_the_raw_words(self) -> None:
        with mock.patch.object(dictation_cleanup, "ctx", None):
            answer = dictation_cleanup.finish(self.HEARD)
        self.assertEqual(answer["text"], self.HEARD)
        self.assertFalse(answer["cleaned"])

    def test_an_answer_much_longer_than_the_text_lands_the_raw_words(self) -> None:
        _, patch = with_model(
            {"text": self.HEARD + " " + "And here is a great deal more that nobody said. " * 4}
        )
        with patch:
            answer = dictation_cleanup.finish(self.HEARD)
        self.assertEqual(answer["text"], self.HEARD)
        self.assertFalse(answer["cleaned"])

    def test_an_answer_much_shorter_than_the_text_lands_the_raw_words(self) -> None:
        _, patch = with_model({"text": "Ship it."})
        with patch:
            answer = dictation_cleanup.finish(self.HEARD)
        self.assertEqual(answer["text"], self.HEARD)
        self.assertFalse(answer["cleaned"])

    def test_the_bot_s_chosen_cleanup_model_tidies_it(self) -> None:
        llm, patch = with_model({"text": "Hello there."})
        with patch:
            dictation_cleanup.finish(
                "um hello there", model={"provider": "acme", "model": "fast"}
            )
        self.assertEqual((llm.calls[0]["provider"], llm.calls[0]["model"]), ("acme", "fast"))

    def test_a_body_without_text_is_a_bad_request(self) -> None:
        for text in (None, 7, {"text": "no"}):
            with self.assertRaises(dictation.DictationError) as caught:
                dictation_cleanup.finish(text)
            self.assertEqual(caught.exception.status, 400)

    def test_a_dictation_with_no_words_asks_nothing(self) -> None:
        llm, patch = with_model()
        with patch:
            answer = dictation_cleanup.finish("")
        self.assertEqual(answer["text"], "")
        self.assertFalse(answer["cleaned"])
        self.assertEqual(llm.calls, [])


if __name__ == "__main__":
    unittest.main()
