"""A host's own hearing, timed once, and the model that measurement recommends (ADR 0075).

The picker used to weigh a pick on a realtime factor nobody had timed: `speech.MODELS` carried a
printed guess beside each model's size, and that guess drew the rows and decided the "too slow"
note. This module replaces the guess with a measurement the host takes of itself — one short
recording, decoded by each model this host already has on disk, timed on the way out — kept in the
bot's settings store with the model it was taken on.

Four rules hold it:

- **The fixture is bytes, not a voice made fresh.** `speech/probe.wav` is the dictation bench's own
  `one-piece` recording, copied here so the plugin carries it and committed so this week's
  measurement is comparable with last month's. Its digest rides in the record, so a record taken on
  other bytes is not this host's either.
- **Only what is already on disk is heard.** A probe that fetched a model would cost the user
  gigabytes to answer a question about speed. A model this host doesn't have has no measurement,
  and the picker says so instead of printing a number nobody took.
- **A measurement belongs to the machine that took it.** It is kept with the host's name, machine,
  processor count and Python, and a record from another machine is never presented as this host's:
  `state` answers it as someone else's, which the page says plainly and which asks for a fresh take.
- **The recommendation is read off the measurement and the catalogue's sizes, nothing else.** Among
  the models measured as keeping up with speech — `KEEP_UP`, the factor below which a model can't
  follow someone talking — the heaviest is recommended, because accuracy in this family climbs
  with size and speed is the one thing a host can measure for itself. Where nothing keeps up, the
  fastest measured model is recommended, as the best this machine can do. Where nothing was
  measured, nothing is recommended at all: a recommendation is a measurement's to make.

Each model is warmed before it is timed, so the number is the decode's and not the load's; the load
is recorded beside it. What is timed is Hermes's own local decode, the call a Piece makes, given no
prompt — a probe is not a take, and no bot setting decides how it is heard. A probe waits while the
host is hearing one: loading other models under a live take could evict the model it is hearing on.
"""

from __future__ import annotations

import hashlib
import logging
import os
import platform
import socket
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence

from . import dictation
from .store import get_setting, put_setting

logger = logging.getLogger(__name__)

OBJECT = "memento.speech.probe"
KEY = "speech_probe"
FIXTURE = Path(__file__).parent / "speech" / "probe.wav"
KEEP_UP = 2.0

NOTHING_ON_DISK = (
    "No speech model is on disk yet, so there is nothing to time. The next take downloads the one "
    "in play."
)
NO_FIXTURE = "This plugin is missing the recording it times a model with, so nothing can be measured."
NO_DECODER = "This Hermes has no local speech-to-text, so there is nothing on this host to time."
BUSY = "This host is hearing a take right now, so it can't time a model without getting in its way."
NOTHING_LOADED = "None of the models on disk could be loaded here, so this host measured nothing."

# One probe at a time per process: two devices opening the picker at once ask one measurement of it,
# so the second waits its turn and times only what the first left unmeasured.
_probing = threading.Lock()

_machine: Optional[Dict[str, Any]] = None


class Unavailable(Exception):
    """Nothing on this host can be timed, so the answer is the reason rather than a measurement."""


class Busy(Exception):
    """A take is being heard: the probe stands aside rather than loading models under it."""


class Unheard(Exception):
    """One decode answered nothing usable, so that model was not measured."""


def stamp() -> str:
    """The record's clock, in the format every other record here is stamped in."""
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


MACHINE_FIELDS = ("name", "machine", "system", "cpus")


def _comparable(host: Mapping[str, Any]) -> Dict[str, Any]:
    return {field: host.get(field) for field in MACHINE_FIELDS}


def machine() -> Dict[str, Any]:
    """The machine a measurement was taken on: named, so another one's can't pass for this one's.

    Read once per process: a host's name, its architecture and its processor count don't change
    under a running plugin, and every speech read compares a stored record against them. A copy goes
    out, so nothing a caller does to the answer can move what the next comparison reads.
    """
    global _machine
    if _machine is None:
        _machine = {
            "name": socket.gethostname(),
            "machine": platform.machine(),
            "system": platform.system(),
            "cpus": os.cpu_count() or 0,
            "python": platform.python_version(),
        }
    return dict(_machine)


