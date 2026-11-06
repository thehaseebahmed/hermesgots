"""Where a Piece's cut falls, in one rule the bench can be handed two ways (ADR 0075).

The app decides this, not the host: while the user talks, it measures the microphone's loudness every
50 ms, learns the room's own floor, and closes a Piece on a pause it can confirm. The bench is handed
the same rule as data — ``POLICIES`` — so identical audio can be sliced two ways and the only variable
is where the cut falls. ``device`` is the rule the app runs today; ``long-floor`` is the one it ran
before #771, kept so the same audio is a diff rather than a memory; ``whole`` cuts nothing, which is
the take the app records when its meter is missing.

What is measured, and how: the app reads RMS over a 512-sample window every 50 ms at the microphone's
own rate, so the bench reads each 50 ms window of the fixture's samples. That is the same rule over
the same span, and it is why every fixture is a whole number of windows at its own rate.
"""

from __future__ import annotations

import math
import re
import sys
import wave
from array import array
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterator, List, Sequence, Tuple

from . import ROOT

# The app's own numbers (`app/src/lib/dictation.ts`): PIECE_MS, PAUSE_MS, LONG_PIECE_MS, QUIET_MIN,
# QUIET_MAX and SAMPLE_MS, with the floor's creep towards a noisier room. A cap that takes no pause is
# a zero here and no constant there, which is why `app_rule_problems` keeps no fourth name for it.
# That function reads the app's file and holds these numbers to it, because a bench that slices by a
# rule the app has stopped running measures the wrong thing and calls it a baseline. The phone's own
# recorder (`BubbleRecorder.kt`) cuts by the same rule with no page to ask, so it is read there too:
# its numbers are compiled into the APK, and a copy nothing checks is a copy that drifts.
QUIET_MIN = 0.012
QUIET_MAX = 0.05
WINDOW_MS = 50
CREEP = 0.002
# The app's analyser buffer (`analyser.fftSize = 512`): the span one loudness reading covers,
# whatever the microphone's rate. Its tick is the window; its buffer is the reading.
FFT_SAMPLES = 512


@dataclass(frozen=True)
class CutPolicy:
    """One rule for where a Piece ends: its floor, its pause, its cap, and what counts as quiet."""

    name: str
    floor_ms: int
    pause_ms: int
    cap_ms: int
    cap_pause_ms: int
    pauses: bool = True

    def closes(self, length_ms: int, pause_ms: int, heard: bool = True) -> bool:
        """Whether a Piece this long, with a pause this long behind it, ends here.

        A ``cap_pause_ms`` of zero is a cap that needs no pause at all: the Piece ends at its length
        whatever the meter hears. Both arms still want the meter to have heard something since the
        last cut, so a room's tone alone never makes a Piece.
        """
        if not self.pauses or not heard:
            return False
        if length_ms >= self.cap_ms and pause_ms >= self.cap_pause_ms:
            return True
        return length_ms >= self.floor_ms and pause_ms >= self.pause_ms

    def stated(self) -> Dict[str, object]:
        """The policy as a record names it, so two runs can be refused as incomparable."""
        return {
            "name": self.name,
            "floor_ms": self.floor_ms,
            "pause_ms": self.pause_ms,
            "cap_ms": self.cap_ms,
            "cap_pause_ms": self.cap_pause_ms,
            "quiet_min": QUIET_MIN,
            "quiet_max": QUIET_MAX,
            "window_ms": WINDOW_MS,
            "creep": CREEP,
        }


APP_RULE = ROOT / "app" / "src" / "lib" / "dictation.ts"
PHONE_RULE = (
    ROOT / "app" / "android" / "app" / "src" / "main" / "java" / "dev" / "hermesgots" / "BubbleRecorder.kt"
)

POLICIES: Dict[str, CutPolicy] = {
    # The rule the app runs today, and the numbers `app_rule_problems` holds to its file (#771). A
    # Piece is also the tail a Stop waits for, so its cap takes no pause: `cap_pause_ms` of zero.
    "device": CutPolicy("device", floor_ms=1200, pause_ms=350, cap_ms=25_000, cap_pause_ms=0),
    "long-floor": CutPolicy(
        "long-floor", floor_ms=6000, pause_ms=700, cap_ms=25_000, cap_pause_ms=350
    ),
    # No meter, so no cut: the recording goes whole, as one Piece.
    "whole": CutPolicy("whole", floor_ms=0, pause_ms=0, cap_ms=0, cap_pause_ms=0, pauses=False),
}


