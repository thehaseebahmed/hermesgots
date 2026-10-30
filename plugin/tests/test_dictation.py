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
    tt = types.ModuleType("tools.transcription_tools")
    tt._HAS_FASTER_WHISPER = True
    tt.calls = []
    tt.audio = []

    def transcribe(path, model, prompt=None):
        with open(path, "rb") as file:
            tt.calls.append({"path": path, "model": model, "prompt": prompt, "data": file.read()})
        return {"success": True, "transcript": " Hello there. ", "provider": "local"}

    def transcribe_audio(path, source=None):
        with open(path, "rb") as file:
            tt.audio.append({"path": path, "source": source, "data": file.read()})
        return {"success": True, "transcript": " Uploaded take. ", "provider": "groq"}

    tt._transcribe_local = transcribe
    tt.transcribe_audio = transcribe_audio
    tt._get_provider = lambda cfg: "local"
    tt._detect_local_backend = lambda: "local"
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
    def test_ready_with_a_local_provider_and_stt_on(self) -> None:
        _, patch = hermes()
        with patch:
            self.assertEqual(
                dictation.info(),
                {
                    "ready": True,
                    "model": "small",
                    "language": "en",
                    "provider": {"name": "local", "backend": "local", "cloud": False},
                },
            )

    def test_a_cloud_provider_is_ready_and_says_the_take_leaves_the_host(self) -> None:
        _, patch = hermes(_get_provider=lambda cfg: "groq")
        with patch:
            state = dictation.info()
        self.assertTrue(state["ready"])
        self.assertEqual(state["provider"]["name"], "groq")
        self.assertTrue(state["provider"]["cloud"])

    def test_a_host_with_nobody_to_hear_it_says_what_to_fix(self) -> None:
        _, patch = hermes(_get_provider=lambda cfg: "none")
        with patch:
            state = dictation.info()
        self.assertFalse(state["ready"])
        self.assertEqual(state["reason"], dictation.NO_PROVIDER)
        self.assertIn("faster-whisper", state["reason"])
        self.assertEqual(state["provider"]["name"], "none")

    def test_a_host_whose_hermes_has_no_provider_resolver_falls_back_to_faster_whisper(self) -> None:
        tt, patch = hermes()
        del tt._get_provider
        with patch:
            self.assertTrue(dictation.info()["ready"])
        tt2, patch2 = hermes(_HAS_FASTER_WHISPER=False)
        del tt2._get_provider
        with patch2, mock.patch("importlib.util.find_spec", return_value=None):
            self.assertFalse(dictation.info()["ready"])

    def test_off_when_stt_is_turned_off(self) -> None:
        _, patch = hermes(_load_stt_config=lambda: {"enabled": False})
        with patch:
            self.assertFalse(dictation.info()["ready"])

    def test_off_on_a_hermes_without_the_dispatcher(self) -> None:
        tt, patch = hermes()
        del tt.transcribe_audio
        with patch:
            self.assertFalse(dictation.info()["ready"])

    def test_off_on_a_local_host_without_the_local_path(self) -> None:
        tt, patch = hermes()
        del tt._transcribe_local
        with patch:
            state = dictation.info()
        self.assertFalse(state["ready"])
        self.assertIn("local speech-to-text", state["reason"])


