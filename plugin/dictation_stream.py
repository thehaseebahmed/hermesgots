"""A dictation heard while it is spoken: a rolling window, and the words two windows agree on.

The app records one continuous Opus stream and sends it in slices as it is made. This module holds
the take on the host — the decoded audio, the last two hypotheses, the words already committed and
the phrases already closed — and answers each slice with what the take has newly committed. The
answer rides on the audio request itself, so a take is one connection to lose rather than two.

Faster-whisper still does the hearing, through Hermes's own local path, so the host's language, its
prompt and its anti-hallucination rules all still apply. Every Hermes internal is read with
``getattr``: one that moves only means dictation is off.

The rule that decides what is committed is ``newly_committed`` over ``settled``: the words the two
most recent windows agree on, short of the newest — the frontier word is held back until a later
window still has it — and past what is already committed. All plain functions over lists of words,
which is what lets the promise be tested without a model or a microphone.

A phrase is committed as text when it finishes, and tidied on the bot's own model first
(``dictation_cleanup.py``): the words a window commits are never rewritten, so the phrase — not a
later guess — is what carries the user's sentence into the bar.
"""

from __future__ import annotations

import inspect
import io
import os
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence

from . import dictation, dictation_cleanup, speech
from .dictation import clean_vocabulary

WINDOW_S = 4.0
HOP_S = 0.5
MIN_WINDOW_S = 0.4
OVERLAP_S = 0.3
_HEARD_WORDS = 32

QUIET_S = 15.0
SAMPLE_RATE = 16000

Transcriber = Callable[[Sequence[float], str], str]
Decoder = Callable[[bytes, bool], List[float]]


class TakeError(Exception):
    """A take that can't be heard: ended, or one too many for the profile."""

    def __init__(self, message: str, status: int = 409) -> None:
        super().__init__(message)
        self.status = status


def agree(first: Sequence[str], second: Sequence[str]) -> List[str]:
    out: List[str] = []
    for left, right in zip(first, second):
        if left != right:
            break
        out.append(left)
    return out


def settled(first: Sequence[str], second: Sequence[str]) -> List[str]:
    """The words two windows agree on, short of the newest: a frontier word can still be revised.

    The last word the windows agree on is the one the newer window was still weighing — the word
    after it is where the two guesses part — so it is held back until a later window still has it
    too. That is what makes a word the user has read a word that will not move (ADR 0016). Nothing
    is stranded by the wait: a phrase's close hears that phrase's audio whole and commits its tail.
    """
    return agree(first, second)[:-1]


def _near(first: str, second: str) -> bool:
    return first == second or (
        len(first) >= 2
        and len(second) >= 2
        and (first.startswith(second) or second.startswith(first))
    )


def newly_committed(
    committed: Sequence[str], stable: Sequence[str], *, revise_head: bool = False
) -> List[str]:
    """The words of ``stable`` past what the take already committed.

    ``stable`` is a window's settled text, a run of the take's words ending at its end. Where that
    run begins is found by matching its first words against the committed words wherever they sit —
    a window rolls forward as the take goes, so it may start before them, inside them or past them —
    and only what comes after the last committed word is new. A window that only re-heard words the
    take already committed, with its frontier revised so the run stops short of their end, adds
    nothing: a word is committed once, so it is shown once and never taken away again.

    ``revise_head`` is for a phrase's close, whose audio begins at the previous close's overlap: its
    first word is often a fragment of a word already committed. There a leading word that is
    ``_near`` a committed one, with the run continuing exactly behind it, is that committed word
    heard again — it is dropped too, so nothing appears twice and no committed word moves.
    """
    known = list(committed)
    fresh = list(stable)
    if not fresh:
        return []
    began, matched = len(known), 0
    search = range(max(0, len(known) - max(_HEARD_WORDS, len(fresh))), len(known))
    for at in search:
        size = 0
        while size < len(fresh) and at + size < len(known) and known[at + size] == fresh[size]:
            size += 1
        if size > matched or (size and size == matched and at > began):
            began, matched = at, size
            if size == len(fresh):
                break
    if matched or not revise_head:
        return fresh[max(0, len(known) - began) :]
    for at in search:
        if not _near(fresh[0], known[at]):
            continue
        size = 0
        while (
            size + 1 < len(fresh)
            and at + size + 1 < len(known)
            and known[at + size + 1] == fresh[size + 1]
        ):
            size += 1
        if size >= 1 and size + 1 >= matched:
            matched = size + 1
    return fresh[matched:]


