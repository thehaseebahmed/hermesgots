"""Tests for the host's speech model and the model a dictation's cleanup runs on (``plugin/speech.py``).

The host's config and the model load are scripted, so these assert the promises a pick rests on: the
list says each model's size and speed, which the host already has and which is in play; a pick
writes the one key and a refusal leaves the old model in place; a model that won't load falls back
to the model that last did, with a warning, and never becomes the model in play itself; and the
cleanup model is gated on the host's model-override permission, read per request, and kept
across a restart. No faster-whisper, no network.
"""

from __future__ import annotations

import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

from plugin import speech
from plugin.store import put_setting

# Hermes's own ``DEFAULT_CONFIG["stt"]``, as the read is answered from: every key the page draws.
DEFAULTS = {
    "enabled": True,
    "echo_transcripts": True,
    "language": "en",
    "streaming": False,
    "cloud_trim_silence": True,
    "cloud_trim_threshold_db": -40,
    "cloud_trim_keep_ms": 300,
    "local": {
        "model": "base",
        "language": "",
        "initial_prompt": "",
        "vad": True,
        "vad_min_silence_ms": 500,
        "no_speech_prob_threshold": 0.6,
        "logprob_threshold": -1.0,
        "unload_after_idle_seconds": 0,
    },
    "groq": {"model": "whisper-large-v3-turbo", "language": ""},
    "openai": {
        "model": "whisper-1",
        "streaming_model": "gpt-live-transcribe",
        "language": "",
        "timeout": 60,
        "max_retries": 1,
    },
    "mistral": {"model": "voxtral-mini-latest", "language": ""},
    "xai": {"model": "", "language": ""},
    "elevenlabs": {
        "model_id": "scribe_v2",
        "language_code": "",
        "tag_audio_events": False,
        "diarize": False,
    },
    "deepinfra": {"model": ""},
}

# Hermes's ``STT_MODEL_CATALOG``: DeepInfra has none, which is what keeps its page unlisted.
CATALOGUES = {
    "local": ["base", "tiny", "small", "medium", "large-v3", "turbo"],
    "groq": ["whisper-large-v3-turbo"],
    "openai": ["whisper-1", "gpt-4o-transcribe"],
    "mistral": ["voxtral-mini-latest"],
    "xai": ["grok-voice-transcribe-2.0"],
    "elevenlabs": ["scribe_v2", "scribe_v1"],
}


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


class LevelTest(TempStore):
    allowed = {"model": True, "provider": True}

    def test_a_bot_that_has_never_picked_cleans_at_light(self) -> None:
        self.assertEqual(speech.read_level(self.path), "light")
        self.assertEqual(speech.cleanup_state(self.path, self.allowed)["level"], "light")

    def test_a_level_is_stored_with_the_bot_and_read_back(self) -> None:
        self.assertEqual(speech.set_level(self.path, "High"), "high")
        self.assertEqual(speech.read_level(self.path), "high")
        self.assertEqual(speech.set_level(self.path, " none "), "none")
        self.assertEqual(speech.read_level(self.path), "none")

    def test_a_level_that_is_not_one_is_refused_and_stores_nothing(self) -> None:
        for value in ("loud", "", 7, None):
            with self.assertRaises(ValueError):
                speech.set_level(self.path, value)
        self.assertEqual(speech.read_level(self.path), "light")

    def test_a_level_stored_as_something_else_reads_as_the_default(self) -> None:
        put_setting(self.path, speech.LEVEL_KEY, "Loud")
        self.assertEqual(speech.read_level(self.path), "light")

    def test_the_read_carries_the_level_beside_the_model(self) -> None:
        with Host(stt("base")):
            payload = speech.read(self.config, self.path, self.allowed)
        self.assertEqual(payload["cleanup"]["level"], "light")
        self.assertEqual(payload["hearing"], {"sent": False})


