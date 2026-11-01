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

from plugin import dictation, dictation_cleanup


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
                    "wait_ms": 38_000,
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


class TakeTest(unittest.TestCase):
    """A take is held on the host under the app's id, and heard as its Pieces land (ADR 0074)."""

    def setUp(self) -> None:
        self.forget()

    def tearDown(self) -> None:
        self.forget()

    def forget(self) -> None:
        for profile, take in list(dictation._takes):
            dictation.cancel(profile, take)

    def upload(self, take="take-1", index=0, data=b"one", profile="p", ms=2500, **options):
        return dictation.upload(
            profile,
            take,
            index,
            data,
            "audio/webm;codecs=opus",
            hearing=True,
            ms=ms,
            **options,
        )

    def held(self, profile="p", take="take-1"):
        return dictation._takes[(profile, take)]

    def heard(self, profile="p", take="take-1"):
        self.wait(
            lambda: all(
                piece["text"] is not None
                for piece in dictation._takes[(profile, take)].pieces.values()
            )
        )

    def wait(self, ready):
        deadline = dictation.time.monotonic() + 5
        while dictation.time.monotonic() < deadline:
            if ready():
                return
            dictation.time.sleep(0.01)
        raise AssertionError("the take's worker never finished")

    def test_a_piece_is_answered_with_its_take_and_index_and_no_words(self) -> None:
        _, patch = hermes()
        with patch:
            answer = self.upload(index=3)
            self.heard()
        self.assertEqual(answer, {"take": "take-1", "index": 3})
        self.assertNotIn("text", answer, "an Upload never carries words")

    def test_the_audio_of_a_piece_heard_here_is_dropped_once_its_words_exist(self) -> None:
        tt, patch = hermes()
        with patch:
            self.upload()
            self.wait(lambda: self.held().pieces[0]["text"] is not None)
        self.assertEqual(self.held().pieces[0]["text"], "Hello there.")
        self.assertIsNone(self.held().pieces[0]["data"], "a local take holds no audio")
        self.assertEqual(len(tt.calls), 1)

    def test_pieces_are_heard_in_the_order_they_arrived(self) -> None:
        heard = {b"a": "second", b"b": "first"}

        def local(path, model, prompt=None):
            with open(path, "rb") as clip:
                return {"success": True, "transcript": heard[clip.read()]}
        _, patch = hermes(_transcribe_local=local)
        with patch:
            self.upload(index=1, data=b"a")
            self.upload(index=0, data=b"b")
            words = dictation.confirm("p", "take-1", 2, level="none")
        self.assertEqual(words["heard"], "second first")

    def test_a_slow_piece_does_not_delay_the_next_upload(self) -> None:
        releasing = types.SimpleNamespace(set=False)
        started = dictation.time.monotonic()

        def local(path, model, prompt=None):
            while not releasing.set and dictation.time.monotonic() - started < 5:
                dictation.time.sleep(0.01)
            return {"success": True, "transcript": "word"}

        _, patch = hermes(_transcribe_local=local)
        with patch:
            self.upload(index=0)
            answered = dictation.time.monotonic()
            self.upload(index=1)
            self.assertLess(
                dictation.time.monotonic() - answered,
                1.0,
                "the answer to a Piece waits for no decode",
            )
            releasing.set = True
            dictation.confirm("p", "take-1", 2, level="none")

    def test_a_take_is_keyed_by_profile_and_id(self) -> None:
        _, patch = hermes()
        with patch:
            self.upload(profile="one", take="a", index=0, data=b"one")
            self.upload(profile="two", take="a", index=0, data=b"two")
            for profile in ("one", "two"):
                self.heard(profile, "a")
            self.assertEqual(self.held("one", "a").order, [0])
            self.assertEqual(self.held("two", "a").order, [0])
            self.assertIsNot(self.held("one", "a"), self.held("two", "a"), "one id, two bots, two takes")

    def test_a_take_left_alone_expires_after_its_window(self) -> None:
        _, patch = hermes()
        with patch:
            self.upload()
            self.heard()
            later = dictation.time.monotonic() + dictation.TAKE_SECONDS + 1
            with mock.patch.object(dictation.time, "monotonic", return_value=later):
                self.upload(take="take-2")
            self.heard(take="take-2")
        self.assertNotIn(("p", "take-1"), dictation._takes, "an expired take holds nothing")

    def test_a_cancelled_take_holds_nothing_and_a_late_piece_starts_none(self) -> None:
        _, patch = hermes()
        with patch:
            self.upload(index=0, data=b"one")
            self.assertTrue(dictation.cancel("p", "take-1"))
            self.assertNotIn(("p", "take-1"), dictation._takes)
            self.assertFalse(dictation.cancel("p", "take-1"), "cancelling twice is not an error")
            self.upload(index=1, data=b"two")
            self.heard()
        self.assertEqual(self.held().order, [1], "a late Piece starts a take of its own")

    def test_a_second_take_on_one_bot_is_refused_while_the_first_is_live(self) -> None:
        _, patch = hermes()
        with patch:
            self.upload(index=0, data=b"one")
            with self.assertRaises(dictation.DictationError) as caught:
                dictation.upload("p", "take-2", 0, b"two", None, hearing=False)
        self.assertEqual(caught.exception.status, 409, "the bot is already hearing a take")
        self.assertEqual(sorted(dictation._takes), [("p", "take-1")], "and the live take is untouched")

    def test_cancelling_the_take_lets_the_bot_hear_another(self) -> None:
        _, patch = hermes()
        with patch:
            self.upload(index=0, data=b"one")
            dictation.cancel("p", "take-1")
            self.upload(index=0, data=b"two", take="take-2")
        self.assertEqual(self.held(take="take-2").order, [0], "the next take opens once the first is gone")

    def test_a_cloud_take_holds_its_audio_and_sends_nothing_yet(self) -> None:
        tt, patch = hermes(_get_provider=lambda cfg: "groq")
        with patch:
            self.upload(index=0, data=b"one")
            self.upload(index=1, data=b"two")
            self.assertEqual(self.held().pieces[0]["data"], b"one")
            self.assertEqual(tt.audio, [], "a cloud take sends nothing before its Confirm")
            self.assertEqual(tt.calls, [], "and never reaches the local model")

    def test_a_cloud_take_past_the_cap_is_refused_at_its_confirm(self) -> None:
        _, patch = hermes(_get_provider=lambda cfg: "groq")
        big = b"x" * (dictation.MAX_BYTES - 1)
        with patch:
            self.upload(index=0, data=big)
            self.upload(index=1, data=b"xx")
            with self.assertRaises(dictation.DictationError) as caught:
                dictation.confirm("p", "take-1", 2, level="none")
        self.assertEqual(caught.exception.status, 413, "the take is refused where it is uploaded whole")
        self.assertEqual(dictation._takes, {}, "and holds nothing after the refusal")

    def test_a_piece_the_host_could_not_hear_fails_the_confirm(self) -> None:
        broken = lambda path, model, prompt=None: {"success": False, "error": "CUDA out of memory"}
        _, patch = hermes(_transcribe_local=broken)
        with patch:
            self.upload()
            with self.assertRaises(dictation.DictationError) as caught:
                dictation.confirm("p", "take-1", 1, level="none")
        self.assertEqual(str(caught.exception), "CUDA out of memory")

    def test_the_takes_worker_stops_when_the_take_is_answered(self) -> None:
        _, patch = hermes()
        with patch:
            self.upload()
            self.heard()
            worker = self.held().worker
            dictation.confirm("p", "take-1", 1, level="none")
            worker.join(5)
        self.assertFalse(worker.is_alive(), "a take's worker ends with the take it heard")

    def test_the_takes_worker_stops_when_the_take_is_cancelled(self) -> None:
        _, patch = hermes()
        with patch:
            self.upload()
            self.heard()
            worker = self.held().worker
            dictation.cancel("p", "take-1")
            worker.join(5)
        self.assertFalse(worker.is_alive(), "a cancelled take's worker ends too")

    def test_the_hosts_route_is_read_when_the_take_opens_and_not_per_piece(self) -> None:
        asked = []

        def provider(cfg):
            asked.append(1)
            return "local"

        _, patch = hermes(_get_provider=provider)
        with patch:
            self.upload(index=0, data=b"one")
            self.upload(index=1, data=b"two")
            self.heard()
        self.assertEqual(len(asked), 1, "every Piece after the first reads nothing")

    def test_a_piece_index_past_what_a_take_can_hold_is_refused(self) -> None:
        _, patch = hermes()
        with patch, self.assertRaises(dictation.DictationError) as caught:
            self.upload(index=dictation.MAX_PIECES)
        self.assertEqual(caught.exception.status, 400)

    def test_an_empty_piece_is_refused(self) -> None:
        _, patch = hermes()
        with patch, self.assertRaises(dictation.DictationError) as caught:
            self.upload(data=b"")
        self.assertEqual(caught.exception.status, 400)


