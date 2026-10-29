"""Tests for dictation (``plugin/dictation.py``).

Hermes's transcription module isn't on a test run's path, so each test stands in for
``tools.transcription_tools`` and asserts only this module's own rules: when the host counts as
ready, what reaches faster-whisper, and how its answers come back.
"""

from __future__ import annotations

import os
import types
import unittest
from unittest import mock

from plugin import dictation


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


class HearingPromptTest(unittest.TestCase):
    def test_the_parts_go_in_the_order_whisper_reads_them(self) -> None:
        built = (
            dictation.DictationHearingPrompt()
            .WithInitialPrompt("Haseeb")
            .WithHint("Gots")
            .WithVocabulary(["DeepSeek", "Hermes"])
            .WithContext("We should ship it")
            .Build()
        )
        self.assertEqual(built, "Haseeb Gots DeepSeek Hermes We should ship it")

    def test_a_part_that_is_not_there_is_left_out(self) -> None:
        self.assertEqual(dictation.DictationHearingPrompt().Build(), "")
        self.assertEqual(
            dictation.DictationHearingPrompt().WithVocabulary(["", "Gots"]).Build(), "Gots"
        )


class TranscribeTest(unittest.TestCase):
    def test_sends_the_clip_to_the_local_model_and_deletes_it(self) -> None:
        tt, patch = hermes()
        with patch:
            result = dictation.transcribe(
                b"opus", "audio/webm;codecs=opus", "Gots Hermes", hearing=True
            )
        self.assertEqual(result["text"], "Hello there.")
        call = tt.calls[0]
        self.assertEqual((call["model"], call["prompt"], call["data"]), ("small", "Gots Hermes", b"opus"))
        self.assertTrue(call["path"].endswith(".webm"))
        self.assertFalse(os.path.exists(call["path"]))

    def test_keeps_the_hosts_own_prompt_first(self) -> None:
        cfg = {"local": {"model": "base", "initial_prompt": "Haseeb"}}
        tt, patch = hermes(_load_stt_config=lambda: cfg)
        with patch:
            dictation.transcribe(b"x", "audio/mp4", "Gots", hearing=True)
        self.assertEqual(tt.calls[0]["prompt"], "Haseeb Gots")
        self.assertTrue(tt.calls[0]["path"].endswith(".mp4"))

    def test_a_take_without_a_hearing_prompt_sends_the_model_none(self) -> None:
        cfg = {"local": {"model": "base", "initial_prompt": "Haseeb"}}
        tt, patch = hermes(_load_stt_config=lambda: cfg)
        with patch:
            dictation.transcribe(
                b"x", "audio/mp4", "Gots", "We should ship it", ["DeepSeek"], hearing=False
            )
        self.assertIsNone(tt.calls[0]["prompt"])

    def test_the_text_before_the_clip_goes_last(self) -> None:
        cfg = {"local": {"model": "base", "initial_prompt": "Haseeb"}}
        tt, patch = hermes(_load_stt_config=lambda: cfg)
        with patch:
            dictation.transcribe(b"x", "audio/webm", "Gots", "We should ship it", hearing=True)
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
                hearing=True,
            )
        self.assertEqual(
            tt.calls[0]["prompt"], "Haseeb Gots DeepSeek Hermes We should ship it"
        )

    def test_a_clip_with_no_words_asks_with_only_its_hint(self) -> None:
        tt, patch = hermes()
        with patch:
            dictation.transcribe(b"x", "audio/webm", "Gots", vocabulary=None, hearing=True)
        self.assertEqual(tt.calls[0]["prompt"], "Gots")

    def test_no_speech_is_empty_text(self) -> None:
        empty = lambda path, model, prompt=None: {"success": False, "error": "Empty transcript"}
        _, patch = hermes(_transcribe_local=empty)
        with patch:
            self.assertEqual(dictation.transcribe(b"x", "audio/webm", hearing=True)["text"], "")

    def test_a_failure_is_an_error_with_hermes_reason(self) -> None:
        broken = lambda path, model, prompt=None: {"success": False, "error": "CUDA out of memory"}
        _, patch = hermes(_transcribe_local=broken)
        with patch, self.assertRaises(dictation.DictationError) as caught:
            dictation.transcribe(b"x", "audio/webm", hearing=True)
        self.assertEqual((str(caught.exception), caught.exception.status), ("CUDA out of memory", 502))

    def test_refuses_when_not_ready(self) -> None:
        _, patch = hermes(_load_stt_config=lambda: {"enabled": False})
        with patch, self.assertRaises(dictation.DictationError) as caught:
            dictation.transcribe(b"x", "audio/webm", hearing=True)
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

    def test_the_list_is_capped_keeping_the_newest(self) -> None:
        many = [f"word{index}" for index in range(dictation.MAX_VOCABULARY + 20)]
        kept = dictation.clean_vocabulary(many)
        self.assertEqual(kept, many[-dictation.MAX_VOCABULARY:])

    def test_a_word_the_cap_dropped_can_come_back_as_the_newest(self) -> None:
        many = [f"word{index}" for index in range(dictation.MAX_VOCABULARY + 1)]
        # The cap drops the first word; naming it again makes it the newest and drops the next.
        self.assertEqual(dictation.clean_vocabulary(many + ["word0"]), many[2:] + ["word0"])

    def test_a_long_list_stays_bounded(self) -> None:
        many = [f"word{index}" for index in range(dictation.MAX_VOCABULARY * 100)]
        kept = dictation.clean_vocabulary(many)
        self.assertEqual(kept, many[-dictation.MAX_VOCABULARY:])

    def test_anything_that_is_not_a_list_of_words_is_no_vocabulary(self) -> None:
        self.assertEqual(dictation.clean_vocabulary(None), [])
        self.assertEqual(dictation.clean_vocabulary("Gots"), [])
        self.assertEqual(dictation.clean_vocabulary([1, "", "  ", None, "Gots"]), ["Gots"])

    def test_a_word_carries_no_more_than_the_cap(self) -> None:
        self.assertEqual(
            len(dictation.clean_vocabulary(["x" * 200])[0]), dictation.MAX_WORD
        )


if __name__ == "__main__":
    unittest.main()
