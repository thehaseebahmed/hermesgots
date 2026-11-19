"""A published page, graded: the step 3 runner's assertions and the store's own warnings.

The runner (``plugin/canvas_checks.py``, ADR 0171) draws the page the way the app draws it — the
harness page checked into ``plugin/canvas/`` — runs the assertions in it against a read-only
snapshot of the canvas's data, and answers pass or fail per test, the console's errors and the four
screenshots. The warnings are the store's own (``canvases.warnings``): what a page is told the
moment it is written, read here off the published document so the record says what the host was
told as well as what the page answered.

Both are the plugin's own code, called in process the way the dictation bench calls the plugin's
take functions. The browser's own side — a Chromium drawing the harness page — is the one thing a
host without a browser layer can't do, and a check that can't run answers its reason rather than
raising: the record carries it, and a page nobody could draw is never a page that passed.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

from plugin import canvas_checks
from plugin.canvases import warnings as page_warnings

from .prompts import Assertion, Prompt


@dataclass
class Graded:
    """One prompt's page as the bench read it: the assertions, the console, the shots, the reason."""

    assertions: List[Dict[str, Any]] = field(default_factory=list)
    console: List[str] = field(default_factory=list)
    shots: List[str] = field(default_factory=list)
    reason: Optional[str] = None
    warnings: List[str] = field(default_factory=list)

    @property
    def ran(self) -> bool:
        return self.reason is None

    @property
    def passed(self) -> int:
        return sum(1 for one in self.assertions if one.get("ok"))

    @property
    def of(self) -> int:
        return len(self.assertions)


def grade(
    prompt: Prompt,
    html: str,
    data: Dict[str, Any],
    folder: Path,
) -> Graded:
    """The published page against the prompt's own assertions, with the warnings it was written with.

    ``html`` is the published document, ``data`` the read-only snapshot of the canvas's data the
    check is answered from, and ``folder`` where the four screenshots are kept for a person. A
    host with no browser layer answers the reason and takes no screenshots: the record carries it,
    and a page nobody could draw is never a page that passed.
    """
    said = page_warnings(html)
    tests: Sequence[Dict[str, str]] = [
        {"name": one.name, "script": one.script} for one in prompt.assertions
    ]
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    report = canvas_checks.check(html, data, list(tests), folder)
    return Graded(
        assertions=[
            {"name": one.get("name"), "ok": bool(one.get("ok")), "error": one.get("error")}
            for one in report.tests
        ],
        console=list(report.console),
        shots=[shot.path for shot in report.shots],
        reason=report.reason,
        warnings=list(said),
    )


def carried(assertions: Sequence[Assertion], graded: Graded) -> List[Dict[str, Any]]:
    """Every assertion the prompt holds, answered — a check that couldn't run answers none of them.

    A report that ran answers one row per test the page was asked; a prompt whose assertion the
    page never saw (a check that stopped early) is answered as unanswered rather than dropped, so
    the record's counts are of the prompt's own assertions and not of the ones that happened to
    come back.
    """
    answered = {one.get("name"): one for one in graded.assertions}
    rows: List[Dict[str, Any]] = []
    for one in assertions:
        found = answered.get(one.name)
        if found is None:
            rows.append({"name": one.name, "ok": False, "error": "the check never answered it"})
        else:
            rows.append(found)
    return rows
