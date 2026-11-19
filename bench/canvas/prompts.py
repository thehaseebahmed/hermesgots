"""The fixed prompts, each with its own fixed assertions.

Four prompts, chosen by what a canvas build has to get right rather than by count: two first builds
(a page from nothing) and two follow-up tweaks (a change to a page the first build left). Each
prompt's assertions are the bench's own: scripts the step 3 runner runs in the harness page, in the
page's own context, that pass by finishing and fail with the words they throw. They ask for what the
prompt asked for — the parts it named, the chart it wanted, the data bridge every canvas page reads
through — so a build that answered the request passes them and one that didn't is graded as not
having.

A prompt's text and its assertions are the fixture: changing either moves the set's digest, and a
run on another set is refused as incomparable with the baseline rather than read as a regression.

The runner's own tests are ``python3 -m unittest plugin.tests.test_canvas_checks -v``; this module
is the bench's fixture set, and its rules are checked by ``python3 -m bench.canvas --self-check``.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence, Tuple


@dataclass(frozen=True)
class Assertion:
    """One fixed check of a published page: a name, and the script the runner runs for it."""

    name: str
    script: str


@dataclass(frozen=True)
class Prompt:
    """One fixed request: what is asked, and what the page it publishes must answer."""

    name: str
    kind: str  # "first" — a canvas from nothing; "tweak" — a change to the prompt it follows
    text: str
    on: Optional[str]  # the prompt whose canvas this one changes; None for a first build
    assertions: Tuple[Assertion, ...]


# The page's own context the assertions run in: the harness draws the document in an iframe under
# the app's own sandbox and appends these scripts to it, so ``document`` is the page's and
# ``window.canvas.data`` is the bridge the app answers a page's reads through — here, from the
# read-only snapshot the check was handed.

_NAMES = """var words = (document.body.textContent || '').toLowerCase();
var named = function (want) { return words.indexOf(want) !== -1 };
if (!(['yesterday', 'today', 'blockers']).every(named)) {
  throw new Error('the page names no ' + ['yesterday', 'today', 'blockers'].filter(function (w) {
    return !named(w);
  }).join(', '));
}"""

_BRIDGE = """return window.canvas.data.list('standups').then(function (rows) {
  if (!Array.isArray(rows)) { throw new Error('the data bridge answered no list'); }
});"""

_ADDS = """var control = document.querySelector('button, input, form');
if (!control) { throw new Error('the page has no way to add a standup'); }"""

_FILTER = """var control = document.querySelector('input, select');
if (!control) { throw new Error('the page has no filter control'); }"""

_ABOVE = """var control = document.querySelector('input, select');
var list = document.querySelector('ul, ol, table, [class*="list"]');
if (!control || !list) { throw new Error('the page has no filter above a list'); }
if (!(control.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING)) {
  throw new Error('the filter does not stand above the list');
}"""

_CHART = """var chart = document.querySelector('canvas');
if (!chart) { throw new Error('the page draws no chart'); }
if (!chart.width) { throw new Error('the chart canvas has no width, so it never drew'); }"""

_STATS = """var words = (document.body.textContent || '').toLowerCase();
var named = function (want) { return words.indexOf(want) !== -1 };
if (!(['pages', 'minutes', 'streak']).every(named)) {
  throw new Error('the page names no ' + ['pages', 'minutes', 'streak'].filter(function (w) {
    return !named(w);
  }).join(', '));
}"""

# The reading log's own collection: the dashboard's page reads it, so its assertion names it.
_BRIDGE_READING = """return window.canvas.data.list('sessions').then(function (rows) {
  if (!Array.isArray(rows)) { throw new Error('the data bridge answered no list'); }
});"""

PROMPTS: Tuple[Prompt, ...] = (
    Prompt(
        name="standup",
        kind="first",
        text=(
            "Build a standup tracker for my team: three columns — yesterday, today and "
            "blockers — one card per teammate, and a way to add a standup at the foot."
        ),
        on=None,
        assertions=(
            Assertion("the page names the three standup parts", _NAMES),
            Assertion("the page's data bridge answers a read", _BRIDGE),
            Assertion("the page has a way to add a standup", _ADDS),
        ),
    ),
    Prompt(
        name="standup-filter",
        kind="tweak",
        text="Add a filter row above the list so I can show one teammate at a time.",
        on="standup",
        assertions=(
            Assertion("a filter control stands on the page", _FILTER),
            Assertion("the filter stands above the list", _ABOVE),
            Assertion("the page still reads its data", _BRIDGE),
        ),
    ),
    Prompt(
        name="dashboard",
        kind="first",
        text=(
            "A reading dashboard for me: three stat cards — pages this week, minutes today and "
            "current streak — over a bar chart of the last seven days' minutes, all reading my "
            "reading-log data."
        ),
        on=None,
        assertions=(
            Assertion("the page draws a chart", _CHART),
            Assertion("the page names the three stats", _STATS),
            Assertion("the page's data bridge answers a read", _BRIDGE_READING),
        ),
    ),
    Prompt(
        name="dashboard-streak",
        kind="tweak",
        text="Highlight today's bar in the chart and put the streak card first.",
        on="dashboard",
        assertions=(
            Assertion("the chart is still drawn", _CHART),
            Assertion("the page still names its stats", _STATS),
            Assertion("the page's data bridge answers a read", _BRIDGE_READING),
        ),
    ),
)

BY_NAME: Dict[str, Prompt] = {prompt.name: prompt for prompt in PROMPTS}


def load(only: Optional[Sequence[str]] = None) -> Tuple[Prompt, ...]:
    """The prompts this run asks for, in the set's own order; a subset says which it left out."""
    if not only:
        return PROMPTS
    named = set(only)
    unknown = sorted(named - set(BY_NAME))
    if unknown:
        raise ValueError(
            f"no prompt{'s' if len(unknown) > 1 else ''} named {', '.join(unknown)}: "
            f"the set holds {', '.join(BY_NAME)}"
        )
    return tuple(prompt for prompt in PROMPTS if prompt.name in named)


