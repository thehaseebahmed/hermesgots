"""Drives one take the way the app does, and records what it cost the host (ADR 0075).

The seam is the plugin's own take functions, called in process: ``upload`` for each Piece, the take's
worker hearing them as they land, ``confirm`` answering the take whole. There is no HTTP, no browser
and no version gate between the measurement and the thing measured — only a stand-in for Hermes's
transcription module, whose one real decoder is the host's speech model.

Three things are timed here and nothing else: each decode, at the stand-in that makes it; the Cleanup,
at the one call ``confirm`` makes; and the Confirm span, around ``confirm`` itself. A Piece's length
and the take's spoken span come from the plugin's own answer, so the number the app shows and the
number the bench prints are the same number.
"""

from __future__ import annotations

import importlib
import json
import os
import platform
import socket
import sys
import threading
import time
import types
import urllib.request
from dataclasses import dataclass
from importlib.metadata import PackageNotFoundError, version
from typing import Any, Dict, List, Optional, Sequence

from . import cut as cutting
from . import fixtures as fixtures_module
from . import words as words_module

PROFILE = "bench"

# What every decode is given, held once: the record states these, and a record that claims a
# temperature the decode didn't run at is worse than no record.
TEMPERATURE = 0.0
VAD = False


class NoDecoder(Exception):
    """This host has no speech model, so a bench here would measure nothing: it skips instead."""


@dataclass
class Settings:
    """What a run is heard with, as the command line asked for it."""

    model: str = "base"
    compute_type: str = "int8"
    language: str = "en"
    beam_size: int = 5
    cpu_threads: int = 4
    level: str = "none"
    hearing: bool = True
    vocabulary: bool = True
    pace: bool = True
    cleanup_url: Optional[str] = None
    cleanup_model: Optional[str] = None
    cleanup_key: Optional[str] = None

    def stated(self) -> Dict[str, Any]:
        """The settings that decide what the decoder hears, as the record names them."""
        return {
            "model": self.model,
            "compute_type": self.compute_type,
            "language": self.language,
            "beam_size": self.beam_size,
            "cpu_threads": self.cpu_threads,
        }


def _versions() -> str:
    """The decoder stack's own versions, so two runs on different installs aren't compared."""
    parts = []
    for package in ("faster-whisper", "av"):
        try:
            parts.append(f"{package} {version(package)}")
        except PackageNotFoundError:
            continue
    return ", ".join(parts) or "faster-whisper"


class Decoder:
    """The host's own speech model, read the way Hermes's local path reads it."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.calls: List[int] = []
        self.warm_ms = 0
        self._model: Any = None
        self._lock = threading.Lock()

    def load(self) -> None:
        try:
            from faster_whisper import WhisperModel
        except ImportError as missing:
            raise NoDecoder(
                "faster-whisper isn't installed here, so this host has no speech model to hear a "
                "take with. Install it with `pip install -r bench/dictation/requirements.txt`."
            ) from missing
        started = time.monotonic()
        self._model = WhisperModel(
            self.settings.model,
            device="cpu",
            compute_type=self.settings.compute_type,
            cpu_threads=self.settings.cpu_threads,
        )
        self.warm_ms = int((time.monotonic() - started) * 1000)

    def hear(self, path: str, prompt: Optional[str] = None) -> Dict[str, Any]:
        """One decode: the words, or the failure the plugin's own ``_landed`` reads."""
        if self._model is None:
            raise NoDecoder("the speech model hasn't been loaded")
        started = time.monotonic()
        with self._lock:
            segments, _ = self._model.transcribe(
                path,
                language=self.settings.language,
                beam_size=self.settings.beam_size,
                temperature=TEMPERATURE,
                initial_prompt=prompt or None,
                condition_on_previous_text=False,
                without_timestamps=True,
                vad_filter=VAD,
            )
            text = " ".join(segment.text.strip() for segment in segments).strip()
        self.calls.append(int((time.monotonic() - started) * 1000))
        return {"success": True, "transcript": text, "provider": "local"}

    def stated(self) -> Dict[str, Any]:
        """The decoder as a record names it: two runs with different answers aren't comparable."""
        return {
            "backend": _versions(),
            **self.settings.stated(),
            "temperature": TEMPERATURE,
            "vad": VAD,
            "warm_ms": self.warm_ms,
        }