@dataclass(frozen=True)
class Piece:
    """One Piece of a take: where it starts and ends in the fixture, and how long it ran."""

    start_ms: int
    end_ms: int

    @property
    def ms(self) -> int:
        return self.end_ms - self.start_ms


def read(path: Path) -> Tuple[array, int]:
    """A fixture's samples as floats in -1..1, and the rate it was recorded at.

    A WAV is read by the standard library; anything else — the app's own WebM — is read by the
    decoder stack's own reader. Hermes's own ``decode_audio`` would do it, but it resamples to 16 kHz,
    and the window a Piece's cut falls on has to be measured at the rate the fixture was recorded at.
    """
    if path.suffix.lower() == ".wav":
        with wave.open(str(path), "rb") as source:
            if source.getsampwidth() != 2 or source.getnchannels() != 1:
                raise ValueError(f"{path.name} isn't 16-bit mono, which a fixture must be")
            frames = array("h")
            frames.frombytes(source.readframes(source.getnframes()))
        if sys.byteorder == "big":
            frames.byteswap()
        return array("f", (sample / 32768.0 for sample in frames)), source.getframerate()
    return _read_elsewhere(path)


def _read_elsewhere(path: Path) -> Tuple[array, int]:
    import av  # the decoder's own reader; a host that can hear a take already has it

    with av.open(str(path)) as box:
        stream = box.streams.audio[0]
        rate = stream.rate or 48_000
        resampler = av.AudioResampler(format="flt", layout="mono", rate=rate)
        samples = array("f")
        for frame in box.decode(stream):
            for out in resampler.resample(frame):
                samples.extend(out.to_ndarray().reshape(-1).tolist())
        for out in resampler.resample(None):
            samples.extend(out.to_ndarray().reshape(-1).tolist())
    return samples, rate


def app_rule_problems(policy: CutPolicy) -> List[str]:
    """The ``device`` policy against both recorders that run it: a rule that drifts is a baseline that lies.

    The app's cut is TypeScript, the phone's is Kotlin and the bench's is Python, so the numbers live
    three times by necessity, and this is where they are put side by side. It compares the numbers
    each side declares, not the shape of its branch: what it can prove is that a number moved, never
    that each side consults it where the policy does. The phone's window is compared as a span —
    ``FRAME`` samples at ``RATE`` — because it counts samples where the page counts milliseconds.
    """
    return (
        _span(APP_RULE, policy, ("const", "let"), window="SAMPLE_MS")
        + _span(PHONE_RULE, policy, ("private const val", "const val"))
        + _window_problems(PHONE_RULE, policy)
    )


def _span(
    path: Path, policy: CutPolicy, declares: Tuple[str, ...], window: str = ""
) -> List[str]:
    """One file's numbers, with its own word for a constant: the two languages do not spell it alike.

    ``window`` names the constant that states the meter's tick where a file keeps it as milliseconds;
    the phone keeps its tick as a sample count, so it is compared by `_window_problems` instead.
    """
    if not path.exists():
        return [f"{path.relative_to(ROOT)} isn't here: the cut rule can't be compared"]
    text = path.read_text()
    stated = policy.stated()
    named = {
        "PIECE_MS": stated["floor_ms"],
        "PAUSE_MS": stated["pause_ms"],
        "LONG_PIECE_MS": stated["cap_ms"],
        "QUIET_MIN": stated["quiet_min"],
        "QUIET_MAX": stated["quiet_max"],
    }
    if window:
        named[window] = stated["window_ms"]
    words = "|".join(declares)
    problems = []
    for name, mine in named.items():
        found = re.search(rf"\b(?:{words})\s+{name}\s*=\s*([0-9_.]+)", text)
        if found is None:
            problems.append(f"{path.name} declares no {name}: the policy can't be compared")
            continue
        theirs = float(found.group(1).replace("_", ""))
        if float(mine) != theirs:
            problems.append(f"the {policy.name} policy cuts at {name}={mine}, {path.name} at {theirs}")
    if "0.002" not in text:
        problems.append(f"the floor no longer creeps by 0.002 in {path.name}, which the policy still does")
    if policy.cap_pause_ms == 0 and re.search(r"\bSHORT_PAUSE_MS\b", text):
        problems.append(
            f"the {policy.name} policy's cap needs no pause, and {path.name} still keeps SHORT_PAUSE_MS"
        )
    return problems