def stated(prompt: Prompt) -> Dict[str, Any]:
    """One prompt as the record and the digest read it."""
    return {
        "name": prompt.name,
        "kind": prompt.kind,
        "on": prompt.on,
        "text": prompt.text,
        "assertions": [
            {"name": one.name, "script": one.script} for one in prompt.assertions
        ],
    }


def digest(prompts: Sequence[Prompt] = PROMPTS) -> str:
    """The set's own hash: the bytes a run was taken on, as the fixtures' hash is for dictation."""
    canon = json.dumps([stated(prompt) for prompt in prompts], sort_keys=True)
    return hashlib.sha256(canon.encode()).hexdigest()


def _script_problem(prompt: str, name: str, script: str) -> Optional[str]:
    """Why an assertion's script doesn't parse, or None where it does.

    A script is the page's own code, run by the harness's runner as the body of the function it
    wraps it in: one that doesn't parse is answered as unfinished on every host, which would read
    as a page that never finished rather than as the fixture's own typo. The parse is Node's own
    (``node --check``), the toolchain the repository already holds; a host with no Node says it
    couldn't read the scripts rather than pretending it did.
    """
    node = shutil.which("node")
    if node is None:
        return None
    with tempfile.NamedTemporaryFile(
        "w", suffix=".js", delete=False, encoding="utf-8"
    ) as handle:
        handle.write(f"(function(){{\n{script}\n}})")
        path = handle.name
    try:
        said = subprocess.run(
            [node, "--check", path], capture_output=True, text=True, timeout=30
        )
    except (OSError, subprocess.SubprocessError):
        return None
    finally:
        os.unlink(path)
    if said.returncode == 0:
        return None
    words = (said.stderr or said.stdout or "").strip().splitlines()
    return f"{prompt}: {name} does not parse: {words[0] if words else 'node refused it'}"


def problems(prompts: Sequence[Prompt]) -> List[str]:
    """The set as the bench's rules describe it, and every assertion as a script that parses."""
    found: List[str] = []
    if not prompts:
        found.append("the prompt set is empty")
    seen = set()
    for prompt in prompts:
        if prompt.name in seen:
            found.append(f"{prompt.name}: named twice")
        seen.add(prompt.name)
        if prompt.kind not in ("first", "tweak"):
            found.append(f"{prompt.name}: kind {prompt.kind!r} is neither first nor tweak")
        if prompt.kind == "tweak":
            if prompt.on is None:
                found.append(f"{prompt.name}: a tweak names no prompt it follows")
            elif prompt.on not in BY_NAME:
                found.append(f"{prompt.name}: follows {prompt.on!r}, which the set does not hold")
        elif prompt.on is not None:
            found.append(f"{prompt.name}: a first build follows nothing, and this one names {prompt.on!r}")
        if not prompt.assertions:
            found.append(f"{prompt.name}: holds no assertions")
        names = set()
        for one in prompt.assertions:
            if one.name in names:
                found.append(f"{prompt.name}: two assertions named {one.name!r}")
            names.add(one.name)
            if not one.script.strip():
                found.append(f"{prompt.name}: {one.name} is an empty script")
            wrong = _script_problem(prompt.name, one.name, one.script)
            if wrong:
                found.append(wrong)
    # A tweak runs on the canvas its own prompt left, so the one it follows has to be in the set —
    # a run of a tweak alone has no canvas to change.
    for prompt in prompts:
        if prompt.kind == "tweak" and prompt.on and prompt.on not in {
            one.name for one in prompts
        }:
            found.append(
                f"{prompt.name}: follows {prompt.on!r}, which this run does not ask for"
            )
    return found
