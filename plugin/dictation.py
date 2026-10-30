"""Dictation: a clip recorded in the Gots app, turned into text by the host's speech provider.

Hermes's own transcription route (``POST /api/audio/transcribe``) lives on the dashboard, which the
app can't reach, so the clip comes here. Which backend hears it is Hermes's answer, not ours: the
plugin asks ``_get_provider`` what the host resolves and follows it (ADR 0069). A ``local`` or
``local_command`` host decodes each piece as it arrives, through ``_transcribe_local``; any other
provider is a vendor, and a take for one is held until its last piece and uploaded once through
``transcribe_audio``, so that provider's trim, its model and its chunking of an oversized take are
the host's settings rather than copies of them.

Every Hermes internal here is read with ``getattr``: one that moves only means dictation is off.
"""

from __future__ import annotations

import importlib.util
import inspect
import logging
import os
import tempfile
import threading
import time
from dataclasses import dataclass, replace
from typing import Any, Callable, Dict, List, Optional, Sequence

logger = logging.getLogger(__name__)

# The API server refuses bodies over 10 MB (``MAX_REQUEST_BYTES``); Opus at 24 kbps is ~180 KB a minute.
MAX_BYTES = 9 * 1024 * 1024
# Whisper keeps the last 224 tokens of a prompt; a hint is a handful of names.
MAX_HINT = 300
# The text already heard, for a clip that carries on from the one before it; its end matters most.
MAX_CONTEXT = 400
# A bot's vocabulary is a short list, so the decoder's prompt stays inside the tokens Whisper keeps.
MAX_VOCABULARY = 50
MAX_WORD = 40

# The providers that hear a take on the host itself, one piece at a time.
LOCAL_BACKENDS = frozenset({"local", "local_command"})

# A held take is dropped this long after its deepest piece: the app cuts a piece every few seconds,
# so a minute of silence means the take ended, or died, without its last piece ever arriving.
BUFFER_SECONDS = 60.0

# What a host with no usable provider is told: our own sentence, since Hermes's own hint lists every
# provider's environment variable and reads as a manual on a phone.
NO_PROVIDER = (
    "No speech provider on this host can hear a take. "
    "Install faster-whisper, or set a provider's key."
)

SUFFIXES = {
    "audio/webm": ".webm",
    "video/webm": ".webm",
    "audio/ogg": ".ogg",
    "audio/mp4": ".mp4",
    "audio/aac": ".aac",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
}


class DictationError(Exception):
    def __init__(self, message: str, status: int = 502) -> None:
        super().__init__(message)
        self.status = status


# One held take per profile. The route serialises a profile's clips; this lock spans the profiles
# one process serves.
_buffers: Dict[str, Dict[str, Any]] = {}
_buffer_lock = threading.Lock()


def _tools() -> Any:
    from tools import transcription_tools

    return transcription_tools


def _installed(tt: Any) -> bool:
    """Whether faster-whisper can be imported here — the fallback for a Hermes without a resolver."""
    # Hermes reads this at import; a `hermes tools` install since then needs no restart to show here.
    if getattr(tt, "_HAS_FASTER_WHISPER", False):
        return True
    try:
        importlib.invalidate_caches()
        return importlib.util.find_spec("faster_whisper") is not None
    except (ImportError, ValueError):
        return False


def _ask(tt: Any, attr: str, *args: Any) -> Optional[str]:
    """One of Hermes's own answers, lowercased, or None where it isn't there or can't answer."""
    probe = getattr(tt, attr, None)
    if not callable(probe):
        return None
    try:
        return str(probe(*args) or "").strip().lower() or None
    except Exception:
        logger.debug("memento: Hermes couldn't answer %s", attr, exc_info=True)
        return None


def _provider(tt: Any, cfg: Dict[str, Any]) -> str:
    """Which provider Hermes resolves for this host's speech: a name, ``none``, or nothing.

    Nothing is "couldn't ask" — a resolver this Hermes doesn't have, or one that raised — and it
    falls back to the package check, so such a host goes on dictating rather than reading broken.
    ``none`` is Hermes's own answer that nothing can hear a take.
    """
    name = _ask(tt, "_get_provider", cfg)
    if name is not None:
        return name
    return "local" if _installed(tt) else ""


def _backend(tt: Any) -> Optional[str]:
    """Which local backend Hermes finds, ``local`` or ``local_command``, or None for neither."""
    return _ask(tt, "_detect_local_backend") or ("local" if _installed(tt) else None)