def _window_problems(path: Path, policy: CutPolicy) -> List[str]:
    """The tick a cut is confirmed on, where a recorder states samples rather than milliseconds."""
    if not path.exists():
        return []
    found = re.search(r"\bFRAME\s*=\s*([0-9_]+)", path.read_text())
    rate = re.search(r"\bRATE\s*=\s*([0-9_]+)", path.read_text())
    if found is None or rate is None:
        return [f"{path.name} declares no FRAME and RATE: its window can't be compared"]
    span = float(found.group(1).replace("_", "")) / float(rate.group(1).replace("_", "")) * 1000
    want = float(policy.stated()["window_ms"])
    if span != want:
        return [f"the {policy.name} policy reads every {want:g} ms, {path.name} every {span:g} ms"]
    return []


def _windows(samples: Sequence[float], rate: int, window_ms: int) -> Iterator[float]:
    """Each tick's loudness, as the app reads it: the RMS of its last 512 samples, every 50 ms.

    Not the RMS of the whole 50 ms: the app's analyser is 512 samples wide, so a reading covers the
    buffer's span and the tick only decides when it is taken. The first readings of a take hold part
    of a buffer the app would have had zero-filled, and are divided the same way.
    """
    step = max(1, rate * window_ms // 1000)
    for end in range(step, len(samples) + 1, step):
        chunk = samples[max(0, end - FFT_SAMPLES) : end]
        yield math.sqrt(sum(sample * sample for sample in chunk) / FFT_SAMPLES)


def pieces(samples: Sequence[float], rate: int, policy: CutPolicy) -> List[Piece]:
    """Where ``policy`` closes a Piece over these samples, in order, with the tail as the last one."""
    total_ms = len(samples) * 1000 // rate
    edges = [0]
    floor = math.inf
    quiet_since = None
    started = 0
    heard = False
    for index, loudness in enumerate(_windows(samples, rate, WINDOW_MS)):
        # The quietest the room gets, creeping up slowly so a noisier room is learnt.
        floor = loudness if loudness < floor else floor + (loudness - floor) * CREEP
        quiet = loudness < min(max(QUIET_MIN, floor * 2.5), QUIET_MAX)
        now_ms = (index + 1) * WINDOW_MS
        if not quiet:
            quiet_since = None
            heard = True
        elif quiet_since is None:
            quiet_since = now_ms
        length = now_ms - started
        pause = 0 if quiet_since is None else now_ms - quiet_since
        # Asked even while the room is loud: a cap that needs no pause is the only thing bounding a
        # take whose floor never drops quiet enough to confirm one.
        if policy.closes(length, pause, heard):
            edges.append(now_ms)
            started = now_ms
            heard = False
    if edges[-1] < total_ms:
        edges.append(total_ms)
    return [Piece(start, end) for start, end in zip(edges, edges[1:]) if end > start]


def slice_wav(samples: Sequence[float], rate: int, piece: Piece) -> bytes:
    """One Piece as its own container: 16-bit mono WAV, which is what the wire can re-send.

    ``plugin/meetings.py``'s ``_wav`` writes the same container for a meeting's window; the two
    cannot merge while the plugin ships without this module, so this is the second copy and its
    clamp is the one the two must agree on.
    """
    import io

    start = piece.start_ms * rate // 1000
    end = piece.end_ms * rate // 1000
    out = io.BytesIO()
    with wave.open(out, "wb") as file:
        file.setnchannels(1)
        file.setsampwidth(2)
        file.setframerate(rate)
        file.writeframes(
            array(
                "h", (max(-32768, min(32767, int(sample * 32767))) for sample in samples[start:end])
            ).tobytes()
        )
    return out.getvalue()