class HearingTest(TempStore):

    def test_a_take_is_heard_without_a_hearing_prompt_until_the_bot_says_so(self) -> None:
        self.assertFalse(speech.read_hearing(self.path))

    def test_the_setting_is_stored_with_the_bot_and_read_back(self) -> None:
        self.assertTrue(speech.set_hearing(self.path, True))
        self.assertTrue(speech.read_hearing(self.path))
        self.assertFalse(speech.set_hearing(self.path, False))
        self.assertFalse(speech.read_hearing(self.path))

    def test_anything_but_a_boolean_is_refused_and_stores_nothing(self) -> None:
        for value in (1, "true", None):
            with self.assertRaises(ValueError):
                speech.set_hearing(self.path, value)
        self.assertFalse(speech.read_hearing(self.path))


class SttHost:
    """The host modules ``speech.stt_settings`` and ``set_stt_value`` reach for, scripted.

    ``defaults`` is Hermes's ``DEFAULT_CONFIG["stt"]``, ``catalogues`` its ``STT_MODEL_CATALOG``,
    ``resolved`` what its own resolver answers, and ``keys`` which provider variables the host
    holds. The writer applies a dotted path the way Hermes's round-trip writer does — one path in,
    a value set or a key removed — so a test can show what a page's write leaves beside it.
    """

    def __init__(
        self,
        section=None,
        defaults=None,
        catalogues=None,
        resolved="local",
        keys=None,
    ):
        self.section = {} if section is None else section
        self.defaults = DEFAULTS if defaults is None else defaults
        self.catalogues = CATALOGUES if catalogues is None else catalogues
        self.resolved = resolved
        self.keys = keys if keys is not None else {}
        self.writes = []

    def __enter__(self):
        self._stt = mock.patch.object(speech, "_stt", lambda path, strict=False: dict(self.section))
        self._stt.start()
        self._modules = mock.patch.dict(sys.modules, self._host_modules())
        self._modules.start()
        return self

    def __exit__(self, *rest):
        self._modules.stop()
        self._stt.stop()
        return False

    def _host_modules(self):
        defaults = types.ModuleType("hermes_cli.config_defaults")
        defaults.DEFAULT_CONFIG = {"stt": self.defaults}
        common = types.ModuleType("tools.transcription_common")
        common.STT_MODEL_CATALOG = self.catalogues
        tools = types.ModuleType("tools.transcription_tools")
        tools._get_provider = lambda section: self.resolved
        pool = types.ModuleType("agent.credential_pool")
        pool.get_env_prefer_dotenv = lambda name: self.keys.get(name, "")
        utils = types.ModuleType("utils")
        utils.atomic_roundtrip_yaml_update = self._write
        return {
            "hermes_cli": types.ModuleType("hermes_cli"),
            "hermes_cli.config_defaults": defaults,
            "tools": types.ModuleType("tools"),
            "tools.transcription_common": common,
            "tools.transcription_tools": tools,
            "agent": types.ModuleType("agent"),
            "agent.credential_pool": pool,
            "utils": utils,
        }

    def _write(self, path, key, value):
        self.writes.append((key, value))
        # The whole file is the config; only its ``stt`` section is this harness's dict.
        keys = key.split(".")
        if keys[0] != "stt":
            raise AssertionError(f"a write outside the stt section: {key}")
        target = self.section
        for name in keys[1:-1]:
            target = target.setdefault(name, {})
        if value is None:
            target.pop(keys[-1], None)
        else:
            target[keys[-1]] = value