class ConfirmTest(unittest.TestCase):
    """The one call that answers a take's words (ADR 0074)."""

    def setUp(self) -> None:
        for profile, take in list(dictation._takes):
            dictation.cancel(profile, take)

    def tearDown(self) -> None:
        for profile, take in list(dictation._takes):
            dictation.cancel(profile, take)

    def upload(self, index=0, data=b"one", profile="p", take="take-1", ms=2500, **options):
        return dictation.upload(
            profile, take, index, data, "audio/webm", hearing=True, ms=ms, **options
        )

    def test_the_confirm_answers_the_whole_take_in_one_payload(self) -> None:
        _, patch = hermes()
        with patch:
            self.upload(index=0, data=b"one", ms=2000)
            self.upload(index=1, data=b"two", ms=1500)
            answer = dictation.confirm("p", "take-1", 2, level="none")
        self.assertEqual(
            answer,
            {
                "text": "Hello there. Hello there.",
                "heard": "Hello there. Hello there.",
                "ms": 3500,
                "level": "none",
                "cleaned": False,
                "provider": "local",
                "model": "small",
            },
        )

    def test_the_take_ends_when_it_is_answered(self) -> None:
        _, patch = hermes()
        with patch:
            self.upload()
            dictation.confirm("p", "take-1", 1, level="none")
        self.assertNotIn(("p", "take-1"), dictation._takes)

    def test_a_confirm_naming_more_pieces_than_held_names_exactly_the_missing(self) -> None:
        tt, patch = hermes()
        with patch:
            self.upload(index=0)
            self.upload(index=2)
            with self.assertRaises(dictation.MissingPieces) as caught:
                dictation.confirm("p", "take-1", 3, level="none")
            self.assertEqual(caught.exception.missing, [1])
            self.assertEqual(caught.exception.status, 409)
            self.upload(index=1, data=b"two")
            answer = dictation.confirm("p", "take-1", 3, level="none")
        self.assertEqual(answer["heard"], "Hello there. Hello there. Hello there.")

    def test_a_take_the_host_no_longer_holds_is_missing_all_its_pieces(self) -> None:
        _, patch = hermes()
        with patch, self.assertRaises(dictation.MissingPieces) as caught:
            dictation.confirm("p", "gone", 2, level="none")
        self.assertEqual(caught.exception.missing, [0, 1])

    def test_a_confirm_with_no_pieces_is_refused(self) -> None:
        _, patch = hermes()
        with patch, self.assertRaises(dictation.DictationError) as caught:
            dictation.confirm("p", "take-1", 0, level="none")
        self.assertEqual(caught.exception.status, 400)

    def test_no_level_makes_no_model_call_and_lands_the_heard_words(self) -> None:
        asked = []
        _, patch = hermes()
        with patch, mock.patch.object(
            dictation_cleanup, "finish", side_effect=lambda *a, **k: asked.append(k) or {
                "text": a[0],
                "cleaned": False,
                "ms": 0,
                "level": "none",
            }
        ):
            self.upload()
            answer = dictation.confirm("p", "take-1", 1, level="none")
        self.assertEqual(answer["text"], "Hello there.")
        self.assertEqual(asked[0]["prompt"].level, "none")
        self.assertFalse(asked[0]["prompt"].cleaning)

    def test_a_cloud_take_is_uploaded_whole_once_at_the_confirm(self) -> None:
        tt, patch = hermes(_get_provider=lambda cfg: "groq")
        with patch:
            self.upload(index=0, data=b"one")
            self.upload(index=1, data=b"two")
            self.assertEqual(tt.audio, [])
            answer = dictation.confirm("p", "take-1", 2, level="none")
        self.assertEqual([call["data"] for call in tt.audio], [b"onetwo"])
        self.assertEqual(tt.audio[0]["source"], "dictation")
        self.assertFalse(os.path.exists(tt.audio[0]["path"]))
        self.assertEqual(answer["heard"], "Uploaded take.")
        self.assertEqual(answer["provider"], "groq")
        self.assertEqual(answer["model"], "small", "the model the bot picked, cloud or not")
        self.assertEqual(dictation._takes.get(("p", "take-1")), None, "its audio is gone with it")

    def test_a_cloud_take_sends_no_hearing_prompt_and_never_reaches_the_local_model(self) -> None:
        tt, patch = hermes(_get_provider=lambda cfg: "groq")
        with patch:
            self.upload()
            dictation.confirm("p", "take-1", 1, level="none")
        self.assertEqual(tt.calls, [])

    def test_a_vendor_failure_is_hermes_reason_and_ends_the_take(self) -> None:
        broken = lambda path, source=None: {"success": False, "error": "GROQ_API_KEY not set"}
        _, patch = hermes(_get_provider=lambda cfg: "groq", transcribe_audio=broken)
        with patch, self.assertRaises(dictation.DictationError) as caught:
            self.upload()
            dictation.confirm("p", "take-1", 1, level="none")
        self.assertEqual((str(caught.exception), caught.exception.status), ("GROQ_API_KEY not set", 502))
        self.assertIsNone(dictation._takes.get(("p", "take-1")), "a failed take is not kept")

    def test_a_dispatcher_that_takes_no_source_label_still_decodes(self) -> None:
        tt, patch = hermes(_get_provider=lambda cfg: "groq")
        tt.transcribe_audio = lambda path: {"success": True, "transcript": " Done. "}
        with patch:
            self.upload()
            answer = dictation.confirm("p", "take-1", 1, level="none")
        self.assertEqual(answer["text"], "Done.")

    def test_a_cloud_takes_bound_carries_the_upload_its_confirm_makes(self) -> None:
        _, patch = hermes(_get_provider=lambda cfg: "groq")
        with patch:
            state = dictation.info("light")
        self.assertGreaterEqual(
            state["wait_ms"],
            (dictation.QUEUE_SECONDS + dictation.CLOUD_SECONDS) * 1000,
            "a cloud take's Confirm uploads the whole of it, and the bar is told so",
        )

    def test_a_confirm_naming_more_pieces_than_a_take_can_hold_is_refused(self) -> None:
        _, patch = hermes()
        with patch, self.assertRaises(dictation.DictationError) as caught:
            dictation.confirm("p", "take-1", dictation.MAX_PIECES + 1, level="none")
        self.assertEqual(caught.exception.status, 400)

    def test_the_bound_a_confirm_is_held_to_covers_the_queue_and_the_level(self) -> None:
        _, patch = hermes()
        with patch:
            for level in dictation_cleanup.LEVELS:
                state = dictation.info(level)
                self.assertGreaterEqual(
                    state["wait_ms"],
                    (dictation.QUEUE_SECONDS + dictation_cleanup.deadline_of(level)) * 1000,
                    f"the {level} level's bound covers its own Cleanup",
                )


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
        said = ("word " * 200).strip()
        kept = dictation.clean_context(said)
        self.assertLessEqual(len(kept), dictation.MAX_CONTEXT)
        self.assertTrue(said.endswith(kept))
        self.assertFalse(kept.startswith("ord"), "the cut lands on a whole word")


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