def machine() -> Dict[str, Any]:
    """The machine a run was taken on: named, so two runs are compared or refused as incomparable."""
    return {
        "name": socket.gethostname(),
        "machine": platform.machine(),
        "system": platform.system(),
        "cpus": os.cpu_count() or 0,
        "python": platform.python_version(),
    }


class StandIn:
    """Hermes's transcription module, with the host's model behind it and nothing else faked.

    The plugin reads this module exactly as it reads Hermes's: a provider, a model name, a language,
    the local decode, and the dispatcher a cloud take is uploaded through. What is replaced is the
    stub the plugin's own tests use, and only that. It is written here rather than imported from
    ``plugin/tests``, because importing that package arms its own network guard over ``urlopen`` and
    the Cleanup's endpoint would stop answering.
    """

    def __init__(self, decoder: Decoder, settings: Settings) -> None:
        self.decoder = decoder
        self.settings = settings
        self.route = "local"
        module = types.ModuleType("tools.transcription_tools")
        module._HAS_FASTER_WHISPER = True
        module._transcribe_local = self._transcribe_local
        module.transcribe_audio = self.transcribe_audio
        module._get_provider = lambda cfg: self.route
        module._detect_local_backend = lambda: "faster-whisper"
        module._load_stt_config = lambda: {
            "enabled": True,
            "local": {"model": self.settings.model, "initial_prompt": ""},
        }
        module.is_stt_enabled = lambda cfg: True
        module._resolve_stt_language = lambda provider, cfg: self.settings.language
        self.module = module

    def install(self) -> str:
        """Stands the module up, and answers whether the host's own hallucination filter came with it.

        The plugin reads ``tools.voice_mode_transcript`` to drop the words a model writes over room
        tone. That module is Hermes's, not this bench's: where a Hermes is installed it is registered
        as it is, and where none is, the decode is what the model wrote and the record says so.
        """
        filter_in = "none"
        try:
            transcript = importlib.import_module("tools.voice_mode_transcript")
        except ImportError:
            transcript = None
        tools = types.ModuleType("tools")
        tools.transcription_tools = self.module
        sys.modules["tools"] = tools
        sys.modules["tools.transcription_tools"] = self.module
        if transcript is not None:
            sys.modules["tools.voice_mode_transcript"] = transcript
            filter_in = "hermes"
        return filter_in

    def _transcribe_local(
        self, path: str, model: str, prompt: Optional[str] = None
    ) -> Dict[str, Any]:
        # The plugin resolves this model from the config the stand-in answers with, so the two
        # agreeing is a fact worth checking rather than an assumption the record repeats.
        if model != self.settings.model:
            raise ValueError(
                f"the plugin asked for {model!r} and this bench hears with {self.settings.model!r}"
            )
        return self.decoder.hear(path, prompt)

    def transcribe_audio(self, path: str, source: Optional[str] = None) -> Dict[str, Any]:
        return self.decoder.hear(path)