class Decoder:
    """The take's slices, turned into 16 kHz mono samples the model can read.

    The app cuts one continuous stream every 250 ms, so only the first slice carries the container's
    header; the rest are clusters of the same stream. A later slice is decoded by putting the header
    back in front of it, and the audio the header itself held is trimmed off by the frame count the
    first decode measured.
    """

    def __init__(self, rate: int = SAMPLE_RATE) -> None:
        self.rate = rate
        self.head = b""
        self.head_frames = 0
        self.recent = b""

    def __call__(self, data: bytes, first: bool) -> List[float]:
        try:
            import av
        except ImportError as error:  # PyAV ships with faster-whisper; a host without it can't hear.
            raise TakeError("This Hermes can't decode audio while it is spoken.", 501) from error
        if first:
            self.head = data
            samples = self._samples(av, data)
            self.head_frames = len(samples)
            return samples
        try:
            samples = self._samples(av, self.head + data)
        except Exception:
            # A slice PyAV can't read alone: give it the bytes since the last one that decoded.
            samples = self._samples(av, self.head + self.recent + data)
            self.recent = b""
        self.recent = b"" if samples else self.recent + data
        return samples[self.head_frames :]

    def _samples(self, av: Any, blob: bytes) -> List[float]:
        container = av.open(io.BytesIO(blob), mode="r")
        try:
            stream = container.streams.audio[0]
            resampler = av.AudioResampler(format="flt", layout="mono", rate=self.rate)
            out: List[float] = []
            for frame in container.decode(stream):
                for piece in _frames(resampler.resample(frame)):
                    out.extend(float(value) for value in piece.to_ndarray().reshape(-1))
            for piece in _frames(resampler.resample(None)):
                out.extend(float(value) for value in piece.to_ndarray().reshape(-1))
            return out
        finally:
            container.close()


def _frames(resampled: Any) -> List[Any]:
    """PyAV answers one frame, a list of them, or nothing while it buffers."""
    if resampled is None:
        return []
    return list(resampled) if isinstance(resampled, list) else [resampled]