class SttReadTest(TempStore):
    def test_the_read_answers_the_page_in_one_block(self) -> None:
        section = {"enabled": True, "language": "es", "local": {"model": "small"}}
        with SttHost(section):
            block = speech.stt_settings(self.config)
        self.assertEqual(block["values"]["stt.language"], "es", "an explicit value is read")
        self.assertEqual(block["values"]["stt.local.model"], "small")
        self.assertNotIn("stt.provider", block["values"], "an absent pick is absent, not a value")
        self.assertEqual(block["defaults"]["stt.language"], "en", "the default rides beside it")
        self.assertEqual(block["provider"], {"name": "local", "reason": None, "explicit": None})
        self.assertEqual(
            [row["name"] for row in block["providers"]],
            ["groq", "openai", "mistral", "xai", "elevenlabs", "deepinfra"],
            "every provider the host declares but local, in its own order",
        )
        self.assertEqual(block["models"]["groq"], ["whisper-large-v3-turbo"], "the catalogues too")

    def test_the_one_read_carries_the_page(self) -> None:
        """The tab's read answers its own rows and the page's, from one read of the file."""
        section = {"enabled": True, "language": "es", "local": {"model": "small"}}
        with SttHost(section):
            both = speech.read(self.config, self.path, {}, with_stt=True)
            plain = speech.read(self.config, self.path, {})
        self.assertEqual(both["model"], "small", "the tab's own rows are still there")
        self.assertEqual(both["stt"]["values"]["stt.language"], "es", "and the page's beside them")
        self.assertNotIn("stt", plain, "a caller that asks for the old rows alone gets no block")

    def test_a_host_with_no_defaults_answers_its_old_rows(self) -> None:
        with SttHost({}, defaults={}):
            payload = speech.read(self.config, self.path, {}, with_stt=True)
        self.assertNotIn("stt", payload, "no defaults is the feature absent, not a failed read")

    def test_only_the_keys_the_page_carries_are_read(self) -> None:
        section = {
            "local": {"model": "base", "device": "cuda", "compute_type": "int8"},
            "openai": {"api_key": "sk-not-for-a-phone", "base_url": "http://mine"},
            "providers": {"mine": {"command": "hear"}},
        }
        with SttHost(section):
            block = speech.stt_settings(self.config)
        self.assertNotIn("stt.local.device", block["values"], "a key the schema doesn't declare")
        self.assertNotIn("stt.openai.api_key", block["values"], "never a secret")
        self.assertNotIn("stt.openai.base_url", block["values"], "never a URL")
        self.assertNotIn("base_url", json.dumps(block["defaults"]), "the defaults carry none either")

    def test_a_provider_pick_is_read_with_what_it_resolves_to(self) -> None:
        section = {"provider": "groq"}
        with SttHost(section, resolved="groq"):
            block = speech.stt_settings(self.config)
        self.assertEqual(block["provider"]["explicit"], "groq")
        self.assertEqual(block["provider"]["name"], "groq")
        self.assertIsNone(block["provider"]["reason"])

    def test_nothing_usable_is_said_in_the_host_s_words(self) -> None:
        with SttHost({}, resolved="none"):
            self.assertEqual(
                speech.stt_settings(self.config)["provider"],
                {"name": "none", "reason": speech.NOTHING_USABLE, "explicit": None},
            )
        with SttHost({"enabled": False}, resolved="none"):
            self.assertEqual(
                speech.stt_settings(self.config)["provider"]["reason"],
                speech.TURNED_OFF,
                "a host turned off says that, not that it has no backend",
            )

    def test_a_provider_is_reported_by_presence_and_never_by_value(self) -> None:
        secret = "gsk_the-website-never-holds-this"
        with SttHost({}, keys={"GROQ_API_KEY": secret, "ELEVENLABS_API_KEY": ""}):
            block = speech.stt_settings(self.config)
        rows = {row["name"]: row for row in block["providers"]}
        self.assertIs(rows["groq"]["key_set"], True, "a boolean, not the key")
        self.assertIs(rows["elevenlabs"]["key_set"], False, "a provider with no key says so")
        self.assertIs(rows["deepinfra"]["key_set"], False)
        self.assertNotIn(secret, json.dumps(block), "the value is never anywhere in the answer")

    def test_a_host_that_declares_no_defaults_has_no_page(self) -> None:
        with SttHost({}, defaults={}):
            self.assertFalse(speech.stt_available(), "the feature is absent, not broken")
            with self.assertRaises(ImportError):
                speech.stt_settings(self.config)

    def test_no_resolver_asked_means_no_provider_named(self) -> None:
        with SttHost({}):
            with mock.patch.dict(sys.modules, {"tools.transcription_tools": None}):
                block = speech.stt_settings(self.config)
        self.assertEqual(block["provider"], {"name": "", "reason": None, "explicit": None})