def spoken_ms(fixture: Optional[Path] = None) -> int:
    """How long the fixture takes to say, read from its own header rather than guessed.

    A WAV is a header and frames, so the standard library reads it: no decoder is needed to know
    what the recording is worth, and the figure is the one every model's factor is divided into.
    """
    import wave

    try:
        with wave.open(str(fixture or FIXTURE), "rb") as held:
            rate = held.getframerate()
            return round(held.getnframes() * 1000 / rate) if rate else 0
    except (OSError, EOFError, wave.Error) as missing:
        raise Unavailable(NO_FIXTURE) from missing


def digest(fixture: Optional[Path] = None) -> Optional[str]:
    """The fixture's own bytes as one string, or None where the plugin is missing the recording."""
    try:
        return hashlib.sha256((fixture or FIXTURE).read_bytes()).hexdigest()
    except OSError:
        return None


def keeps_up(entry: Mapping[str, Any]) -> bool:
    """Whether a measured model hears speech faster than it is said: the one threshold, stated once."""
    return _realtime(entry) >= KEEP_UP


def recommend(measured: Mapping[str, Mapping[str, Any]], sizes: Mapping[str, int]) -> Optional[str]:
    """The one model this measurement recommends, or None where it measured nothing.

    The heaviest model that keeps up: that is the most accurate of the ones this machine can afford,
    and every part of it — which models keep up, and the sizes they are weighed by — is either
    measured here or the catalogue's own download figure. A tie is settled by the model's name, so
    one measurement always answers the same row, and where nothing keeps up the fastest does, because
    the fastest is then the best this host can do.
    """
    if not measured:
        return None
    keeps = [name for name in measured if keeps_up(measured[name])]
    if keeps:
        return max(keeps, key=lambda name: (int(sizes.get(name) or 0), name))
    return max(measured, key=lambda name: (_realtime(measured[name]), name))


def _realtime(entry: Mapping[str, Any]) -> float:
    try:
        return float(entry.get("realtime") or 0.0)
    except (TypeError, ValueError):
        return 0.0


def kept(path: Path) -> Optional[Dict[str, Any]]:
    """The stored record, as this plugin wrote it, or None where there is none to read."""
    held = get_setting(path, KEY)
    if not isinstance(held, dict) or held.get("object") != OBJECT:
        return None
    models = held.get("models")
    if not isinstance(models, dict) or not models:
        return None
    return held


def _elsewhere(held: Mapping[str, Any]) -> Optional[Dict[str, Any]]:
    """Another machine's measurement, named, where the record isn't this machine's own.

    Compared on what makes a machine and how fast it hears — its name, architecture, system and
    processor count — not on the Python the plugin happens to run under: an interpreter upgrade is
    the same machine, and calling it somebody else's would refuse a measurement that is still this
    host's. A name that matches while something else doesn't is not named back, since "measured on
    this host, not this host" says nothing.
    """
    taken = held.get("host") if isinstance(held.get("host"), dict) else {}
    if {field: taken.get(field) for field in MACHINE_FIELDS} == _comparable(machine()):
        return None
    name = str(taken.get("name") or "")
    if name == machine()["name"]:
        name = ""
    return {"name": name, "at": str(held.get("at") or "")}


def state(
    path: Path, sizes: Optional[Mapping[str, int]] = None, present: Sequence[str] = ()
) -> Dict[str, Any]:
    """What the picker draws about a measurement: which models have one, and which is recommended.

    ``sizes`` is the catalogue's download figure per model, which the recommendation weighs the
    measured rows by; ``present`` names the models on disk, which decides whether an owed
    measurement can be taken at all. A record from another machine, or one taken on other bytes than
    this plugin's recording — or one that doesn't say which bytes it heard — is no measurement of this
    host: its models are left out, its machine is
    named, and the host is owed a fresh one. The measurement per model comes back under ``models``:
    a map, which is what a caller states on its rows.

    ``owed`` is this host's own answer to "measure once": nothing kept yet, a record from elsewhere
    or from other bytes, or a model on disk that no record speaks for — a model downloaded since the
    last probe. The rows still carry what was measured before, so a page never loses a factor it had.
    """
    sizes = sizes or {}
    held = kept(path)
    elsewhere = _elsewhere(held) if held is not None else None
    taken_on = held.get("fixture") if held is not None and isinstance(held.get("fixture"), dict) else {}
    rehash = None if held is None else digest()
    stale = held is not None and taken_on.get("sha256") != rehash
    if held is None or elsewhere is not None or stale:
        reason = None
        if elsewhere is None and not present:
            reason = NOTHING_ON_DISK if digest() is not None else NO_FIXTURE
        return {
            "owed": True,
            "at": None,
            "models": {},
            "recommended": None,
            "elsewhere": elsewhere,
            "reason": reason,
        }
    models = {name: dict(entry) for name, entry in held["models"].items() if isinstance(entry, dict)}
    return {
        "owed": any(name not in models for name in present),
        "at": held.get("at"),
        "models": models,
        "recommended": recommend(models, sizes),
        "elsewhere": None,
        "reason": None,
    }