class Take:

    def __init__(
        self,
        transcribe: Transcriber,
        decode: Optional[Decoder] = None,
        *,
        clock: Callable[[], float] = time.monotonic,
        hint: str = "",
        vocabulary: Sequence[str] = (),
        language: str = "",
        model: str = "",
        clean: Optional[Callable[[str], str]] = None,
        cleanup_model: Optional[Dict[str, str]] = None,
        window_s: float = WINDOW_S,
        hop_s: float = HOP_S,
        quiet_s: float = QUIET_S,
        rate: int = SAMPLE_RATE,
    ) -> None:
        self.id = f"dt-{uuid.uuid4().hex[:12]}"
        self.hint = hint
        # The bot's words, kept on the take rather than only in the prompt: a finished phrase is
        # cleaned up against the same list (#290), so both readers share the one list.
        self.vocabulary = clean_vocabulary(vocabulary)
        self.language = language
        self.model = model
        self.window_s = window_s
        self.hop_s = hop_s
        self.quiet_s = quiet_s
        self.rate = rate
        self._transcribe = transcribe
        self._decode = decode
        self._clock = clock
        # A finished phrase's cleanup, injected as the transcriber is: the rules of when a phrase is
        # tidied are the take's, and what a model answers is the cleaner's (#290).
        self._clean = clean or dictation_cleanup.Cleaner(self.vocabulary, model=cleanup_model)
        self._lock = threading.RLock()
        self._samples: List[float] = []
        self._committed: List[str] = []
        self._phrase_words: List[str] = []
        self._phrases: List[Dict[str, Any]] = []
        self._previous: List[str] = []
        self._first = True
        self._closed = 0
        self._phrase_from = 0
        self._decoded_at = clock()
        self._heard_at = clock()
        self._hop = hop_s
        self._behind = False
        self._dropped = False


    @property
    def dropped(self) -> bool:
        return self._dropped

    @property
    def behind(self) -> bool:
        return self._behind

    @property
    def buffered(self) -> int:
        return len(self._samples)

    @property
    def committed(self) -> List[str]:
        return list(self._committed)

    @property
    def phrases(self) -> List[Dict[str, Any]]:
        return [dict(phrase) for phrase in self._phrases]

    def expired(self) -> bool:
        return self._dropped or self._clock() - self._heard_at > self.quiet_s

    def free(self) -> None:
        with self._lock:
            self._dropped = True
            self._samples = []
            self._previous = []
            self._phrase_words = []


    def add(self, data: bytes, pause: bool = False) -> Dict[str, Any]:
        with self._lock:
            self._live()
            if not data:
                return self._quiet()
            samples = self._heard_samples(data)
            self._first = False
            self._samples.extend(samples)
            self._heard_at = self._clock()
            if len(self._samples) < MIN_WINDOW_S * self.rate:
                return self._quiet()
            if pause:
                return self._close_phrase()
            if self._due():
                return self._hop_decode()
            return self._quiet()

    def stop(self) -> Dict[str, Any]:
        with self._lock:
            self._live()
            answer = self._close_phrase()
            self.free()
            return answer

    def cancel(self) -> None:
        self.free()


    def _heard_samples(self, data: bytes) -> List[float]:
        if self._decode is None:
            return []
        try:
            return self._decode(data, self._first)
        except TakeError:
            raise
        except Exception as error:
            raise TakeError(f"Couldn't decode the recording: {error}", 502) from error

    def _live(self) -> None:
        if self._dropped:
            raise TakeError("This dictation has ended.", 410)

    def _quiet(self) -> Dict[str, Any]:
        return {"words": "", "phrases": [], "behind": self._behind}

    def _due(self) -> bool:
        return self._clock() - self._decoded_at >= self._hop

    def _prompt(self) -> str:
        """What the host heard so far in front of the window, so names and casing carry.

        The host's own prompt comes first, then the bot's vocabulary, then the tail of what was
        already said: Whisper reads the prompt as the words just before the window, which is why
        the committed text is last. The vocabulary biases the spelling of the words the user cares
        about, and the same list is what a finished phrase is cleaned up against (#290).
        """
        tail = " ".join(self._committed[-_PROMPT_WORDS:])
        words = " ".join(self.vocabulary)
        return " ".join(part for part in (self.hint, words, tail) if part)

    def _window(self) -> List[float]:
        return self._samples[-int(self.window_s * self.rate) :]

    def _hop_decode(self) -> Dict[str, Any]:
        window = self._window()
        started = self._clock()
        text = self._transcribe(window, self._prompt())
        took = self._clock() - started
        words = str(text or "").split()
        # Only what this window and the one before it both still hold, and not the word at their
        # frontier: that one can still be revised, so it waits for the next window (ADR 0016).
        stable = settled(self._previous, words)
        self._previous = words
        fresh = newly_committed(self._committed, stable)
        self._committed.extend(fresh)
        self._phrase_words.extend(fresh)
        self._decoded_at = self._clock()
        # A host that can't decode its window within real time stretches its windows rather than
        # building a backlog, and says it is behind (ADR 0015).
        self._hop = max(self.hop_s, took)
        self._behind = took > len(window) / self.rate
        return {"words": " ".join(fresh), "phrases": [], "behind": self._behind}

    def _close_phrase(self) -> Dict[str, Any]:
        tail = self._samples[self._phrase_from :]
        if tail:
            text = self._transcribe(tail, self._prompt())
            fresh = newly_committed(self._committed, str(text or "").split(), revise_head=True)
            self._committed.extend(fresh)
            self._phrase_words.extend(fresh)
        phrase: Optional[Dict[str, Any]] = None
        if self._phrase_words:
            self._closed += 1
            # Tidied before it is committed, and only here: a phrase is cleaned once, as it closes,
            # so what answers this request is the text the user reads (#290, ADR 0017).
            phrase = {"id": self._closed, "text": self._tidied(" ".join(self._phrase_words))}
            self._phrases.append(phrase)
        self._phrase_words = []
        self._phrase_from = max(0, len(self._samples) - int(OVERLAP_S * self.rate))
        del self._samples[: self._phrase_from]
        self._phrase_from = 0
        self._previous = []
        self._decoded_at = self._clock()
        return {"words": "", "phrases": [phrase] if phrase else [], "behind": self._behind}

    def _tidied(self, text: str) -> str:
        """The phrase as the user reads it: its tidied words, or the words the host heard.

        A cleanup that raises or answers nothing is a cleanup that didn't happen, so the take goes
        on with the phrase exactly as it was heard — the promise that a take can't be failed by its
        own cleanup (ADR 0017).
        """
        try:
            cleaned = self._clean(text)
        except Exception:
            return text
        return cleaned if isinstance(cleaned, str) and cleaned.strip() else text


# Whisper keeps the last 224 prompt tokens; a hundred words is well inside that.
_PROMPT_WORDS = 100


