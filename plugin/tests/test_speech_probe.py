"""Tests for a host's measurement of its own hearing, and the model it recommends
(``plugin/speech_probe.py``, ADR 0075).

The decode is scripted, so these assert the promises a picker's rows rest on: the fixture is the
bench's own recording and says how long it takes; a measurement is taken per model on disk and kept
with the model and the machine; a model that won't load is left out rather than failing the probe; a
take being heard holds the probe off; a record from another machine, or one taken on other bytes, is
never presented as this host's; and the recommendation is one row, drawn only from what was measured
and the catalogue's sizes.

No faster-whisper, no network, no sleep worth the wall clock.
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from typing import Any, Dict, List
from unittest import mock

from plugin import dictation, speech, speech_probe
from plugin.store import get_setting, put_setting
from plugin.tests._helpers import js_number, probe_record

BENCH_FIXTURE = Path(__file__).resolve().parents[2] / "bench" / "dictation" / "fixtures" / "one-piece.wav"
MOCK = Path(__file__).resolve().parents[2] / "app" / "scripts" / "mock-hermes.mjs"


class Hearing:
    """Hermes's local decode, scripted: which models load, and how many times each was asked.

    Hermes answers a model it couldn't load as a result — ``{"success": False, "error": …}`` — and
    only really raises for something unexpected, so both shapes are scripted here: ``broken`` models
    answer the failure the host really answers, and ``raises`` ones raise.
    """

    # Hermes's own flag, read by ``dictation._installed``: without it a probe refuses before decoding,
    # so the fake has to say the decoder is here, as the real module does.
    _HAS_FASTER_WHISPER = True

    def __init__(self, broken: Any = (), raises: Any = ()) -> None:
        self.broken = set(broken)
        self.raises = set(raises)
        self.calls: List[Dict[str, Any]] = []

    def _transcribe_local(self, path: str, model: str, prompt: Any = None) -> Dict[str, Any]:
        self.calls.append({"path": path, "model": model, "prompt": prompt})
        if model in self.raises:
            raise RuntimeError(f"{model} isn't on this host")
        if model in self.broken:
            return {"success": False, "error": f"{model} isn't on this host"}
        return {"success": True, "transcript": "Remind me to call the dentist.", "provider": "local"}

    def models(self) -> List[str]:
        return [call["model"] for call in self.calls]


class Timed:
    """``_timed`` scripted by model and by which decode of it this is: the warm one, then the real one.

    A probe decodes a model twice — the first warms it, the second is the number — so this answers
    the two calls differently and records what it was asked, which is how the load is held to being
    recorded rather than read as slowness.
    """

    def __init__(self, answers: Dict[str, Any]) -> None:
        self.answers = answers
        self.calls: List[str] = []

    def __call__(self, decode: Any, fixture: Path, name: str) -> int:
        self.calls.append(name)
        answers = self.answers[name]
        return answers[0] if self.calls.count(name) == 1 else answers[1]


class Base(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "memento.db"
        self.fixture = Path(self.tmp.name) / "probe.wav"
        self.real = speech_probe.FIXTURE

    def host(self, broken: Any = (), raises: Any = ()) -> Any:
        """Puts a scripted Hermes behind ``dictation._tools`` and keeps the call log to look at."""
        hearing = Hearing(broken, raises)
        return mock.patch.object(dictation, "_tools", lambda: hearing), hearing


class FixtureTest(unittest.TestCase):
    def test_the_probe_hears_the_bench_s_own_recording(self) -> None:
        self.assertTrue(speech_probe.FIXTURE.exists(), "the plugin carries the recording it times")
        self.assertEqual(
            speech_probe.FIXTURE.read_bytes(),
            BENCH_FIXTURE.read_bytes(),
            "one recording, so a probe and a bench run on this host hear the same bytes",
        )

    def test_the_recording_s_own_header_says_how_long_it_takes_to_say(self) -> None:
        self.assertEqual(speech_probe.spoken_ms(), 2977, "a WAV says its own length; nothing is guessed")
        self.assertEqual(speech_probe.digest(), "157068a5c157fc31b3260951e80eeabec120bb1283fd8b37fb765e592a975c7e")

    def test_a_missing_recording_is_a_host_with_nothing_to_measure_with(self) -> None:
        with self.assertRaises(speech_probe.Unavailable) as caught:
            speech_probe.spoken_ms(Path("/nowhere/probe.wav"))
        self.assertIn("missing the recording", str(caught.exception))


class MeasureTest(Base):
    def test_a_measurement_is_kept_with_the_model_it_was_taken_on(self) -> None:
        timed = Timed({"base": (900, 500), "small": (2000, 2000)})
        with self.host()[0], mock.patch.object(speech_probe, "_timed", timed), mock.patch.object(
            speech_probe, "FIXTURE", self.fixture
        ):
            self.fixture.write_bytes(self.real.read_bytes())
            record = speech_probe.measure(self.path, ["base", "small"])
        self.assertEqual(sorted(record["models"]), ["base", "small"])
        self.assertEqual(record["models"]["base"]["decode_ms"], 500)
        self.assertEqual(record["models"]["base"]["load_ms"], 900, "the load is recorded beside the decode")
        self.assertEqual(record["models"]["base"]["realtime"], 5.95, "2977 ms of speech in 500 ms")
        self.assertEqual(record["models"]["small"]["realtime"], 1.49)
        self.assertEqual(record["host"], speech_probe.machine())
        self.assertEqual(record["fixture"]["sha256"], speech_probe.digest())
        self.assertEqual(get_setting(self.path, speech_probe.KEY)["models"]["base"]["realtime"], 5.95)

    def test_the_factor_is_the_warm_decode_s_and_never_the_load(self) -> None:
        timed = Timed({"base": (9000, 500)})
        with self.host()[0], mock.patch.object(speech_probe, "_timed", timed), mock.patch.object(
            speech_probe, "FIXTURE", self.fixture
        ):
            self.fixture.write_bytes(self.real.read_bytes())
            record = speech_probe.measure(self.path, ["base"])
        self.assertEqual(timed.calls, ["base", "base"], "one decode warms the model, the next is timed")
        self.assertEqual(record["models"]["base"]["realtime"], 5.95, "a nine-second load is not the speed")

    def test_a_model_the_host_answers_a_failure_for_is_left_out(self) -> None:
        host = self.host(broken={"small"})
        with host[0], mock.patch.object(speech_probe, "FIXTURE", self.fixture):
            self.fixture.write_bytes(self.real.read_bytes())
            with self.assertLogs("plugin.speech_probe", "WARNING") as said:
                record = speech_probe.measure(self.path, ["base", "small"])
        self.assertEqual(sorted(record["models"]), ["base"], "a half-fetched model measures nothing")
        self.assertIn("small", host[1].models(), "it was tried, so the record is not silent about it")
        self.assertIn("small", "\n".join(said.output), "and the host's own reason is what was logged")

    def test_a_probe_that_loaded_nothing_is_not_a_measurement(self) -> None:
        host = self.host(broken={"base", "small"})
        with host[0], mock.patch.object(speech_probe, "FIXTURE", self.fixture):
            self.fixture.write_bytes(self.real.read_bytes())
            with self.assertLogs("plugin.speech_probe", "WARNING"):
                with self.assertRaises(speech_probe.Unavailable) as caught:
                    speech_probe.measure(self.path, ["base", "small"])
        self.assertIn("measured nothing", str(caught.exception))
        self.assertIsNone(get_setting(self.path, speech_probe.KEY), "a record of nothing is not kept")

    def test_a_take_being_heard_holds_the_probe_off(self) -> None:
        with mock.patch.object(dictation, "holds_a_take", lambda: True):
            with self.assertRaises(speech_probe.Busy):
                speech_probe.measure(self.path, ["base"])
        self.assertIsNone(get_setting(self.path, speech_probe.KEY), "nothing is measured under a take")

    def test_a_probe_asked_for_one_model_adds_to_the_record_it_held(self) -> None:
        timed = Timed({"small": (900, 2000)})
        with self.host()[0], mock.patch.object(speech_probe, "_timed", timed), mock.patch.object(
            speech_probe, "FIXTURE", self.fixture
        ):
            self.fixture.write_bytes(self.real.read_bytes())
            record = speech_probe.measure(
                self.path, ["small"], keep={"base": {"realtime": 9.4, "decode_ms": 500}}
            )
        self.assertEqual(sorted(record["models"]), ["base", "small"], "the earlier number stands")
        self.assertEqual(get_setting(self.path, speech_probe.KEY)["models"]["base"]["realtime"], 9.4)

    def test_a_probe_that_measured_nothing_new_leaves_the_record_alone(self) -> None:
        host = self.host(broken={"small"})
        with host[0], mock.patch.object(speech_probe, "FIXTURE", self.fixture):
            self.fixture.write_bytes(self.real.read_bytes())
            with self.assertLogs("plugin.speech_probe", "WARNING"):
                answer = speech_probe.measure(
                    self.path, ["small"], keep={"base": {"realtime": 9.4, "decode_ms": 500}}
                )
        self.assertIsNone(answer, "nothing new is not an error when a record already stands")
        self.assertIsNone(get_setting(self.path, speech_probe.KEY), "and nothing was written")

    def test_a_decode_that_raises_is_left_out_too(self) -> None:
        host = self.host(raises={"small"})
        with host[0], mock.patch.object(speech_probe, "FIXTURE", self.fixture):
            self.fixture.write_bytes(self.real.read_bytes())
            with self.assertLogs("plugin.speech_probe", "WARNING"):
                record = speech_probe.measure(self.path, ["base", "small"])
        self.assertEqual(sorted(record["models"]), ["base"])

    def test_a_host_with_no_decoder_installed_is_never_asked_to_install_one(self) -> None:
        host = self.host()
        host[1]._HAS_FASTER_WHISPER = False
        with host[0], mock.patch.object(speech_probe, "FIXTURE", self.fixture):
            self.fixture.write_bytes(self.real.read_bytes())
            with self.assertRaises(speech_probe.Unavailable) as caught:
                speech_probe.measure(self.path, ["base"])
        self.assertIn("no local speech-to-text", str(caught.exception))
        self.assertEqual(host[1].calls, [], "nothing was decoded, so nothing could be installed")

    def test_a_host_with_no_local_decode_has_nothing_to_time(self) -> None:
        empty = mock.Mock(spec=[])
        with mock.patch.object(dictation, "_tools", lambda: empty):
            with self.assertRaises(speech_probe.Unavailable) as caught:
                speech_probe.measure(self.path, ["base"])
        self.assertIn("no local speech-to-text", str(caught.exception))

    def test_a_missing_hermes_module_is_the_same_answer(self) -> None:
        def missing() -> Any:
            raise ImportError("no tools here")

        with mock.patch.object(dictation, "_tools", missing):
            with self.assertRaises(speech_probe.Unavailable):
                speech_probe.measure(self.path, ["base"])


class MockTest(unittest.TestCase):
    """The test host restates the recommendation's threshold, so this holds the copy to this module."""

    def test_the_test_host_states_the_same_threshold(self) -> None:
        self.assertEqual(js_number(MOCK.read_text(), "KEEP_UP"), speech_probe.KEEP_UP)