def here(path: Path) -> Dict[str, Dict[str, Any]]:
    """The measurements this machine holds for this plugin's recording, or none where it holds any."""
    return state(path)["models"]


def _timed(decode: Any, fixture: Path, name: str) -> int:
    """One decode of the fixture on ``name``, in milliseconds, or nothing where it heard nothing.

    Hermes's own local decode answers a failure as a result — ``{"success": False, "error": …}`` —
    rather than raising, so the answer is read: an error path is fast enough to look like a very
    quick model, and a model that couldn't be loaded must not be timed as if it had heard the take.
    """
    started = time.monotonic()
    answer = decode(str(fixture), name, prompt=None)
    elapsed = int((time.monotonic() - started) * 1000)
    if not isinstance(answer, dict) or not answer.get("success"):
        raise Unheard(str((answer or {}).get("error") or "the host answered no words"))
    return elapsed


def measure(
    path: Path, models: Sequence[str], keep: Optional[Mapping[str, Dict[str, Any]]] = None
) -> Optional[Dict[str, Any]]:
    """Times this host's hearing on the fixture, one model at a time, and keeps what it measured.

    Each model is decoded twice: the first warms it, so the load isn't read as slowness, and the
    second is the number. A model that can't be loaded is left out rather than failing the probe — a
    half-fetched model is a real state on a host — and a probe that loaded nothing raises, since a
    record of no measurements is not a measurement. A probe asked only for models the host has not
    measured yet (``keep`` is what the record already holds) adds to that record and answers None
    where it measured nothing new: the earlier numbers still stand. A probe asked while another runs
    waits its turn and then times only what that one left unmeasured.

    A take arriving mid-probe ends it with nothing written: loading the next model under a take is
    the one thing this stands aside for. Hermes's lazy install is never reached, so a question about
    speed never downloads anything — no model, and no package either.
    """
    if dictation.holds_a_take():
        raise Busy(BUSY)
    spoken = spoken_ms()
    decode = dictation.local_decoder()
    if decode is None:
        raise Unavailable(NO_DECODER)

    measured: Dict[str, Dict[str, Any]] = {}
    with _probing:
        keep = {**here(path), **(keep or {})}
        models = [name for name in models if name not in keep]
        if not models:
            return None
        for name in models:
            if dictation.holds_a_take():
                raise Busy(BUSY)
            try:
                load_ms = _timed(decode, FIXTURE, name)
                decode_ms = _timed(decode, FIXTURE, name)
            except Exception as unanswered:
                logger.warning("memento: couldn't time %s on this host: %s", name, unanswered)
                continue
            measured[name] = {
                "realtime": round(spoken / max(1, decode_ms), 2),
                "decode_ms": decode_ms,
                "load_ms": load_ms,
                "at": stamp(),
            }

    if not measured:
        if keep:
            return None
        raise Unavailable(NOTHING_LOADED)
    record = {
        "object": OBJECT,
        "at": stamp(),
        "host": machine(),
        "fixture": {"bytes": FIXTURE.stat().st_size, "sha256": digest(), "ms": spoken},
        "models": {**dict(keep or {}), **measured},
    }
    put_setting(path, KEY, record)
    return record


def models_present(present: Sequence[str], in_play: str) -> List[str]:
    """The models a probe should hear, in the order it hears them: on-disk ones, then the one in play.

    Nothing off the disk is heard, so a probe never downloads a model to answer a question about
    speed. The model in play goes last because Hermes holds one model loaded at a time: measured
    last, it is the one left in memory, so the next take doesn't pay for a reload the probe caused.
    """
    order = [name for name in present if name != in_play]
    if in_play in present:
        order.append(in_play)
    return order