class Takes:
    """The one take a profile may have open, and the sweep that drops a quiet one.

    One at a time per profile, as one clip at a time was: decoding holds the CPU that the profile's
    own turns need (ADR 0015). ``reap`` runs a thread that drops a take which has heard nothing for
    ``QUIET_S``, so its buffer is let go even when no request ever comes back for it; tests drive
    ``sweep`` themselves instead.
    """

    def __init__(self, *, reap: bool = False, clock: Callable[[], float] = time.monotonic) -> None:
        self._lock = threading.Lock()
        self._takes: Dict[str, Take] = {}
        self._clock = clock
        self._reap = reap
        self._reaper: Optional[threading.Thread] = None

    def open(self, profile: str, take: Take) -> Take:
        with self._lock:
            self._sweep_locked()
            held = self._takes.get(profile)
            if held is not None:
                raise TakeError("A dictation is already being heard on this bot.", 409)
            self._takes[profile] = take
            self._reaper_on_locked()
            return take

    def get(self, profile: str, take_id: str) -> Take:
        with self._lock:
            self._sweep_locked()
            take = self._takes.get(profile)
            if take is None or take.id != take_id:
                raise TakeError("This dictation has ended.", 410)
            return take

    def release(self, profile: str, take: Take) -> None:
        with self._lock:
            if self._takes.get(profile) is take:
                del self._takes[profile]
            if not take.dropped:
                take.free()

    def sweep(self) -> int:
        with self._lock:
            return self._sweep_locked()

    def _sweep_locked(self) -> int:
        for profile, take in list(self._takes.items()):
            if take.expired():
                take.free()
                del self._takes[profile]
        return len(self._takes)

    def _reaper_on_locked(self) -> None:
        if not self._reap or self._reaper is not None:
            return
        self._reaper = threading.Thread(
            target=self._reap_loop, name="memento-dictation-takes", daemon=True
        )
        self._reaper.start()

    def _reap_loop(self) -> None:
        while True:
            time.sleep(1.0)
            with self._lock:
                if self._sweep_locked():
                    continue
                self._reaper = None
                return


def _wav(samples: Sequence[float], path: Path) -> None:
    """A window of samples as a 16-bit mono WAV, which is what Hermes's local path reads."""
    import array
    import wave

    pcm = array.array("h", (int(max(-1.0, min(1.0, float(x))) * 32767) for x in samples))
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(SAMPLE_RATE)
        out.writeframes(pcm.tobytes())


def transcriber(tt: Any, model: str, language: str = "") -> Transcriber:
    """Hermes's own local transcription, one window at a time, with the take's language pinned."""

    takes_language = False
    try:
        takes_language = "language" in inspect.signature(tt._transcribe_local).parameters
    except (TypeError, ValueError):
        takes_language = False

    def transcribe(samples: Sequence[float], prompt: str) -> str:
        fd, path = tempfile.mkstemp(prefix="memento-dictation-window-", suffix=".wav")
        os.close(fd)
        options: Dict[str, Any] = {"prompt": prompt or None}
        if takes_language and language:
            options["language"] = language
        try:
            _wav(samples, Path(path))
            result = tt._transcribe_local(path, model, **options)
        finally:
            try:
                os.unlink(path)
            except OSError:
                pass
        if not isinstance(result, dict):
            raise dictation.DictationError("Transcription failed.")
        if not result.get("success"):
            error = str(result.get("error") or "Transcription failed.")
            if "empty transcript" in error.lower():
                return ""
            raise dictation.DictationError(error)
        text = " ".join(str(result.get("transcript") or "").split())
        return "" if not text or dictation._hallucination(text) else text

    return transcribe


def start(
    takes: Takes,
    profile: str,
    hint: str = "",
    vocabulary: Sequence[str] = (),
    cleanup_model: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    state = dictation.info()
    if not state.get("ready"):
        raise dictation.DictationError(state.get("reason") or "Dictation is off on the host.", 409)
    tt = dictation._tools()
    cfg = dictation._local_config(tt)
    wanted = dictation._model_name(tt, cfg)
    played = speech.play(wanted, dictation.warm)
    model = played["model"]
    language = str(state.get("language") or "")
    take = Take(
        transcriber(tt, model, language),
        Decoder(),
        hint=dictation.clean_hint(hint),
        vocabulary=vocabulary,
        language=language,
        model=model,
        cleanup_model=cleanup_model,
    )
    takes.open(profile, take)
    answer = {"take": take.id, "ready": True, "model": model, "language": language}
    return answer
