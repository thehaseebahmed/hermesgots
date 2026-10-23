"""Tests for the host's speech model and the model a phrase's cleanup runs on (``plugin/speech.py``).

The host's config and the model load are scripted, so these assert the promises a pick rests on: the
list says each model's size and speed, which the host already has and which is in play; a pick
writes the one key and a refusal leaves the old model in place; a model that won't load falls back
to the model that last did, with a warning, and never becomes the model in play itself; and the
cleanup model is gated on the host's model-override permission, read with each take, and kept
across a restart. No faster-whisper, no network.
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from plugin import speech


def stt(model="base", **extra):
    return {"enabled": True, "local": {"model": model, **extra}}


class Host:

    def __init__(self, section=None):
        self.section = stt() if section is None else section
        self.writes = []
        self.fail = None

    def __enter__(self):
        self._stt = mock.patch.object(speech, "_stt", lambda path, strict=False: dict(self.section))
        self._write = mock.patch.object(speech, "_write_stt", self._save)
        self._roots = mock.patch.object(speech, "cache_roots", lambda section: [Path("/nowhere")])
        self._stt.start()
        self._write.start()
        self._roots.start()
        return self

    def _save(self, path, section):
        if self.fail is not None:
            raise self.fail
        self.writes.append(section)
        self.section = section

    def __exit__(self, *rest):
        self._roots.stop()
        self._write.stop()
        self._stt.stop()
        return False


class TempStore(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "memento.db"
        self.config = Path(self.tmp.name) / "config.yaml"


class CatalogueTest(unittest.TestCase):
    def test_every_model_carries_a_size_and_a_speed(self) -> None:
        for entry in speech.catalogue():
            self.assertIsInstance(entry["size_mb"], int, entry["name"])
            self.assertGreater(entry["size_mb"], 0)
            self.assertIsInstance(entry["speed"], float, entry["name"])
            self.assertGreater(entry["speed"], 0)

    def test_a_model_too_large_to_keep_up_on_a_cpu_is_marked(self) -> None:
        rows = {entry["name"]: entry for entry in speech.catalogue()}
        self.assertTrue(rows["large-v3"]["slow_on_cpu"])
        self.assertTrue(rows["medium"]["slow_on_cpu"])
        self.assertFalse(rows["small"]["slow_on_cpu"])

    def test_a_name_hermes_resolves_is_saved_as_the_model_it_means(self) -> None:
        self.assertEqual(speech.clean_model(" large "), "large-v3")
        self.assertEqual(speech.clean_model("Turbo"), "large-v3-turbo")
        self.assertEqual(speech.clean_model("base"), "base")

    def test_an_unknown_or_empty_model_is_refused_with_its_name(self) -> None:
        for value in ("", "   ", None, 3, "enormous"):
            with self.assertRaises(ValueError):
                speech.clean_model(value)
        with self.assertRaisesRegex(ValueError, "enormous"):
            speech.clean_model("enormous")


class ReadTest(TempStore):
    def test_the_pick_and_the_list_it_is_chosen_from(self) -> None:
        with Host(stt("small")):
            payload = speech.read(self.config, self.path, {"model": True, "provider": True})
        self.assertEqual(payload["model"], "small")
        rows = {row["name"]: row for row in payload["models"]}
        self.assertTrue(rows["small"]["in_use"])
        self.assertFalse(rows["base"]["in_use"])
        self.assertEqual((rows["base"]["size_mb"], rows["base"]["speed"]), (145, 16.0))
        self.assertEqual(len(rows), len(speech.names()))

    def test_the_host_s_own_cache_says_which_models_it_has(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            (Path(root) / "models--Systran--faster-whisper-small").mkdir()
            with Host(stt("small")):
                with mock.patch.object(speech, "cache_roots", lambda section: [Path(root)]):
                    payload = speech.read(self.config, self.path, {})
        rows = {row["name"]: row for row in payload["models"]}
        self.assertTrue(rows["small"]["downloaded"])
        self.assertFalse(rows["base"]["downloaded"])

    def test_a_pick_the_host_does_not_have_reports_that_it_will_download(self) -> None:
        with Host(stt("small")):
            payload = speech.read(self.config, self.path, {})
        rows = {row["name"]: row for row in payload["models"]}
        self.assertFalse(rows["small"]["downloaded"])
        self.assertTrue(rows["small"]["downloading"], "the next take downloads it")
        self.assertFalse(rows["base"]["downloading"])

    def test_a_hand_written_model_is_still_named_as_the_one_in_use(self) -> None:
        with Host(stt("my-own-whisper")):
            payload = speech.read(self.config, self.path, {})
        rows = payload["models"]
        self.assertEqual(rows[0]["name"], "my-own-whisper")
        self.assertTrue(rows[0]["in_use"])
        self.assertIsNone(rows[0]["size_mb"])

    def test_the_default_is_what_the_host_hears_on_with_nothing_set(self) -> None:
        with Host({}):
            payload = speech.read(self.config, self.path, {})
        self.assertEqual(payload["model"], speech.DEFAULT_MODEL)
        self.assertTrue({row["name"] for row in payload["models"] if row["in_use"]})


class SetModelTest(TempStore):
    def test_a_pick_writes_the_host_s_speech_model_and_nothing_else(self) -> None:
        with Host(stt("base", device="cpu", compute_type="int8")) as host:
            saved = speech.set_model(self.config, "small")
        self.assertEqual(saved, "small")
        self.assertEqual(host.section["local"]["model"], "small")
        self.assertEqual(host.section["local"]["device"], "cpu")
        self.assertEqual(host.section["local"]["compute_type"], "int8")
        self.assertTrue(host.section["enabled"])
        self.assertEqual(host.writes[0]["local"]["model"], "small")

    def test_a_model_the_host_does_not_have_keeps_every_other_key(self) -> None:
        other = {"enabled": True, "provider": "local", "local": {"model": "base", "language": "en"}}
        with Host(other) as host:
            speech.set_model(self.config, "small")
        self.assertEqual(host.section["enabled"], True)
        self.assertEqual(host.section["provider"], "local")
        self.assertEqual(host.section["local"], {"model": "small", "language": "en"})

    def test_a_refused_name_writes_nothing_and_leaves_the_old_model(self) -> None:
        with Host(stt("base")) as host:
            with self.assertRaises(ValueError):
                speech.set_model(self.config, "enormous")
        self.assertEqual(host.writes, [])
        self.assertEqual(host.section["local"]["model"], "base")

    def test_a_write_the_host_refuses_leaves_the_old_model_in_place(self) -> None:
        with Host(stt("base")) as host:
            host.fail = OSError("config.yaml is read-only")
            with self.assertRaisesRegex(OSError, "read-only"):
                speech.set_model(self.config, "small")
        self.assertEqual(host.writes, [])
        self.assertEqual(host.section["local"]["model"], "base")

    def test_a_file_the_host_could_not_read_is_never_written_over(self) -> None:
        write = mock.Mock()
        with mock.patch.object(speech, "_stt", side_effect=ImportError("no gateway")), \
                mock.patch.object(speech, "_write_stt", write):
            with self.assertRaises(ImportError):
                speech.set_model(self.config, "small")
        write.assert_not_called()

    def test_choosing_the_model_already_in_place_writes_nothing(self) -> None:
        with Host(stt("small")) as host:
            self.assertEqual(speech.set_model(self.config, "small"), "small")
        self.assertEqual(host.writes, [])


class PlayTest(TempStore):

    def warmer(self, loaded, fail=()):
        calls = []

        def warm(model):
            calls.append(model)
            if model in fail:
                return {"warmed": False, "error": f"{model}: it could not be downloaded"}
            loaded.append(model)
            return {"warmed": True, "model": model}

        return warm, calls

    def test_a_model_that_loads_is_the_model_in_play(self) -> None:
        loaded = []
        warm, _ = self.warmer(loaded)
        played = speech.play("small", warm, self.path)
        self.assertEqual(played, {"model": "small", "warning": None})
        self.assertEqual(speech.good(self.path), "small")
        self.assertIsNone(speech.read(self.config, self.path, {})["warning"])

    def test_a_model_that_will_not_load_falls_back_with_a_warning(self) -> None:
        loaded = []
        warm, calls = self.warmer(loaded, fail={"small"})
        speech.play("base", warm, self.path)
        played = speech.play("small", warm, self.path)
        self.assertEqual(played["model"], "base", "the take carries on on the old model")
        self.assertEqual(played["warning"]["model"], "small")
        self.assertIn("small", played["warning"]["reason"])
        self.assertEqual(calls, ["base", "small", "base"], "the old model is asked for again")
        self.assertEqual(speech.good(self.path), "base")

    def test_a_failure_is_never_the_model_in_play(self) -> None:
        loaded = []
        warm, _ = self.warmer(loaded, fail={"small"})
        speech.play("base", warm, self.path)
        speech.play("small", warm, self.path)
        again = speech.play("small", warm, self.path)
        self.assertEqual((again["model"], again["warning"]["model"]), ("base", "small"))

    def test_the_fallback_is_kept_across_a_restart(self) -> None:
        loaded = []
        warm, _ = self.warmer(loaded, fail={"small"})
        speech.play("base", warm, self.path)
        played = speech.play("small", warm, self.path)
        self.assertEqual(played["model"], "base")
        self.assertEqual(speech.good(self.path), "base")

    def test_a_model_that_loads_clears_the_warning_it_left(self) -> None:
        loaded = []
        warm, _ = self.warmer(loaded, fail={"small"})
        speech.play("base", warm, self.path)
        speech.play("small", warm, self.path)
        self.assertIsNotNone(speech.read(self.config, self.path, {})["warning"])
        speech.play("small", lambda model: {"warmed": True}, self.path)
        self.assertIsNone(speech.read(self.config, self.path, {})["warning"])
        self.assertEqual(speech.good(self.path), "small")

    def test_with_nothing_to_fall_back_to_the_take_cannot_start(self) -> None:
        loaded = []
        warm, _ = self.warmer(loaded, fail={"small"})
        with self.assertRaises(speech.SpeechError) as caught:
            speech.play("small", warm, self.path)
        self.assertEqual(caught.exception.status, 502)
        self.assertIn("small", str(caught.exception))

    def test_a_fallback_that_fails_too_says_so(self) -> None:
        loaded = []
        warm, _ = self.warmer(loaded)
        speech.play("base", warm, self.path)
        broken = lambda model: {"warmed": False, "error": f"{model}: no disk"}
        with self.assertRaises(speech.SpeechError):
            speech.play("small", broken, self.path)


class CleanupTest(TempStore):
    allowed = {"model": True, "provider": True}
    denied = {"model": False, "provider": False}

    def test_a_pick_is_stored_with_the_bot_and_read_back(self) -> None:
        saved = speech.set_cleanup(self.path, {"provider": "acme", "model": "fast"}, self.allowed)
        self.assertEqual(saved, {"provider": "acme", "model": "fast"})
        self.assertEqual(speech.read_cleanup(self.path), {"provider": "acme", "model": "fast"})

    def test_a_pick_is_cleared_back_to_the_bot_s_own_model(self) -> None:
        speech.set_cleanup(self.path, {"provider": "acme", "model": "fast"}, self.allowed)
        self.assertIsNone(speech.set_cleanup(self.path, None, self.allowed))
        self.assertIsNone(speech.read_cleanup(self.path))

    def test_the_permission_gates_the_pick_and_says_why_not(self) -> None:
        with self.assertRaises(speech.Withheld) as caught:
            speech.set_cleanup(self.path, {"provider": "acme", "model": "fast"}, self.denied)
        self.assertIn("model", str(caught.exception).lower())
        self.assertIsNone(speech.read_cleanup(self.path), "a withheld pick stores nothing")
        state = speech.cleanup_state(self.path, self.denied)
        self.assertFalse(state["allowed"])
        self.assertIn("hermes plugins enable memento", state["reason"])

    def test_a_pick_needs_both_halves_of_the_permission(self) -> None:
        with self.assertRaises(speech.Withheld):
            speech.set_cleanup(self.path, {"provider": "acme", "model": "fast"}, {"model": True, "provider": False})

    def test_a_stored_pick_is_ignored_where_the_permission_was_taken_back(self) -> None:
        speech.set_cleanup(self.path, {"provider": "acme", "model": "fast"}, self.allowed)
        self.assertEqual(speech.applied_cleanup(self.path, self.allowed)["model"], "fast")
        self.assertIsNone(speech.applied_cleanup(self.path, self.denied))

    def test_a_pick_a_take_was_started_with_is_what_the_next_one_reads(self) -> None:
        self.assertIsNone(speech.applied_cleanup(self.path, self.allowed))
        speech.set_cleanup(self.path, {"provider": "acme", "model": "fast"}, self.allowed)
        self.assertEqual(speech.applied_cleanup(self.path, self.allowed), {"provider": "acme", "model": "fast"})

    def test_a_pick_the_host_would_refuse_writes_nothing(self) -> None:
        with Host(stt("base")):
            with mock.patch.object(speech, "_main_config", lambda path: {}):
                with mock.patch("plugin.host_model.check_pick", side_effect=ValueError("no such provider")):
                    with self.assertRaisesRegex(ValueError, "no such provider"):
                        speech.set_cleanup(
                            self.path, {"provider": "acme", "model": "fast"}, self.allowed, self.config
                        )
        self.assertIsNone(speech.read_cleanup(self.path))

    def test_a_pick_the_bot_already_holds_is_not_checked_again(self) -> None:
        speech.set_cleanup(self.path, {"provider": "acme", "model": "fast"}, self.allowed)
        with mock.patch("plugin.host_model.check_pick", side_effect=AssertionError("probed again")):
            same = speech.set_cleanup(
                self.path, {"provider": "acme", "model": "fast"}, self.allowed, self.config
            )
        self.assertEqual(same, {"provider": "acme", "model": "fast"})


if __name__ == "__main__":
    unittest.main()