class HeardByTest(unittest.TestCase):
    def test_a_local_host_names_its_backend(self) -> None:
        tt, patch = hermes()
        with patch:
            self.assertEqual(
                dictation.heard_by(tt, {}),
                {"name": "local", "backend": "local", "cloud": False},
            )

    def test_a_whisper_cli_host_is_local_command_and_still_cloudless(self) -> None:
        tt, patch = hermes(_get_provider=lambda cfg: "local_command", _detect_local_backend=lambda: "local_command")
        with patch:
            self.assertEqual(
                dictation.heard_by(tt, {}),
                {"name": "local_command", "backend": "local_command", "cloud": False},
            )

    def test_a_cloud_host_has_no_local_backend_and_says_so(self) -> None:
        tt, patch = hermes(_get_provider=lambda cfg: "openai")
        with patch:
            self.assertEqual(
                dictation.heard_by(tt, {}),
                {"name": "openai", "backend": None, "cloud": True},
            )

    def test_no_provider_is_neither_local_nor_cloud(self) -> None:
        tt, patch = hermes(_get_provider=lambda cfg: "none")
        with patch:
            self.assertEqual(
                dictation.heard_by(tt, {}),
                {"name": "none", "backend": None, "cloud": False},
            )

    def test_a_raising_resolver_falls_back_to_the_package_check(self) -> None:
        def boom(cfg):
            raise RuntimeError("no config")

        tt, patch = hermes(_get_provider=boom)
        with patch:
            self.assertEqual(dictation.heard_by(tt, {})["name"], "local")


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


class VendorTakeTest(unittest.TestCase):
    def setUp(self) -> None:
        dictation._buffers.clear()

    def tearDown(self) -> None:
        dictation._buffers.clear()

    def take(self, tt, *pieces, last=False, profile="/tmp/profile"):
        return dictation.transcribe(
            pieces[0] if pieces else b"",
            "audio/webm;codecs=opus",
            hearing=True,
            last=last,
            profile=profile,
        )

    def test_a_piece_before_the_last_answers_nothing_and_uploads_nothing(self) -> None:
        tt, patch = hermes(_get_provider=lambda cfg: "groq")
        with patch:
            result = self.take(tt, b"one")
        self.assertEqual(result, {"text": "", "ms": 0})
        self.assertEqual(tt.audio, [])
        self.assertEqual(tt.calls, [], "a vendor take never reaches the local model")

    def test_the_last_piece_uploads_the_whole_take_once(self) -> None:
        tt, patch = hermes(_get_provider=lambda cfg: "groq")
        with patch:
            dictation.transcribe(b"one", "audio/webm", hearing=True, profile="p")
            dictation.transcribe(b"two", "audio/webm", hearing=True, profile="p")
            result = dictation.transcribe(b"three", "audio/webm", hearing=True, last=True, profile="p")
        self.assertEqual(result["text"], "Uploaded take.")
        self.assertEqual(len(tt.audio), 1)
        self.assertEqual(tt.audio[0]["data"], b"onetwothree")
        self.assertEqual(tt.audio[0]["source"], "dictation")
        self.assertTrue(tt.audio[0]["path"].endswith(".webm"))
        self.assertFalse(os.path.exists(tt.audio[0]["path"]))

    def test_a_single_piece_take_that_is_its_own_last_uploads_at_once(self) -> None:
        tt, patch = hermes(_get_provider=lambda cfg: "groq")
        with patch:
            self.take(tt, b"only", last=True)
        self.assertEqual([call["data"] for call in tt.audio], [b"only"])

    def test_a_vendor_take_sends_no_prompt(self) -> None:
        tt, patch = hermes(_get_provider=lambda cfg: "groq")
        with patch:
            dictation.transcribe(
                b"x", "audio/webm", "Gots", "so far", ["DeepSeek"], hearing=True, last=True, profile="p"
            )
        self.assertEqual(tt.calls, [])
        self.assertEqual(len(tt.audio), 1)

    def test_a_take_past_the_cap_is_refused_and_dropped(self) -> None:
        tt, patch = hermes(_get_provider=lambda cfg: "groq")
        big = b"x" * (dictation.MAX_BYTES - 1)
        with patch:
            dictation.transcribe(big, "audio/webm", hearing=True, profile="p")
            with self.assertRaises(dictation.DictationError) as caught:
                dictation.transcribe(b"xx", "audio/webm", hearing=True, profile="p")
        self.assertEqual(caught.exception.status, 413)
        self.assertEqual(dictation._buffers, {}, "the dropped take holds nothing after the refusal")

    def test_a_take_left_alone_is_dropped_after_its_wait(self) -> None:
        tt, patch = hermes(_get_provider=lambda cfg: "groq")
        with patch:
            dictation.transcribe(b"old", "audio/webm", hearing=True, profile="p")
            later = dictation.time.monotonic() + dictation.BUFFER_SECONDS + 1
            with mock.patch.object(dictation.time, "monotonic", return_value=later):
                dictation.transcribe(b"tail", "audio/webm", hearing=True, last=True, profile="p")
        self.assertEqual([call["data"] for call in tt.audio], [b"tail"])

    def test_a_new_take_drops_what_a_cancelled_one_left_held(self) -> None:
        tt, patch = hermes(_get_provider=lambda cfg: "groq")
        with patch:
            dictation.transcribe(b"cancelled", "audio/webm", hearing=True, profile="p")
            dictation.transcribe(b"new", "audio/webm", hearing=True, first=True, last=True, profile="p")
        self.assertEqual([call["data"] for call in tt.audio], [b"new"])

    def test_two_profiles_hold_their_own_takes(self) -> None:
        tt, patch = hermes(_get_provider=lambda cfg: "groq")
        with patch:
            dictation.transcribe(b"a", "audio/webm", hearing=True, profile="one")
            dictation.transcribe(b"b", "audio/webm", hearing=True, profile="two")
            dictation.transcribe(b"c", "audio/webm", hearing=True, last=True, profile="one")
            dictation.transcribe(b"d", "audio/webm", hearing=True, last=True, profile="two")
        self.assertEqual([call["data"] for call in tt.audio], [b"ac", b"bd"])

    def test_a_failure_is_hermes_reason_and_ends_the_take(self) -> None:
        broken = lambda path, source=None: {"success": False, "error": "GROQ_API_KEY not set"}
        tt, patch = hermes(_get_provider=lambda cfg: "groq", transcribe_audio=broken)
        with patch, self.assertRaises(dictation.DictationError) as caught:
            dictation.transcribe(b"x", "audio/webm", hearing=True, last=True, profile="p")
        self.assertEqual((str(caught.exception), caught.exception.status), ("GROQ_API_KEY not set", 502))
        self.assertEqual(dictation._buffers, {}, "a failed take is not kept for the next piece")

    def test_a_dispatcher_that_takes_no_source_label_still_decodes(self) -> None:
        tt, patch = hermes(_get_provider=lambda cfg: "groq")
        tt.transcribe_audio = lambda path: {"success": True, "transcript": " Done. "}
        with patch:
            result = dictation.transcribe(b"x", "audio/webm", hearing=True, last=True, profile="p")
        self.assertEqual(result["text"], "Done.")