def provider_name(cfg: Dict[str, Any]) -> str:
    """Hermes's answer for the ``stt`` section a caller already holds, or "" where it can't ask."""
    try:
        return _provider(_tools(), cfg)
    except Exception:
        logger.debug("memento: no speech provider to name", exc_info=True)
        return ""


def heard_by(tt: Any, cfg: Dict[str, Any]) -> Dict[str, Any]:
    """Who hears this bot's takes, as both surfaces read it: the mic, and the Speech-to-text page.

    ``name`` is Hermes's own answer, ``backend`` the local backend behind a local one, and ``cloud``
    says the take leaves the host — which is what the app draws a line about, and what decides a
    buffered take.
    """
    name = _provider(tt, cfg)
    return {
        "name": name,
        "backend": _backend(tt) if name in LOCAL_BACKENDS else None,
        "cloud": bool(name) and name not in LOCAL_BACKENDS and name != "none",
    }


def heard_by_config(cfg: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
    """The same answer for a caller that already holds the ``stt`` section, or None where it can't ask."""
    try:
        tt = _tools()
        return heard_by(tt, cfg if cfg is not None else _local_config(tt))
    except Exception:
        logger.debug("memento: no speech provider to name", exc_info=True)
        return None


def _local_config(tt: Any) -> Dict[str, Any]:
    cfg = tt._load_stt_config()
    return cfg if isinstance(cfg, dict) else {}


def _model_name(tt: Any, cfg: Dict[str, Any]) -> str:
    local = cfg.get("local") or {}
    try:
        from tools.transcription_local import _normalize_local_model

        return _normalize_local_model(local.get("model"))
    except ImportError:
        return local.get("model") or getattr(tt, "DEFAULT_LOCAL_MODEL", "base")


def info() -> Dict[str, Any]:
    """Whether this profile can dictate, and by whom. Never installs anything or loads the model."""
    try:
        tt = _tools()
    except Exception:
        return {"ready": False, "reason": "This Hermes has no speech-to-text."}
    if not callable(getattr(tt, "transcribe_audio", None)):
        return {"ready": False, "reason": "This Hermes has no speech-to-text."}
    try:
        cfg = _local_config(tt)
        enabled = tt.is_stt_enabled(cfg)
        model = _model_name(tt, cfg)
        route = heard_by(tt, cfg)
        language = tt._resolve_stt_language(route["name"] or "local", cfg) or ""
    except Exception:
        return {"ready": False, "reason": "Couldn't read the host's speech-to-text settings."}
    if not enabled:
        return {"ready": False, "reason": "Speech-to-text is turned off on the host.", "model": model}
    if route["name"] in {"", "none"}:
        return {"ready": False, "reason": NO_PROVIDER, "model": model, "provider": route}
    # A local take is decoded by Hermes's local path, so a host without it can't hear one even
    # though its dispatcher is there.
    if not route["cloud"] and not callable(getattr(tt, "_transcribe_local", None)):
        return {
            "ready": False,
            "reason": "This Hermes has no local speech-to-text.",
            "model": model,
            "provider": route,
        }
    return {
        "ready": True,
        "model": model,
        "language": language,
        "provider": route,
    }


def warm() -> Dict[str, Any]:
    """Loads the model into Hermes's own cache slot while the user is still talking. Never raises.

    Hermes's own warm-up fills that slot, and lazy-installs faster-whisper where the host is missing
    it — so this is the one action that can clear a host with no local backend: it is an action the
    user started, which is the category Hermes allows an install on. A host whose takes already go
    to a cloud provider has nothing resident to load and is answered without asking.
    """
    started = time.monotonic()
    try:
        state = info()
        route = state.get("provider") or {}
        if state.get("ready") and route.get("cloud"):
            return {"warmed": False, "action": "noop"}
        try:
            from tools.stt_lease import warm_stt_provider
        except ImportError:
            warm_stt_provider = None
        if warm_stt_provider is not None:
            # A ready host warms the backend it resolved; one resolving nobody asks for `local`,
            # which is the only backend an install can fill.
            asked = str(state.get("provider") or "local") if state.get("ready") else "local"
            result = warm_stt_provider(provider=asked)
            answer = {
                "warmed": bool(result.get("warmed")),
                "action": result.get("action"),
                "ms": int((time.monotonic() - started) * 1000),
            }
            if not state.get("ready") and not answer["warmed"]:
                answer["reason"] = state.get("reason")
                if result.get("error"):
                    answer["error"] = result.get("error")
            return answer
        if not state.get("ready"):
            return {"warmed": False, "reason": state.get("reason")}
        # The stable release has no warm-up helper; fill the same slot transcription reads.
        tt = _tools()
        cfg = _local_config(tt)
        tt._get_or_load_local_model(_model_name(tt, cfg), cfg.get("local") or {})
        touch = getattr(tt, "_touch_transcription_time", None)
        if callable(touch):
            touch()
        return {"warmed": True, "ms": int((time.monotonic() - started) * 1000)}
    except Exception as exc:
        return {"warmed": False, "error": str(exc)}


def clean_hint(hint: Optional[str]) -> str:
    """Names the clip may mention (the bot, the chat, a project's repos), for Whisper's prompt."""
    text = " ".join((hint or "").split())
    return text[:MAX_HINT]


def clean_context(context: Optional[str]) -> str:
    """The end of what was said before this clip, so a sentence cut at a pause carries on."""
    text = " ".join((context or "").split())
    if len(text) <= MAX_CONTEXT:
        return text
    tail = text[-MAX_CONTEXT:]
    # Start on a whole word.
    return tail.split(" ", 1)[1] if " " in tail else tail


def clean_vocabulary(words: Any) -> List[str]:
    """The bot's own words for a decode's prompt: one line each, once each, the newest fifty.

    They are the names, product words and jargon the bot's dictation is written with (its Dictation
    tab's Words), so a decoder spells them as the bot does rather than as it hears them. Past the
    cap the oldest word goes, so the list is what the bot added last, as the app caps it; memory
    stays the cap's however long the input is.
    """
    kept: List[str] = []
    seen = set()
    for raw in words if isinstance(words, (list, tuple)) else ():
        if not isinstance(raw, str):
            continue
        word = " ".join(raw.split())[:MAX_WORD]
        folded = word.casefold()
        if not word or folded in seen:
            continue
        seen.add(folded)
        kept.append(word)
        if len(kept) > MAX_VOCABULARY:
            seen.discard(kept.pop(0).casefold())
    return kept


def suffix_for(content_type: Optional[str]) -> str:
    kind = (content_type or "").split(";", 1)[0].strip().lower()
    return SUFFIXES.get(kind, ".webm")


def _hallucination(text: str) -> bool:
    try:
        from tools.voice_mode_transcript import is_whisper_hallucination
    except ImportError:
        return False
    try:
        return bool(is_whisper_hallucination(text))
    except Exception:
        return False


@dataclass(frozen=True)
class DictationHearingPrompt:
    """What a host's speech model is given before it listens (ADR 0067).

    Whisper reads a prompt as what was just said, so the parts go in one order and the text before
    this clip comes last: ``DictationHearingPrompt().WithInitialPrompt(…).WithHint(…)
    .WithVocabulary(…).WithContext(…).Build()`` answers the one string the decode is given. A bot's
    Hearing prompt setting decides whether that string is sent at all, and a vendor never gets it.
    """

    initial_prompt: str = ""
    hint: str = ""
    vocabulary: Sequence[str] = ()
    context: str = ""

    def WithInitialPrompt(self, value: str) -> "DictationHearingPrompt":
        return replace(self, initial_prompt=value or "")

    def WithHint(self, value: str) -> "DictationHearingPrompt":
        return replace(self, hint=value or "")

    def WithVocabulary(self, value: Optional[Sequence[str]]) -> "DictationHearingPrompt":
        return replace(self, vocabulary=tuple(word for word in value or () if word))

    def WithContext(self, value: str) -> "DictationHearingPrompt":
        return replace(self, context=value or "")

    def Build(self) -> str:
        words = " ".join(self.vocabulary)
        parts = (self.initial_prompt, self.hint, words, self.context)
        return " ".join(part for part in parts if part).strip()


def _landed(result: Any, started: float) -> Dict[str, Any]:
    """A provider's answer as a piece's landing: its text, or the reason it heard nothing."""
    if not isinstance(result, dict):
        raise DictationError("Transcription failed.")
    if not result.get("success"):
        error = str(result.get("error") or "Transcription failed.")
        if "empty transcript" in error.lower():
            result = {"transcript": ""}
        else:
            raise DictationError(error)
    text = str(result.get("transcript") or "").strip()
    if _hallucination(text):
        text = ""
    return {"text": text, "ms": int((time.monotonic() - started) * 1000)}


def _hold(
    data: bytes, *, first: bool = False, last: bool = False, profile: Optional[Any] = None
) -> Optional[bytes]:
    """Keeps a cloud take's pieces until its last one, then answers the whole recording.

    A take's first piece drops whatever the profile was still holding — so a take that was cancelled
    or died is never uploaded inside the next one — and so does every hold nothing has added to for
    a minute. None means the take is still being spoken; a DictationError is the recording growing
    past what one take may be.
    """
    key = str(profile or "")
    now = time.monotonic()
    with _buffer_lock:
        stale = [one for one, held in _buffers.items() if now - float(held["at"]) > BUFFER_SECONDS]
        for one in stale:
            _buffers.pop(one, None)
        if stale:
            logger.debug("memento: dropped %d dictation take(s) left alone", len(stale))
        held = None if first else _buffers.get(key)
        if held is None:
            held = {"take": bytearray(), "at": now}
        if len(held["take"]) + len(data) > MAX_BYTES:
            _buffers.pop(key, None)
            raise DictationError("The recording is too long.", 413)
        held["take"].extend(data)
        held["at"] = now
        if not last:
            _buffers[key] = held
            return None
        _buffers.pop(key, None)
        return bytes(held["take"])


def _dispatcher(tt: Any) -> Callable[[str], Any]:
    """Hermes's own dispatcher, given the caller label only where that Hermes knows it."""
    call = tt.transcribe_audio
    try:
        named = "source" in inspect.signature(call).parameters
    except (TypeError, ValueError):
        named = False
    return (lambda path: call(path, source="dictation")) if named else call


def _cloud_take(
    tt: Any,
    data: bytes,
    content_type: Optional[str],
    *,
    first: bool,
    last: bool,
    profile: Optional[Any],
) -> Dict[str, Any]:
    """A take on a cloud provider: nothing while it is spoken, then one upload of the whole thing.

    Decoded by Hermes's dispatcher rather than ours, so the host's provider, its trim and its
    chunking of a take past that provider's own cap all apply. No prompt is composed: a cloud
    provider reads the audio alone and the cleanup carries the bot's names (ADR 0067).
    """
    audio = _hold(data, first=first, last=last, profile=profile)
    if audio is None:
        return {"text": "", "ms": 0}
    started = time.monotonic()
    fd, path = tempfile.mkstemp(prefix="memento-dictation-", suffix=suffix_for(content_type))
    try:
        with os.fdopen(fd, "wb") as file:
            file.write(audio)
        result = _dispatcher(tt)(path)
    finally:
        try:
            os.unlink(path)
        except OSError:
            logger.debug("memento: couldn't delete the clip it wrote", exc_info=True)
    return _landed(result, started)


def transcribe(
    data: bytes,
    content_type: Optional[str],
    hint: str = "",
    context: str = "",
    vocabulary: Optional[Sequence[str]] = None,
    *,
    hearing: bool,
    first: bool = False,
    last: bool = False,
    profile: Optional[Any] = None,
) -> Dict[str, Any]:
    """The clip's text, ``""`` when nobody spoke. DictationError when the host can't.

    ``vocabulary`` is the bot's own words, so a decoder that only half-heard one spells it the way
    the bot does; it rides after the hint and before ``context``, which must stay last. ``hearing``
    is the bot's Hearing prompt setting, and it is the one place the rule lives: false composes no
    prompt at all, so the model hears the audio alone and the cleanup carries the names instead
    (ADR 0067). It has no default, since a caller that forgets it would prompt a bot that withheld.

    ``first`` and ``last`` delimit a take: a cloud take holds its pieces from the first and uploads
    them on the last, so a cancelled take's audio is dropped rather than carried into the next one.
    A local take ignores both. ``profile`` is the store path the take is held under.
    """
    state = info()
    if not state.get("ready"):
        raise DictationError(state.get("reason") or "Dictation is off on the host.", 409)
    if (state.get("provider") or {}).get("cloud"):
        return _cloud_take(
            _tools(), data, content_type, first=first, last=last, profile=profile
        )
    tt = _tools()
    cfg = _local_config(tt)
    prompt = ""
    if hearing:
        configured = (cfg.get("local") or {}).get("initial_prompt")
        prompt = (
            DictationHearingPrompt()
            .WithInitialPrompt(configured if isinstance(configured, str) else "")
            .WithHint(hint)
            .WithVocabulary(vocabulary)
            .WithContext(context)
            .Build()
        )
    started = time.monotonic()
    fd, path = tempfile.mkstemp(prefix="memento-dictation-", suffix=suffix_for(content_type))
    try:
        with os.fdopen(fd, "wb") as file:
            file.write(data)
        result = tt._transcribe_local(path, _model_name(tt, cfg), prompt=prompt or None)
    finally:
        try:
            os.unlink(path)
        except OSError:
            logger.debug("memento: couldn't delete the clip it wrote", exc_info=True)
    return _landed(result, started)
