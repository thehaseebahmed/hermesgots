"""Dictation: a take recorded in the Gots app, heard Piece by Piece on its bot's host.

Hermes's own transcription route (``POST /api/audio/transcribe``) lives on the dashboard, which the
app can't reach, so the audio comes here instead.

The app uploads audio and nothing else, stamped with the Take id it minted and each Piece's index in
the take. The host holds the take under that id, hears each Piece as it lands, and answers the one
call that carries words — the Confirm — with the take whole: its tidied text, the words as heard, how
long it took to say, and what tidied it (ADR 0074). A take lands whole or not at all.

Every Hermes internal here is read with ``getattr``: one that moves only means dictation is off.
"""

from __future__ import annotations

import importlib.util
import inspect
import logging
import os
import queue
import tempfile
import threading
import time
from dataclasses import dataclass, replace
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

logger = logging.getLogger(__name__)

# The API server refuses bodies over 10 MB (``MAX_REQUEST_BYTES``); Opus at 24 kbps is ~180 KB a minute.
MAX_BYTES = 9 * 1024 * 1024
# Whisper keeps the last 224 tokens of a prompt; a hint is a handful of names.
MAX_HINT = 300
MAX_CONTEXT = 400
# A bot's vocabulary is a short list, so the decoder's prompt stays inside the tokens Whisper keeps.
MAX_VOCABULARY = 50
MAX_WORD = 40

LOCAL_BACKENDS = frozenset({"local", "local_command"})

# The app cuts a Piece every few seconds, so this much silence means the take ended without its Confirm.
TAKE_SECONDS = 120.0

QUEUE_SECONDS = 30.0

CLOUD_SECONDS = 300.0

MAX_PIECES = 2000

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


class MissingPieces(DictationError):
    """A Confirm naming Pieces the host does not hold; ``missing`` is exactly what to send again."""

    def __init__(self, missing: Sequence[int], message: str = "The host is missing Pieces.") -> None:
        super().__init__(message, 409)
        self.missing = sorted(int(index) for index in missing)


class Take:
    """One take the host holds: the words it has heard, the Pieces it has, and its audio.

    Keyed by the store it belongs to and the app's Take id. A local host drops a Piece's audio as
    soon as its words exist; a cloud host keeps the take whole and sends nothing until the Confirm
    uploads it (ADR 0074).
    """

    def __init__(
        self,
        *,
        cloud: bool,
        hint: str,
        vocabulary: Sequence[str],
        hearing: bool,
    ) -> None:
        self.cloud = cloud
        self.hint = hint
        self.vocabulary = tuple(vocabulary)
        self.hearing = hearing
        self.pieces: Dict[int, Dict[str, Any]] = {}
        self.order: List[int] = []
        self.error: Optional[str] = None
        self.touched = time.monotonic()
        self.queue: "queue.Queue[Optional[int]]" = queue.Queue()
        self.worker: Optional[threading.Thread] = None
        self.prompt: Optional[str] = None
        self.model: Optional[str] = None

    def spoken(self) -> int:
        """How long the take took to say: its Pieces' own spans, in arrival order, pauses left out."""
        return sum(max(0, int(self.pieces[index].get("ms") or 0)) for index in self.order)

    def joined(self) -> str:
        words = (self.pieces[index].get("text") or "" for index in self.order)
        return " ".join(word.strip() for word in words if word and word.strip())

    def drop_audio(self) -> None:
        for piece in self.pieces.values():
            piece["data"] = None

    def stop(self) -> None:
        """Ends the take's worker at its next turn of the queue, however often this is called."""
        if self.worker is not None:
            self.queue.put(None)


_takes: Dict[Tuple[str, str], Take] = {}
_takes_lock = threading.RLock()
_heard = threading.Condition(_takes_lock)
_sweeper: Optional[threading.Thread] = None


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


def _ask(tt: Any, attr: str, *args: Any) -> Optional[str]:
    probe = getattr(tt, attr, None)
    if not callable(probe):
        return None
    try:
        return str(probe(*args) or "").strip().lower() or None
    except Exception:
        logger.debug("memento: Hermes couldn't answer %s", attr, exc_info=True)
        return None


