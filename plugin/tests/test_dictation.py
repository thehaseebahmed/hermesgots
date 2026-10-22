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
        # The Dictation tab's pick is written to config.yaml, but the take that follows loads it by
        # name: the host's cached slot is filled with the model the app chose.
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


if __name__ == "__main__":
    unittest.main()