class RecommendTest(unittest.TestCase):
    sizes = {"tiny": 75, "base": 145, "small": 484, "medium": 1530, "large-v3": 3090}

    def test_the_heaviest_model_that_keeps_up_is_the_one_recommended(self) -> None:
        measured = {
            "tiny": {"realtime": 40.0},
            "base": {"realtime": 9.0},
            "small": {"realtime": 3.1},
            "large-v3": {"realtime": 0.4},
        }
        self.assertEqual(speech_probe.recommend(measured, self.sizes), "small")

    def test_a_model_that_cannot_keep_up_is_never_the_recommendation_while_one_can(self) -> None:
        measured = {"tiny": {"realtime": 40.0}, "large-v3": {"realtime": 0.4}}
        self.assertEqual(speech_probe.recommend(measured, self.sizes), "tiny")

    def test_where_nothing_keeps_up_the_fastest_is_the_best_this_host_can_do(self) -> None:
        measured = {"base": {"realtime": 1.4}, "small": {"realtime": 0.6}}
        self.assertEqual(speech_probe.recommend(measured, self.sizes), "base")

    def test_where_nothing_was_measured_nothing_is_recommended(self) -> None:
        self.assertIsNone(speech_probe.recommend({}, self.sizes))


class StateTest(Base):
    def test_a_host_with_no_record_is_owed_a_measurement(self) -> None:
        state = speech_probe.state(self.path, speech.sizes(), ["base"])
        self.assertTrue(state["owed"])
        self.assertEqual(state["models"], {})
        self.assertIsNone(state["recommended"])
        self.assertIsNone(state["elsewhere"])
        self.assertIsNone(state["reason"])

    def test_a_record_of_this_machine_reads_back_per_model(self) -> None:
        put_setting(self.path, speech_probe.KEY, probe_record({"base": 9.0, "small": 3.1}))
        state = speech_probe.state(self.path, speech.sizes(), ["base", "small"])
        self.assertFalse(state["owed"])
        self.assertEqual(sorted(state["models"]), ["base", "small"])
        self.assertEqual(state["models"]["base"]["realtime"], 9.0)
        self.assertEqual(state["recommended"], "small", "the heaviest that keeps up")
        self.assertEqual(state["at"], "2026-11-02T10:00:00Z")

    def test_a_record_from_another_machine_is_not_this_host_s(self) -> None:
        elsewhere = {**speech_probe.machine(), "name": "somebody-elses-laptop", "cpus": 4}
        put_setting(self.path, speech_probe.KEY, probe_record({"large-v3": 40.0}, host=elsewhere))
        state = speech_probe.state(self.path, speech.sizes(), ["large-v3"])
        self.assertTrue(state["owed"], "another machine's measurement is not this host's")
        self.assertEqual(state["models"], {}, "and its numbers are not drawn anywhere")
        self.assertIsNone(state["recommended"])
        self.assertEqual(state["elsewhere"]["name"], "somebody-elses-laptop")

    def test_a_record_taken_on_other_bytes_is_owed_a_fresh_one(self) -> None:
        put_setting(self.path, speech_probe.KEY, probe_record({"base": 9.0}, sha="0" * 64))
        state = speech_probe.state(self.path, speech.sizes(), ["base"])
        self.assertTrue(state["owed"])
        self.assertEqual(state["models"], {})
        self.assertIsNone(state["elsewhere"], "another recording is not another machine")

    def test_a_record_that_names_no_bytes_is_owed_a_fresh_one(self) -> None:
        record = probe_record({"base": 9.0})
        record["fixture"] = {"bytes": 95300, "ms": 2977}
        put_setting(self.path, speech_probe.KEY, record)
        state = speech_probe.state(self.path, speech.sizes(), ["base"])
        self.assertTrue(state["owed"], "a record that can't say which bytes it heard is not a measurement")
        self.assertEqual(state["models"], {})

    def test_a_record_taken_under_another_python_is_still_this_machine(self) -> None:
        elsewhere = {**speech_probe.machine(), "python": "3.9.0"}
        put_setting(self.path, speech_probe.KEY, probe_record({"base": 9.0}, host=elsewhere))
        state = speech_probe.state(self.path, speech.sizes(), ["base"])
        self.assertFalse(state["owed"], "an interpreter upgrade is the same machine")
        self.assertIsNone(state["elsewhere"])
        self.assertEqual(state["models"]["base"]["realtime"], 9.0)

    def test_a_record_named_like_this_host_with_other_hardware_is_unnamed(self) -> None:
        elsewhere = {**speech_probe.machine(), "cpus": 2}
        put_setting(self.path, speech_probe.KEY, probe_record({"base": 9.0}, host=elsewhere))
        state = speech_probe.state(self.path, speech.sizes(), ["base"])
        self.assertTrue(state["owed"])
        self.assertEqual(state["elsewhere"]["name"], "", "never 'measured on this host, not this host'")

    def test_nothing_on_disk_says_there_is_nothing_to_time(self) -> None:
        state = speech_probe.state(self.path, speech.sizes(), [])
        self.assertTrue(state["owed"])
        self.assertEqual(state["reason"], speech_probe.NOTHING_ON_DISK)

    def test_a_model_downloaded_since_the_probe_is_owed_a_measurement_of_its_own(self) -> None:
        put_setting(self.path, speech_probe.KEY, probe_record({"base": 9.4}))
        state = speech_probe.state(self.path, speech.sizes(), ["base", "small"])
        self.assertTrue(state["owed"], "the record speaks for base and not for small")
        self.assertEqual(state["models"]["base"]["realtime"], 9.4, "and what it had is still drawn")
        self.assertFalse(speech_probe.state(self.path, speech.sizes(), ["base"])["owed"])

    def test_a_record_that_is_not_one_is_ignored(self) -> None:
        put_setting(self.path, speech_probe.KEY, {"object": "something else", "models": {"base": 1}})
        self.assertTrue(speech_probe.state(self.path, speech.sizes(), ["base"])["owed"])
        put_setting(self.path, speech_probe.KEY, {"object": speech_probe.OBJECT, "models": {}})
        self.assertTrue(speech_probe.state(self.path, speech.sizes(), ["base"])["owed"])


class ModelsTest(unittest.TestCase):
    def test_the_model_in_play_is_heard_last_so_the_host_is_left_warm_on_it(self) -> None:
        self.assertEqual(
            speech_probe.models_present(["tiny", "base", "small"], "small"),
            ["tiny", "base", "small"],
        )
        self.assertEqual(
            speech_probe.models_present(["tiny", "base"], "medium"),
            ["tiny", "base"],
            "a model this host doesn't have is never heard, so a probe downloads nothing",
        )
        self.assertEqual(speech_probe.models_present([], "base"), [])


if __name__ == "__main__":
    unittest.main()