class Cleanup:
    """The model a Cleanup call goes to, where this host has one to ask.

    A bench runs outside a Hermes process, so there is no ``ctx.llm`` behind the plugin: a cleaning
    level needs ``--cleanup-url`` (any OpenAI-compatible endpoint) and ``--cleanup-model``, and
    without them the level is recorded as one that never asked, rather than as a free one.
    """

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.calls = 0

    @property
    def wired(self) -> bool:
        return bool(self.settings.cleanup_url and self.settings.cleanup_model)

    def complete_structured(self, **call: Any) -> Any:
        self.calls += 1
        said = "\n".join(
            str(part.get("text") or "")
            for part in call.get("input") or ()
            if isinstance(part, dict)
        )
        body = {
            "model": self.settings.cleanup_model,
            "messages": [
                {"role": "system", "content": call.get("system_prompt") or ""},
                {"role": "user", "content": f"{said}\n\n{call.get('instructions') or ''}"},
            ],
            "temperature": call.get("temperature", 0),
            "max_tokens": call.get("max_tokens") or 1024,
            "response_format": {"type": "json_object"},
        }
        headers = {"Content-Type": "application/json"}
        if self.settings.cleanup_key:
            headers["Authorization"] = f"Bearer {self.settings.cleanup_key}"
        request = urllib.request.Request(
            f"{str(self.settings.cleanup_url).rstrip('/')}/chat/completions",
            data=json.dumps(body).encode(),
            headers=headers,
        )
        with urllib.request.urlopen(request, timeout=60) as answer:
            payload = json.loads(answer.read().decode())
        content = ((payload.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
        try:
            parsed = json.loads(content)
        except ValueError:
            parsed = None
        return types.SimpleNamespace(parsed=parsed)


@dataclass
class Host:
    """What one run hears with, gathered so that a take is driven with one argument."""

    settings: Settings
    decoder: Decoder
    stand_in: StandIn
    cleanup: Cleanup
    hallucinations: str = "none"

    @classmethod
    def ready(cls, settings: Settings) -> "Host":
        """Loads the model, stands in for Hermes, and gives the Cleanup the model it may ask."""
        from plugin import dictation_cleanup

        decoder = Decoder(settings)
        decoder.load()
        stand_in = StandIn(decoder, settings)
        filter_in = stand_in.install()
        cleanup = Cleanup(settings)
        dictation_cleanup.register(types.SimpleNamespace(llm=cleanup if cleanup.wired else None))
        return cls(
            settings=settings,
            decoder=decoder,
            stand_in=stand_in,
            cleanup=cleanup,
            hallucinations=filter_in,
        )


def require_one_piece(
    fixture: fixtures_module.Fixture, pieces: Sequence[cutting.Piece]
) -> None:
    """A cloud host holds the take and uploads the whole of it once, so it must be one Piece."""
    if fixture.route == fixtures_module.CLOUD_ROUTE and len(pieces) != 1:
        raise ValueError(
            f"{fixture.name} is heard by a cloud host, which uploads the whole of it once, so it "
            f"must be one Piece and this cut made {len(pieces)}"
        )


def _payload(
    fixture: fixtures_module.Fixture,
    samples: Sequence[float],
    rate: int,
    pieces: Sequence[cutting.Piece],
) -> List[bytes]:
    """Each Piece as its own container; a cloud take goes whole, as one upload at its Confirm."""
    if fixture.route == fixtures_module.CLOUD_ROUTE:
        require_one_piece(fixture, pieces)
        return [fixture.audio.read_bytes()]
    from plugin import dictation

    if len(pieces) == 1 and dictation.suffix_for(fixture.content_type) != ".wav":
        # The Piece is the whole file, so it goes as the bytes the app recorded rather than as a
        # re-container of them: that is what the app's own WebM is here to prove.
        return [fixture.audio.read_bytes()]
    return [cutting.slice_wav(samples, rate, piece) for piece in pieces]


def hear(
    fixture: fixtures_module.Fixture, policy: cutting.CutPolicy, host_of: Host
) -> Dict[str, Any]:
    """One fixture, driven as a take: uploaded Piece by Piece, then answered by one Confirm."""
    from plugin import dictation, dictation_cleanup

    settings = host_of.settings
    host_of.stand_in.route = fixture.route
    samples, rate = cutting.read(fixture.audio)
    pieces = cutting.pieces(samples, rate, policy)
    payload = _payload(fixture, samples, rate, pieces)
    vocabulary = list(fixture.vocabulary) if settings.vocabulary else []
    level = dictation_cleanup.level_of(settings.level)
    take_id = f"bench-{fixture.name}"

    host_of.cleanup.calls = 0
    host_of.decoder.calls.clear()
    cleanup_ms: Optional[int] = None
    original = dictation_cleanup.finish

    def measure(*args: Any, **kwargs: Any) -> Any:
        """Hands back what ``finish`` answered, keeping the span it measured for the record."""
        nonlocal cleanup_ms
        answer = original(*args, **kwargs)
        cleanup_ms = int(answer.get("ms") or 0)
        return answer

    dictation_cleanup.finish = measure
    try:
        for index, piece in enumerate(pieces):
            dictation.upload(
                PROFILE,
                take_id,
                index,
                payload[index],
                fixture.content_type,
                hint=fixture.hint,
                vocabulary=vocabulary,
                hearing=settings.hearing,
                ms=piece.ms,
            )
            # A Piece is sent when it closes, so the host hears the take while it is still being
            # said: the wait between uploads is the time its worker has to keep up with.
            if settings.pace and index < len(pieces) - 1:
                time.sleep(piece.ms / 1000)
        started = time.monotonic()
        answer = dictation.confirm(PROFILE, take_id, len(pieces), level=settings.level)
        confirm_ms = int((time.monotonic() - started) * 1000)
    finally:
        dictation_cleanup.finish = original
        dictation.cancel(PROFILE, take_id)

    # The take's worker hears its Pieces in the order they arrived, so the Nth decode is the Nth
    # Piece's; a cloud take makes the one decode its whole audio is answered with. A Piece whose
    # decode failed leaves a hole, which would shift every later one, so the mapping is refused
    # rather than guessed at.
    decodes = list(host_of.decoder.calls)
    attributed = decodes if len(decodes) == len(pieces) else []
    return {
        "fixture": fixture.name,
        "path": fixture.route,
        "fixture_sha256": fixture.hash(),
        "spoken_ms": int(answer["ms"]),
        "pieces": [
            {
                "index": index,
                "ms": piece.ms,
                "decode_ms": attributed[index] if index < len(attributed) else None,
            }
            for index, piece in enumerate(pieces)
        ],
        "decode_ms": sum(decodes),
        "cleanup": {
            "level": level,
            "ms": cleanup_ms,
            # How many calls the Cleanup actually made. A cleaning level with no model to ask
            # answers no calls, and a cost it never measured is null rather than a free zero.
            "asked": host_of.cleanup.calls,
            "cleaned": bool(answer.get("cleaned")),
        },
        "confirm_ms": confirm_ms,
        "heard": answer["heard"],
        "landed": answer["text"],
        "reference": fixture.reference,
        "wer": words_module.wer(fixture.reference, answer["heard"]),
        "vocabulary": words_module.spelled(vocabulary, answer["heard"]),
        "provider": answer["provider"],
        "model": answer["model"],
    }


def run(
    chosen: Sequence[fixtures_module.Fixture],
    policy: cutting.CutPolicy,
    settings: Settings,
) -> Dict[str, Any]:
    """Every fixture, one take after another, as one record."""
    from plugin import dictation_cleanup

    host_of = Host.ready(settings)
    whole_set = fixtures_module.digest(fixtures_module.load())
    takes: List[Dict[str, Any]] = []
    for fixture in chosen:
        try:
            takes.append(hear(fixture, policy, host_of))
        except Exception as failure:  # noqa: BLE001 - a broken take is a field in the record
            # A decode that fails one take says nothing about the next, and a record that stops at
            # the fifth take throws away the four it measured. The failure is what the take's entry
            # says instead of words.
            takes.append(
                {
                    "fixture": fixture.name,
                    "path": fixture.route,
                    "fixture_sha256": fixture.hash(),
                    "error": str(failure) or failure.__class__.__name__,
                }
            )
    return {
        "object": "memento.bench.dictation",
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "host": machine(),
        "decoder": host_of.decoder.stated(),
        "level": dictation_cleanup.level_of(settings.level),
        "cut": policy.stated(),
        "hearing": bool(settings.hearing),
        "vocabulary": bool(settings.vocabulary),
        "pace": "live" if settings.pace else "fast",
        "hallucinations": host_of.hallucinations,
        # The whole set's digest, never only what this run was asked to hear: the hash names the
        # bytes a baseline was taken on, and a run of some of them is read against that same set.
        "fixtures": {
            **whole_set,
            "heard": [fixture.name for fixture in chosen],
        },
        "subset": len(chosen) < whole_set["count"],
        "takes": takes,
        "totals": {
            "takes": len(takes),
            "measured": sum(1 for take in takes if "error" not in take),
            "spoken_ms": sum(take.get("spoken_ms") or 0 for take in takes),
            "pieces": sum(len(take.get("pieces") or ()) for take in takes),
            "decode_ms": sum(take.get("decode_ms") or 0 for take in takes),
            "cleanup_ms": sum((take.get("cleanup") or {}).get("ms") or 0 for take in takes),
            "confirm_ms": sum(take.get("confirm_ms") or 0 for take in takes),
        },
    }
