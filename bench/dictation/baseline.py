"""The record a run is read against, committed beside the fixtures (ADR 0075).

A baseline holds what the same bytes and the same model must keep saying: how the take was cut, how
long it took to say, the words that landed, how far they are from the reference and whether the
Vocabulary came back as spelled. It holds no timing, because a millisecond belongs to the machine
that measured it — the run's own record carries those, and the two records name the machine, the
model, the level and the cut policy so two runs can be compared or refused as incomparable.
"""

from __future__ import annotations

import difflib
import json
from typing import Any, Dict, List, Sequence

from .words import words_of

OBJECT = "memento.bench.dictation.baseline"

# What must agree before two records can be read against each other, and what a run names. Every one
# of them decides what words the decoder is given or how its audio is cut, so two runs that disagree
# on one are not comparable however alike their numbers look.
IDENTITY = (
    "decoder",
    "host",
    "level",
    "cut",
    "hearing",
    "vocabulary",
    "hallucinations",
    "fixtures",
)


def _identity_fields(record: Dict[str, Any]) -> Dict[str, Any]:
    """What two records must agree on, read off a run or off a baseline of one."""
    decoder = dict(record.get("decoder") or {})
    decoder.pop("warm_ms", None)
    machine = dict(record.get("host") or {})
    # The machine's name is its own business: it changes with every container, and what decides
    # whether two decodes agree is the machine's shape, not what it is called.
    for ephemeral in ("name", "python"):
        machine.pop(ephemeral, None)
    return {
        "decoder": decoder,
        "host": machine,
        "level": record.get("level"),
        "cut": record.get("cut"),
        "hearing": record.get("hearing"),
        "vocabulary": record.get("vocabulary"),
        "hallucinations": record.get("hallucinations"),
        "fixtures": {"sha256": (record.get("fixtures") or {}).get("sha256")},
    }


def _stable(take: Dict[str, Any]) -> Dict[str, Any]:
    """One take as a baseline keeps it: no timing, and nothing a machine decided."""
    lengths = take.get("pieces_ms")
    if lengths is None:
        lengths = [piece.get("ms") for piece in take.get("pieces") or ()]
    return {
        "fixture": take.get("fixture"),
        "path": take.get("path"),
        "spoken_ms": take.get("spoken_ms"),
        "pieces_ms": list(lengths),
        "heard": take.get("heard"),
        "reference": take.get("reference"),
        "wer": take.get("wer"),
        "vocabulary": take.get("vocabulary"),
    }


def shape(record: Dict[str, Any]) -> Dict[str, Any]:
    """The record as a baseline file holds it."""
    identity = _identity_fields(record)
    return {
        "object": OBJECT,
        "note": (
            "What the same fixture bytes and the same model must keep saying. No timing lives here: "
            "a millisecond belongs to the machine that measured it, and the run's own record "
            "carries those beside the machine, the model, the level and the cut policy."
        ),
        # The whole digest, so a reader of the baseline sees which bytes it was taken on.
        "fixtures": record.get("fixtures") or identity["fixtures"],
        **{key: value for key, value in identity.items() if key != "fixtures"},
        "takes": [_stable(take) for take in record.get("takes") or ()],
    }


def incomparable(baseline: Dict[str, Any], record: Dict[str, Any]) -> List[str]:
    """Why this run can't be read against ``baseline``, field by field; empty when it can."""
    was, now = _identity_fields(baseline), _identity_fields(record)
    return [
        f"{key}: the baseline was taken with {was[key]!r}, this run with {now[key]!r}"
        for key in IDENTITY
        if was[key] != now[key]
    ]


def _word_diff(was: Sequence[str], now: Sequence[str]) -> List[str]:
    lines = []
    for entry in difflib.ndiff(list(was), list(now)):
        if entry.startswith("- "):
            lines.append(f"    - {entry[2:]}")
        elif entry.startswith("+ "):
            lines.append(f"    + {entry[2:]}")
    return lines or ["    (the words match, so the difference is punctuation or spacing)"]


def differences(baseline: Dict[str, Any], record: Dict[str, Any]) -> List[str]:
    """Every field where this run disagrees with ``baseline``, as lines a reviewer can read."""
    was = {take["fixture"]: take for take in baseline.get("takes") or ()}
    now = {take["fixture"]: take for take in record.get("takes") or ()}
    lines: List[str] = []
    for name in sorted(set(was) | set(now)):
        if name not in was:
            lines.append(f"{name}: not in the baseline")
            continue
        if name not in now:
            # A run of some of the fixtures says nothing about the ones it didn't hear.
            if not record.get("subset"):
                lines.append(f"{name}: in the baseline but this run didn't hear it")
            continue
        before, after = was[name], _stable(now[name])
        moved = before.get("heard") != after.get("heard")
        # The distance and the Vocabulary are read off the words, so a word that moved is reported
        # once — as the diff a reviewer reads — and not again as two figures it also shifted.
        for field in ("path", "spoken_ms", "pieces_ms", "reference"):
            if before.get(field) != after.get(field):
                lines.append(
                    f"{name}: {field} was {before.get(field)!r}, now {after.get(field)!r}"
                )
        if moved:
            lines.append(f"{name}: the words moved")
            lines += _word_diff(words_of(before.get("heard") or ""), words_of(after.get("heard") or ""))
        elif before.get("wer") != after.get("wer") or before.get("vocabulary") != after.get(
            "vocabulary"
        ):
            lines.append(f"{name}: the words are the same and a figure read off them is not")
    return lines


def load(path: Any) -> Dict[str, Any]:
    return json.loads(path.read_text())


def write(path: Any, record: Dict[str, Any]) -> None:
    path.write_text(json.dumps(shape(record), indent=2) + "\n")
