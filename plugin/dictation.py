"""Dictation: a clip recorded in the Gots app, turned into text by the host's faster-whisper.

Hermes's own transcription route (``POST /api/audio/transcribe``) lives on the dashboard, which the
app can't reach, so the clip comes here. It goes straight to Hermes's local faster-whisper path
(``_transcribe_local``) rather than ``transcribe_audio``: that one sends audio to whichever provider
the host picked for voice notes, which may be a cloud one, and dictation is only offered on the host's
own model. Faster-whisper's local path doesn't stream, so a clip is transcribed whole once it's done.

Every Hermes internal here is read with ``getattr``: one that moves only means dictation is off.
"""

from __future__ import annotations

import importlib.util
import os
import tempfile
import time
from typing import Any, Dict, Optional

# The API server refuses bodies over 10 MB (``MAX_REQUEST_BYTES``); Opus at 24 kbps is ~180 KB a minute.
MAX_BYTES = 9 * 1024 * 1024
# Whisper keeps the last 224 tokens of a prompt; a hint is a handful of names.
MAX_HINT = 300
# The text already heard, for a clip that carries on from the one before it; its end matters most.
MAX_CONTEXT = 400

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


def _tools() -> Any:
    from tools import transcription_tools

    return transcription_tools


def _installed(tt: Any) -> bool:
    # Hermes reads this at import; a `hermes tools` install since then needs no restart to show here.
    if getattr(tt, "_HAS_FASTER_WHISPER", False):
        return True
    try:
        importlib.invalidate_caches()
        return importlib.util.find_spec("faster_whisper") is not None
    except (ImportError, ValueError):
        return False


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
    """Whether this profile can dictate. Never installs anything or loads the model."""
    try:
        tt = _tools()
    except Exception:
        return {"ready": False, "reason": "This Hermes has no speech-to-text."}
    if not callable(getattr(tt, "_transcribe_local", None)):
        return {"ready": False, "reason": "This Hermes has no local speech-to-text."}
    try:
        cfg = _local_config(tt)
        enabled = tt.is_stt_enabled(cfg)
        model = _model_name(tt, cfg)
        language = tt._resolve_stt_language("local", cfg) or ""
    except Exception:
        return {"ready": False, "reason": "Couldn't read the host's speech-to-text settings."}
    if not enabled:
        return {"ready": False, "reason": "Speech-to-text is turned off on the host.", "model": model}
    if not _installed(tt):
        return {
            "ready": False,
            "reason": "faster-whisper isn't installed on the host. Run `hermes tools` and pick Local Whisper.",
            "model": model,
        }
    return {"ready": True, "model": model, "language": language}


def warm(model: Optional[str] = None) -> Dict[str, Any]:
    """Loads the model into Hermes's own cache slot while the user is still talking. Never raises.

    ``model`` names the one to load rather than the one ``config.yaml`` holds, which is how a take
    tries the pick the Gots app just wrote; without it, the host's own setting is what warms.
    """
    started = time.monotonic()
    try:
        if not info().get("ready"):
            return {"warmed": False}
        if model:
            tt = _tools()
            cfg = _local_config(tt)
            load = getattr(tt, "_get_or_load_local_model", None)
            if not callable(load):
                return {"warmed": False, "error": "This Hermes can't load a speech model by name."}
            load(model, cfg.get("local") or {})
            touch = getattr(tt, "_touch_transcription_time", None)
            if callable(touch):
                touch()
            return {"warmed": True, "model": model, "ms": int((time.monotonic() - started) * 1000)}
        try:
            from tools.stt_lease import warm_stt_provider
        except ImportError:
            warm_stt_provider = None
        if warm_stt_provider is not None:
            result = warm_stt_provider(provider="local")
            return {"warmed": bool(result.get("warmed")), "ms": int((time.monotonic() - started) * 1000)}
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


def transcribe(
    data: bytes, content_type: Optional[str], hint: str = "", context: str = ""
) -> Dict[str, Any]:
    """The clip's text, ``""`` when nobody spoke. DictationError when the host can't."""
    state = info()
    if not state.get("ready"):
        raise DictationError(state.get("reason") or "Dictation is off on the host.", 409)
    tt = _tools()
    cfg = _local_config(tt)
    # Our hint goes after the host's own prompt, which a `pre_transcription` plugin may also fill, and
    # the text before this clip goes last: Whisper reads a prompt as what was just said.
    configured = (cfg.get("local") or {}).get("initial_prompt")
    parts = (configured if isinstance(configured, str) else "", hint, context)
    prompt = " ".join(p for p in parts if p).strip()
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
            pass
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