class WarmTest(unittest.TestCase):
    def test_a_host_with_nobody_to_hear_it_asks_hermes_to_install(self) -> None:
        asked = []
        lease = types.ModuleType("tools.stt_lease")
        lease.warm_stt_provider = lambda provider=None: asked.append(provider) or {
            "warmed": False,
            "action": "error",
            "error": "faster-whisper not installed",
        }
        _, patch = hermes(_get_provider=lambda cfg: "none")
        with patch, mock.patch.dict("sys.modules", {"tools.stt_lease": lease}):
            answer = dictation.warm()
        self.assertEqual(asked, ["local"], "the install rides warm, asked for the one it can fill")
        self.assertFalse(answer["warmed"])
        self.assertEqual(answer["reason"], dictation.NO_PROVIDER)
        self.assertEqual(answer["error"], "faster-whisper not installed")

    def test_a_cloud_host_has_nothing_to_warm(self) -> None:
        asked = []
        lease = types.ModuleType("tools.stt_lease")
        lease.warm_stt_provider = lambda provider=None: asked.append(provider) or {"warmed": True}
        _, patch = hermes(_get_provider=lambda cfg: "groq")
        with patch, mock.patch.dict("sys.modules", {"tools.stt_lease": lease}):
            answer = dictation.warm()
        self.assertEqual(asked, [], "a take going to a provider has no model here to load")
        self.assertEqual(answer, {"warmed": False, "action": "noop"})

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
