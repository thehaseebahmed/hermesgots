"""The record a run is read against: the "before" run's stable half, committed beside the prompts.

A baseline holds what the same prompts and the same model must keep answering: which assertions the
published page passed, the warnings it was written with, and the turns the prompt took. It holds no
timing, because a millisecond belongs to the machine that measured it — the run's own record
carries those, beside the machine, the model and the path — and no screenshots, which are kept on
disk for a person to read.

Two runs are read against each other only where they agree on what decides the answer: the prompt
set's own digest, the model that was asked, the machine's shape, the harness artifact the page was
drawn in, and whether a browser was there to draw it. A run that disagrees on one is refused as
incomparable rather than read as a change.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List

OBJECT = "gots.bench.canvas.baseline"

# What must agree before two records can be read against each other. Every one of them decides what
# the page was drawn in, what answered the prompt, or which prompts were asked, so two runs that
# disagree on one are not comparable however alike their grades look.
IDENTITY = (
    "prompts",
    "provider",
    "model",
    "machine",
    "harness",
    "browser",
    "plugin",
)

NOTE = (
    "What the same prompts and the same model must keep answering, taken on the single-session "
    "path before builds. No timing lives here: a millisecond belongs to the machine that measured "
    "it, and the run's own record carries those beside the machine, the model and the path. The "
    "screenshots are kept on disk for a person and never in this file."
)


def _identity_fields(record: Dict[str, Any]) -> Dict[str, Any]:
    """What two records must agree on, read off a run or off a baseline of one."""
    machine = dict(record.get("machine") or {})
    # The machine's name is its own business: it changes with every container, and what decides
    # whether two pages draw the same is the machine's shape, not what it is called.
    for ephemeral in ("name", "python", "path"):
        machine.pop(ephemeral, None)
    prompts = record.get("prompts") or {}
    return {
        "prompts": {"sha256": prompts.get("sha256")},
        "provider": (record.get("model") or {}).get("provider"),
        "model": (record.get("model") or {}).get("model"),
        "machine": machine,
        "harness": {"sha256": (record.get("harness") or {}).get("sha256")},
        "browser": record.get("browser"),
        # The plugin that answered: its store's warnings are part of what a page is told.
        "plugin": {"version": (record.get("plugin") or {}).get("version")},
    }


def _stable(entry: Dict[str, Any]) -> Dict[str, Any]:
    """One prompt's grade as a baseline keeps it: what passed, what it was warned, what it cost."""
    return {
        "name": entry.get("name"),
        "kind": entry.get("kind"),
        "assertions": [
            {"name": one.get("name"), "ok": bool(one.get("ok"))}
            for one in entry.get("assertions") or ()
        ],
        "passed": entry.get("passed"),
        "of": entry.get("of"),
        "warnings": list(entry.get("warnings") or ()),
        "turns": entry.get("turns"),
        # Why a grade that couldn't run didn't: a page nobody could draw is a fact about the host,
        # and a baseline taken beside a browser keeps saying so.
        "reason": entry.get("reason"),
    }


def shape(record: Dict[str, Any]) -> Dict[str, Any]:
    """The record as a baseline file holds it."""
    identity = _identity_fields(record)
    return {
        "object": OBJECT,
        "note": NOTE,
        "prompts": record.get("prompts") or identity["prompts"],
        "model": record.get("model") or {},
        "machine": {key: value for key, value in (record.get("machine") or {}).items()},
        "harness": record.get("harness") or {},
        "browser": record.get("browser"),
        "plugin": record.get("plugin") or {},
        "entries": [_stable(entry) for entry in record.get("entries") or ()],
    }


def incomparable(baseline: Dict[str, Any], record: Dict[str, Any]) -> List[str]:
    """Why this run can't be read against ``baseline``, field by field; empty when it can."""
    was, now = _identity_fields(baseline), _identity_fields(record)
    return [
        f"{key}: the baseline was taken with {was[key]!r}, this run with {now[key]!r}"
        for key in IDENTITY
        if was[key] != now[key]
    ]


def differences(baseline: Dict[str, Any], record: Dict[str, Any]) -> List[str]:
    """Every field where this run disagrees with ``baseline``, as lines a reviewer can read."""
    was = {entry.get("name"): entry for entry in baseline.get("entries") or ()}
    now = {entry.get("name"): entry for entry in record.get("entries") or ()}
    lines: List[str] = []
    for name in sorted(set(was) | set(now)):
        if name not in was:
            lines.append(f"{name}: not in the baseline")
            continue
        if name not in now:
            if not record.get("subset"):
                lines.append(f"{name}: in the baseline but this run didn't ask it")
            continue
        before, after = was[name], _stable(now[name])
        if before.get("kind") != after.get("kind"):
            lines.append(f"{name}: kind was {before.get('kind')!r}, now {after.get('kind')!r}")
        if before.get("reason") != after.get("reason"):
            lines.append(
                f"{name}: the reason was {before.get('reason')!r}, now {after.get('reason')!r}"
            )
        _assertion_diff(name, before, after, lines)
        _warnings_diff(name, before, after, lines)
        if before.get("turns") != after.get("turns"):
            lines.append(f"{name}: turns was {before.get('turns')!r}, now {after.get('turns')!r}")
    return lines


def _assertion_diff(
    name: str, before: Dict[str, Any], after: Dict[str, Any], lines: List[str]
) -> None:
    """Which of a prompt's assertions changed their answer, named one by one."""
    was = {one.get("name"): one for one in before.get("assertions") or ()}
    now = {one.get("name"): one for one in after.get("assertions") or ()}
    for one in sorted(set(was) | set(now)):
        if one not in was:
            lines.append(f"{name}: {one}: not in the baseline")
        elif one not in now:
            lines.append(f"{name}: {one}: in the baseline but this run didn't answer it")
        elif bool(was[one].get("ok")) != bool(now[one].get("ok")):
            said = "passed" if now[one].get("ok") else f"failed ({now[one].get('error')})"
            lines.append(f"{name}: {one}: was {bool(was[one].get('ok'))}, now {said}")


def _warnings_diff(
    name: str, before: Dict[str, Any], after: Dict[str, Any], lines: List[str]
) -> None:
    """The warnings a page was written with: the ones that arrived, and the ones that left."""
    was = list(before.get("warnings") or ())
    now = list(after.get("warnings") or ())
    if was == now:
        return
    for one in now:
        if one not in was:
            lines.append(f"{name}: a new warning: {one}")
    for one in was:
        if one not in now:
            lines.append(f"{name}: a warning gone: {one}")


def load(path: Any) -> Dict[str, Any]:
    return json.loads(Path(path).read_text())


def write(path: Any, record: Dict[str, Any]) -> None:
    Path(path).write_text(json.dumps(shape(record), indent=2) + "\n")