def _provider(tt: Any, cfg: Dict[str, Any]) -> Optional[str]:
    """Hermes's answer, ``none`` when nothing can hear a take, or None when it can't be asked."""
    name = _ask(tt, "_get_provider", cfg)
    if name is not None:
        return name
    return "local" if _installed(tt) else None


def _backend(tt: Any) -> Optional[str]:
    return _ask(tt, "_detect_local_backend") or ("local" if _installed(tt) else None)


def provider_name(cfg: Dict[str, Any]) -> str:
    try:
        return _provider(_tools(), cfg) or ""
    except Exception:
        logger.debug("memento: no speech provider to name", exc_info=True)
        return ""


def heard_by(tt: Any, cfg: Dict[str, Any]) -> Dict[str, Any]:
    """Who hears a take, as both the mic and the Speech-to-text page read it."""
    name = _provider(tt, cfg) or ""
    return {
        "name": name,
        "backend": _backend(tt) if name in LOCAL_BACKENDS else None,
        "cloud": bool(name) and name not in LOCAL_BACKENDS and name != "none",
    }


def heard_by_config(cfg: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
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


def wait_ms(level: Optional[str] = None, *, cloud: bool = False) -> int:
    """The longest a Confirm can take from arriving to answering: the queue, the Cleanup and any upload.

    Derived where all three live, so a fifth level, a slower provider or a cloud take's upload moves
    the app's bar without an app release (ADR 0074).
    """
    from . import dictation_cleanup

    seconds = QUEUE_SECONDS + dictation_cleanup.deadline_of(level)
    if cloud:
        seconds += CLOUD_SECONDS
    return int(round(seconds * 1000))


def info(level: Optional[str] = None) -> Dict[str, Any]:
    """Whether this profile can dictate, by whom, and how long its Confirm may take."""
    bound = wait_ms(level)
    try:
        tt = _tools()
    except Exception:
        return {"ready": False, "reason": "This Hermes has no speech-to-text.", "wait_ms": bound}
    if not callable(getattr(tt, "transcribe_audio", None)):
        return {"ready": False, "reason": "This Hermes has no speech-to-text.", "wait_ms": bound}
    try:
        cfg = _local_config(tt)
        enabled = tt.is_stt_enabled(cfg)
        model = _model_name(tt, cfg)
        route = heard_by(tt, cfg)
        language = tt._resolve_stt_language(route["name"] or "local", cfg) or ""
    except Exception:
        return {
            "ready": False,
            "reason": "Couldn't read the host's speech-to-text settings.",
            "wait_ms": bound,
        }
    if not enabled:
        return {
            "ready": False,
            "reason": "Speech-to-text is turned off on the host.",
            "model": model,
            "wait_ms": bound,
        }
    if route["name"] in {"", "none"}:
        return {
            "ready": False,
            "reason": NO_PROVIDER,
            "model": model,
            "provider": route,
            "wait_ms": bound,
        }
    # A local take is decoded by Hermes's local path, so a host without it can't hear one even
    # though its dispatcher is there.
    if not route["cloud"] and not callable(getattr(tt, "_transcribe_local", None)):
        return {
            "ready": False,
            "reason": "This Hermes has no local speech-to-text.",
            "model": model,
            "provider": route,
            "wait_ms": bound,
        }
    return {
        "ready": True,
        "model": model,
        "language": language,
        "provider": route,
        "wait_ms": wait_ms(level, cloud=bool(route["cloud"])),
    }


def _provider_to_warm(state: Dict[str, Any]) -> str:
    """The backend to load: the one a ready host resolved, or `local` for one still to be set up."""
    return str(state.get("provider") or "local") if state.get("ready") else "local"


def warm() -> Dict[str, Any]:
    """Loads the model while the user talks, reaching Hermes's lazy install when nothing is ready."""
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
            result = warm_stt_provider(provider=_provider_to_warm(state))
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
    """Names the take may mention (the bot, the chat, a project's repos), for Whisper's prompt."""
    text = " ".join((hint or "").split())
    return text[:MAX_HINT]


def clean_context(context: Optional[str]) -> str:
    """The end of what was said before a clip, so a sentence cut at a pause carries on.

    A take no longer sends one — the host holds the take's own words — but a meeting's windows are
    still decoded one at a time, each carrying on from the one before it.
    """
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
    this Piece comes last: ``DictationHearingPrompt().WithInitialPrompt(…).WithHint(…)
    .WithVocabulary(…).WithContext(…).Build()`` answers the one string the decode is given. A bot's
    Hearing prompt setting decides whether that string is sent at all.
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


def _landed(result: Any) -> str:
    """One decode's words: ``""`` when nobody spoke, DictationError when the host couldn't."""
    if not isinstance(result, dict):
        raise DictationError("Transcription failed.")
    if not result.get("success"):
        error = str(result.get("error") or "Transcription failed.")
        if "empty transcript" in error.lower():
            return ""
        raise DictationError(error)
    text = str(result.get("transcript") or "").strip()
    return "" if _hallucination(text) else text


def _dispatcher(tt: Any) -> Any:
    """Hermes's own dispatcher, given the caller label only where that Hermes knows it."""
    call = tt.transcribe_audio
    try:
        named = "source" in inspect.signature(call).parameters
    except (TypeError, ValueError):
        named = False
    return (lambda path: call(path, source="dictation")) if named else call


def _temp(data: Any, content_type: Optional[str], decode: Any) -> Any:
    """Hands ``data`` to ``decode`` as a file it can read, and deletes the file however that ends.

    ``data`` is one Piece's bytes or the several of a cloud take, written straight into the file: a
    nine-megabyte take is never joined into a second buffer to be handed over.
    """
    fd, path = tempfile.mkstemp(prefix="memento-dictation-", suffix=suffix_for(content_type))
    try:
        with os.fdopen(fd, "wb") as file:
            for part in (data,) if isinstance(data, (bytes, bytearray)) else data:
                file.write(part)
        return decode(path)
    finally:
        try:
            os.unlink(path)
        except OSError:
            logger.debug("memento: couldn't delete the clip it wrote", exc_info=True)


def _voice(take: Take) -> Tuple[str, str]:
    """The model and prompt a take is heard with: the bot's settings as they stood at its first Piece."""
    if take.model is None:
        tt = _tools()
        cfg = _local_config(tt)
        prompt = ""
        if take.hearing:
            configured = (cfg.get("local") or {}).get("initial_prompt")
            prompt = (
                DictationHearingPrompt()
                .WithInitialPrompt(configured if isinstance(configured, str) else "")
                .WithHint(take.hint)
                .WithVocabulary(take.vocabulary)
                .Build()
            )
        take.model = _model_name(tt, cfg)
        take.prompt = prompt
    return take.model, take.prompt or ""


def _hear_piece(take: Take, data: bytes, content_type: Optional[str]) -> str:
    """One Piece's words, decoded on the host itself with the bot's Hearing prompt if it has one."""
    tt = _tools()
    model, prompt = _voice(take)
    return _landed(
        _temp(
            data,
            content_type,
            lambda path: tt._transcribe_local(path, model, prompt=prompt or None),
        )
    )


def _drop(key: Tuple[str, str]) -> Optional[Take]:
    """Takes a take out of the registry and ends everything it holds. Called with the lock held."""
    take = _takes.pop(key, None)
    if take is not None:
        take.stop()
        take.drop_audio()
    return take


def _expire(now: Optional[float] = None) -> None:
    """Drops every take nobody has touched inside its window. Called with the lock held."""
    moment = time.monotonic() if now is None else now
    stale = [key for key, take in _takes.items() if moment - take.touched > TAKE_SECONDS]
    for key in stale:
        _drop(key)
    if stale:
        logger.debug("memento: dropped %d dictation take(s) left alone", len(stale))


def _sweep() -> None:
    """Ages the registry on a clock of its own: a take left alone holds audio and a worker until it goes.

    Sweeping only when a request arrives would keep an abandoned take — a cloud take's whole audio
    with it — until the next dictation on that host, which may never come.
    """
    while True:
        time.sleep(TAKE_SECONDS / 2)
        with _takes_lock:
            _expire()


def _reap() -> None:
    """Starts the sweeper once, from the first take this process is handed."""
    global _sweeper
    if _sweeper is None or not _sweeper.is_alive():
        _sweeper = threading.Thread(target=_sweep, name="memento-dictation-sweep", daemon=True)
        _sweeper.start()


def _worker(take: Take) -> None:
    """The per-take worker: hears the Pieces this host keeps whole on itself, in arrival order."""
    while True:
        index = take.queue.get()
        if index is None:
            return
        with _takes_lock:
            piece = take.pieces.get(index)
            data = piece.get("data") if piece is not None else None
            content_type = piece.get("type") if piece is not None else None
        if piece is None or data is None:
            continue
        error: Optional[str] = None
        try:
            text = _hear_piece(take, data, content_type)
        except DictationError as failure:
            text, error = "", str(failure)
        except Exception:
            logger.warning("memento: couldn't hear a dictation Piece", exc_info=True)
            text, error = "", "Transcription failed."
        with _heard:
            piece["data"] = None
            piece["text"] = text
            if error:
                take.error = error
            _heard.notify_all()


def upload(
    profile: Optional[Any],
    take_id: str,
    index: int,
    data: bytes,
    content_type: Optional[str] = None,
    *,
    hint: str = "",
    vocabulary: Optional[Sequence[str]] = None,
    hearing: Callable[[], bool] | bool,
    ms: int = 0,
) -> Dict[str, Any]:
    """Records one Piece of a take, and answers with what it recorded — never with words.

    ``hearing`` is called only when the take opens: it is a store read, and the answer is the take's
    for its whole life. A local host hands the Piece to the take's worker, which hears it off the
    request path and drops its audio once its words exist; a host resolving a cloud provider holds
    the audio whole and sends nothing until the Confirm uploads the take (ADR 0074).
    """
    if not data:
        raise DictationError("The recording is empty.", 400)
    if len(data) > MAX_BYTES:
        raise DictationError("The recording is too long.", 413)
    if isinstance(index, bool) or not isinstance(index, int) or not 0 <= index < MAX_PIECES:
        raise DictationError("A Piece needs its index in the take.", 400)
    key = (str(profile or ""), str(take_id))
    with _takes_lock:
        _expire()
        take = _takes.get(key)
    if take is None:
        state = info()
        if not state.get("ready"):
            raise DictationError(state.get("reason") or "Dictation is off on the host.", 409)
        cloud = bool((state.get("provider") or {}).get("cloud"))
        hears = bool(hearing() if callable(hearing) else hearing)
        with _takes_lock:
            _expire()
            take = _takes.get(key)
            if take is None:
                # One take at a time per bot, as the host held it before: a second device's take would
                # otherwise put two decodes on one machine and stretch the bound this host states.
                if any(held[0] == key[0] for held in _takes):
                    raise DictationError("This bot is already hearing a take.", 409)
                take = _takes[key] = Take(
                    cloud=cloud,
                    hint=hint,
                    vocabulary=vocabulary or (),
                    hearing=hears,
                )
                _reap()
    with _takes_lock:
        take.touched = time.monotonic()
        if index not in take.pieces:
            take.pieces[index] = {"data": data, "type": content_type, "text": None, "ms": int(ms)}
            take.order.append(index)
            if not take.cloud:
                take.queue.put(index)
                if take.worker is None:
                    take.worker = threading.Thread(
                        target=_worker, args=(take,), name="memento-dictation-take", daemon=True
                    )
                    take.worker.start()
    return {"take": key[1], "index": index}


def _drain(take: Take) -> str:
    """Waits for the take's Pieces to be heard, then answers its words in the order they arrived."""
    deadline = time.monotonic() + QUEUE_SECONDS
    with _heard:
        while True:
            if take.error:
                raise DictationError(take.error)
            waiting = [index for index in take.order if take.pieces[index].get("text") is None]
            if not waiting:
                break
            left = deadline - time.monotonic()
            if left <= 0:
                raise DictationError("The take is still being heard.", 504)
            _heard.wait(min(left, 0.5))
    return take.joined()


def _bounded(seconds: float, call: Callable[[], Any]) -> Any:
    """``call``'s answer, or DictationError when it hasn't come inside ``seconds``.

    A vendor decode can't be interrupted, so the wait is the host's own: past it the take fails rather
    than promising the app an answer the provider has stopped producing.
    """
    box: List[Any] = []
    done = threading.Event()

    def run() -> None:
        try:
            box.append(call())
        except BaseException as error:  # noqa: BLE001 - handed back to the caller's own handler
            box.append(error)
        finally:
            done.set()

    threading.Thread(target=run, name="memento-dictation-upload", daemon=True).start()
    if not done.wait(seconds):
        raise DictationError("The take couldn't be uploaded to its provider in time.", 504)
    answer = box[0] if box else None
    if isinstance(answer, BaseException):
        raise answer
    return answer


def _upload_whole(take: Take) -> str:
    """Sends a cloud take's audio whole, once, at its Confirm — and drops it at either end."""
    parts = [take.pieces[index].get("data") or b"" for index in take.order]
    content_type = next(
        (take.pieces[index].get("type") for index in take.order if take.pieces[index].get("type")),
        "audio/webm",
    )
    try:
        if sum(len(part) for part in parts) > MAX_BYTES:
            raise DictationError("The recording is too long.", 413)
        if not any(parts):
            return ""
        return _landed(
            _bounded(CLOUD_SECONDS, lambda: _temp(parts, content_type, _dispatcher(_tools())))
        )
    finally:
        with _takes_lock:
            take.drop_audio()


def _behind(state: Dict[str, Any]) -> Tuple[str, str]:
    """The provider and model behind a take, as far as the host can name them."""
    route = state.get("provider") or {}
    return str(route.get("name") or ""), str(state.get("model") or "")


def confirm(
    profile: Optional[Any],
    take_id: str,
    count: int,
    *,
    level: Optional[str] = None,
    model: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    """Ends a take and answers for the whole of it, in the one call that carries words.

    ``count`` is how many Pieces the app sent; a host holding fewer refuses with ``MissingPieces``
    and exactly the indexes it is missing, so a dropped upload cannot land a short take. A complete
    take is drained, tidied at the bot's level and answered once; the entry goes as it is answered.
    """
    from . import dictation_cleanup

    state = info(level)
    if not state.get("ready"):
        raise DictationError(state.get("reason") or "Dictation is off on the host.", 409)
    if isinstance(count, bool) or not isinstance(count, int) or not 1 <= count <= MAX_PIECES:
        raise DictationError("A Confirm needs the number of Pieces the take has.", 400)
    key = (str(profile or ""), str(take_id))
    with _takes_lock:
        _expire()
        take = _takes.get(key)
    if take is None:
        raise MissingPieces(range(count), "The host no longer holds this take. Send it again.")
    missing = [index for index in range(count) if index not in take.pieces]
    if missing:
        raise MissingPieces(missing)
    try:
        heard = _upload_whole(take) if take.cloud else _drain(take)
        answer = dictation_cleanup.finish(
            heard,
            take.vocabulary,
            hint=take.hint,
            prompt=dictation_cleanup.DictationCleanupPrompt.ForLevel(level).Build(),
            model=model,
        )
    except BaseException:
        # A take that could not be answered ends here too: the app's Retry starts another under a
        # fresh id, so this entry could never be confirmed again and its audio must not sit.
        with _takes_lock:
            if _takes.get(key) is take:
                _drop(key)
        raise
    provider, heard_model = _behind(state)
    with _takes_lock:
        if _takes.get(key) is take:
            _drop(key)
    return {
        "text": answer["text"],
        "heard": heard,
        "ms": take.spoken(),
        "level": answer["level"],
        "cleaned": bool(answer["cleaned"]),
        "provider": provider,
        "model": heard_model,
    }


def cancel(profile: Optional[Any], take_id: str) -> bool:
    """Takes a take off the host at once: its words and its audio, without waiting for its window."""
    key = (str(profile or ""), str(take_id))
    with _takes_lock:
        return _drop(key) is not None