class SttWriteTest(TempStore):
    def test_one_key_is_written_and_its_siblings_stay(self) -> None:
        section = {
            "enabled": True,
            "local": {"model": "base", "device": "cuda"},
            "providers": {"mine": {"command": "hear"}},
        }
        with SttHost(section) as host:
            speech.set_stt_value(self.config, "stt.local.vad", False)
        self.assertEqual(host.writes, [("stt.local.vad", False)], "one dotted path, one value")
        self.assertEqual(section["local"]["vad"], False)
        self.assertEqual(section["local"]["model"], "base", "the key beside it stays")
        self.assertEqual(section["local"]["device"], "cuda", "so does one the page doesn't draw")
        self.assertEqual(section["providers"], {"mine": {"command": "hear"}})

    def test_a_switch_can_be_turned_on_and_a_number_written(self) -> None:
        with SttHost({}) as host:
            speech.set_stt_value(self.config, "stt.streaming", True)
            speech.set_stt_value(self.config, "stt.local.vad_min_silence_ms", 750)
        self.assertEqual(
            host.writes, [("stt.streaming", True), ("stt.local.vad_min_silence_ms", 750)]
        )

    def test_clearing_a_key_removes_only_that_key(self) -> None:
        section = {"language": "es", "local": {"model": "base", "language": "es"}}
        with SttHost(section) as host:
            speech.set_stt_value(self.config, "stt.language", None)
        self.assertEqual(host.writes, [("stt.language", None)], "a reset writes a deletion")
        self.assertNotIn("language", section, "the key left the file")
        self.assertEqual(section["local"], {"model": "base", "language": "es"}, "the nested one stays")

    def test_the_provider_pick_is_written_and_cleared(self) -> None:
        with SttHost({}) as host:
            speech.set_stt_value(self.config, "stt.provider", " groq ")
            speech.set_stt_value(self.config, "stt.provider", None)
        self.assertEqual(host.writes, [("stt.provider", "groq"), ("stt.provider", None)])

    def test_an_unknown_key_is_refused_before_anything_is_written(self) -> None:
        with SttHost({}) as host:
            with self.assertRaisesRegex(ValueError, "isn't a speech setting"):
                speech.set_stt_value(self.config, "stt.local.device", "cuda")
        self.assertEqual(host.writes, [])

    def test_a_secret_or_a_url_is_never_writable(self) -> None:
        with SttHost({}) as host:
            for key in ("stt.openai.api_key", "stt.openai.base_url", "tts.enabled"):
                with self.assertRaises(ValueError):
                    speech.set_stt_value(self.config, key, "x")
        self.assertEqual(host.writes, [])

    def test_a_value_the_key_cannot_hold_is_refused(self) -> None:
        with SttHost({}) as host:
            for key, value in (
                ("stt.local.vad", "yes"),
                ("stt.local.vad_min_silence_ms", "soon"),
                ("stt.language", 3),
                ("stt.provider", ""),
            ):
                with self.assertRaises(ValueError, msg=key):
                    speech.set_stt_value(self.config, key, value)
        self.assertEqual(host.writes, [])

    def test_a_file_the_host_refuses_is_left_as_it_was(self) -> None:
        section = {"local": {"model": "base"}}
        refused = types.ModuleType("utils")
        refused.atomic_roundtrip_yaml_update = mock.Mock(
            side_effect=OSError("config.yaml is read-only")
        )
        with SttHost(section):
            with mock.patch.dict(sys.modules, {"utils": refused}):
                with self.assertRaisesRegex(OSError, "read-only"):
                    speech.set_stt_value(self.config, "stt.local.model", "small")
        self.assertEqual(section["local"]["model"], "base")


if __name__ == "__main__":
    unittest.main()

