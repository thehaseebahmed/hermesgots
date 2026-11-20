"""One command that grades the canvas prompts on a real host and prints what they cost.

    python3 -m bench.canvas --dry            # a record from the canned page, no host anywhere near it
    python3 -m bench.canvas --self-check     # the bench's own rules and its host client, on a stub
    python3 -m bench.canvas --base URL --key KEY            # the prompts on a real host
    python3 -m bench.canvas --base URL --key KEY --write-baseline   # take the baseline

A run sends the fixed prompts the way the app sends a request — the first build queued on a fresh
canvas's session, the follow-up posted to that session — waits for the record to go still, grades
the published page with the step 3 runner, and prints the record beside the machine, the model and
the path. It is then read against the baseline: agreed, moved, or refused as incomparable. No CI
gate reads it (G11): a run costs model calls, and a grade is a report and never a pass.

The bench runs where the host's browser layer is in reach, the way the plugin reaches it — on the
Hermes host itself. ``--dry`` needs no host at all: it prints a record from the canned page, which
is the check the plan gives this step.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import socket
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

from . import BASELINE
from . import baseline as baseline_module
from . import drive, grade, prompts as prompts_module
from .prompts import Prompt

# What a run answers: it was read against the baseline and agreed, a grade moved, or the run can't
# be read against that baseline at all — a host that couldn't be reached, or a baseline that was
# taken on other terms.
OK, MOVED, INCOMPARABLE = 0, 1, 2

FIXTURES = Path(__file__).resolve().parent / "fixtures"
CANNED_PAGE = FIXTURES / "canned-page.html"
CANNED = FIXTURES / "canned.json"


def parser() -> argparse.ArgumentParser:
    command = argparse.ArgumentParser(
        prog="python3 -m bench.canvas",
        description=(
            "Grade the fixed canvas prompts on a real host — the published page checked the way "
            "the app draws it — and print what each prompt cost: the assertions that passed, the "
            "warnings the page was written with, the turns it took and the wall time, beside the "
            "machine, the model and the path."
        ),
    )
    command.add_argument(
        "--base",
        help="the bot's base URL, the shape the app holds (its trailing /v1 is dropped)",
    )
    command.add_argument("--key", default="", help="the bot's key, sent as its bearer token")
    command.add_argument(
        "--provider", help="the provider the run body names; the host's own where none"
    )
    command.add_argument(
        "--model", help="the model the run body names; the host's own where none"
    )
    command.add_argument("--profile", help="the bot's profile id, where a host serves more than one")
    command.add_argument(
        "--prompt",
        action="append",
        default=[],
        metavar="NAME",
        help="ask only this prompt (repeatable); a tweak's own first build comes with it",
    )
    command.add_argument(
        "--shots",
        type=Path,
        default=None,
        help="where the four screenshots per prompt are kept for a person "
        "(default: canvas-bench-shots/<when>, under the working directory)",
    )
    command.add_argument(
        "--poll-ms", type=int, default=drive.Settings.poll_ms, help="how often a waiting run reads the record"
    )
    command.add_argument(
        "--quiet-ms",
        type=int,
        default=drive.Settings.quiet_ms,
        help="how still the record has to be before a run reads as ended",
    )
    command.add_argument(
        "--max-wait",
        type=int,
        default=drive.Settings.max_wait_s,
        help="how long one prompt is given, in seconds, before it reads as unfinished",
    )
    command.add_argument("--out", type=Path, help="write the run's whole record here, as JSON")
    command.add_argument(
        "--baseline",
        type=Path,
        default=None,
        help="the baseline to read this run against (default: the one committed beside the prompts)",
    )
    command.add_argument(
        "--write-baseline", action="store_true", help="rewrite that baseline from this run"
    )
    command.add_argument("--no-check", action="store_true", help="record and print, without reading the baseline")
    command.add_argument("--json", action="store_true", help="print the record itself, as JSON")
    command.add_argument(
        "--dry",
        action="store_true",
        help="print a record from the canned page: no host, no browser, no model call",
    )
    command.add_argument(
        "--self-check",
        action="store_true",
        help="check the bench's own rules, its fixtures and its host client, on a stub",
    )
    return command


def machine() -> Dict[str, Any]:
    """The machine a run was taken on: its shape, its name and the Python that ran the bench."""
    return {
        "name": socket.gethostname(),
        "system": platform.system(),
        "machine": platform.machine(),
        "cpus": os.cpu_count(),
        "python": platform.python_version(),
    }


def harness() -> Dict[str, Any]:
    """The harness artifact a page is drawn in: its own hash, read off the checked-in file.

    The frame a draft is checked in is the app's own frame code bundled by the build script; a page
    drawn in another harness is a page drawn in another frame, so its hash is part of what two runs
    must agree on.
    """
    import hashlib

    from plugin import canvas_checks

    page = canvas_checks.HARNESS
    if not page.is_file():
        return {"sha256": None, "bytes": 0}
    said = page.read_bytes()
    return {"sha256": hashlib.sha256(said).hexdigest(), "bytes": len(said)}


def browser() -> str:
    """Whether this host can draw a page at all: ready, or the plugin's own reason it can't."""
    from plugin import canvas_checks

    return canvas_checks.available() or "ready"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _entry(
    prompt: Prompt,
    graded: grade.Graded,
    turns: int,
    wall_ms: int,
    version: Any,
    shots: List[str],
    unfinished: bool,
    dry: bool,
) -> Dict[str, Any]:
    assertions = grade.carried(prompt.assertions, graded) if not dry else list(graded.assertions)
    return {
        "name": prompt.name,
        "kind": prompt.kind,
        "assertions": assertions,
        "passed": sum(1 for one in assertions if one.get("ok")),
        "of": len(assertions),
        "warnings": list(graded.warnings),
        "console": list(graded.console),
        "turns": turns,
        "wall_ms": wall_ms,
        "version": version,
        "shots": list(shots),
        "reason": graded.reason,
        "unfinished": unfinished,
        "dry": dry,
    }


def _record(
    args: argparse.Namespace,
    entries: List[Dict[str, Any]],
    asked: Sequence[Prompt],
    *,
    dry: bool,
    plugin: Optional[Dict[str, Any]],
    path: Optional[str],
) -> Dict[str, Any]:
    return {
        "object": "gots.bench.canvas.record",
        "at": _now(),
        "dry": dry,
        "subset": len(asked) < len(prompts_module.PROMPTS),
        "machine": machine(),
        "model": {"provider": args.provider, "model": args.model},
        "path": path,
        "plugin": plugin,
        "prompts": {"count": len(prompts_module.PROMPTS), "sha256": prompts_module.digest()},
        "harness": harness(),
        "browser": browser(),
        "entries": entries,
        "totals": {
            "prompts": len(entries),
            "passed": sum(one.get("passed", 0) for one in entries),
            "of": sum(one.get("of", 0) for one in entries),
            "turns": sum(one.get("turns", 0) for one in entries),
            "wall_ms": sum(one.get("wall_ms", 0) for one in entries),
        },
    }


def dry_record(args: argparse.Namespace) -> Dict[str, Any]:
    """A record from the canned page: the fixture's own grade, on the machine it prints from.

    What is measured here is measured for real — the machine, the harness the page would be drawn
    in, whether this host can draw at all, and the warnings the page was written with, read by the
    store's own rule. The grade, the turns and the wall time are the fixture's own, and the record
    says so on its face: a dry run reaches no host, so nothing it prints about a page was answered
    by one.
    """
    said = json.loads(CANNED.read_text())
    prompt = prompts_module.BY_NAME[said["prompt"]]
    page = CANNED_PAGE.read_text()
    from plugin.canvases import warnings as page_warnings

    graded = grade.Graded(
        assertions=list(said["grading"]["assertions"]),
        console=list(said["grading"].get("console") or ()),
        reason=said["grading"].get("reason"),
        warnings=list(page_warnings(page)),
    )
    entry = _entry(
        prompt, graded, said["turns"], said["wall_ms"], said.get("version"), [], False, True
    )
    return _record(args, [entry], (prompt,), dry=True, plugin=None, path=args.base)


def run_prompts(
    host: drive.Host, asked: Sequence[Prompt], shots_root: Path
) -> Tuple[List[Dict[str, Any]], List[str]]:
    """The prompts on the host, one at a time, and the canvases the run made.

    A first build is queued on a canvas of its own; a tweak is posted to the session of the canvas
    its own prompt left in this run. Each prompt's page is the one the record points at when it
    goes still, graded with the runner against a read-only snapshot of the canvas's data. Every
    canvas the run made is taken back at the end: a bench leaves nothing on the host it graded.
    """
    entries: List[Dict[str, Any]] = []
    made: List[str] = []
    canvases: Dict[str, Dict[str, Any]] = {}
    try:
        for prompt in asked:
            started = time.monotonic()
            if prompt.kind == "first":
                canvas = host.start(prompt.text)
                canvases[prompt.name] = canvas
                made.append(canvas["id"])
            else:
                canvas = canvases[prompt.on]
                host.turn(canvas["session_id"], prompt.text)
            canvas_id = canvas["id"]
            before = canvas.get("version") or 0
            settled, ended = host.wait(
                canvas_id, since=before if host.builds() else None
            )
            wall_ms = int((time.monotonic() - started) * 1000)
            data = host.sweep(canvas_id)
            folder = shots_root / prompt.name
            graded = grade.grade(prompt, settled.get("html") or "", data, folder)
            entries.append(
                _entry(
                    prompt,
                    graded,
                    1,
                    wall_ms,
                    settled.get("version"),
                    graded.shots,
                    not ended,
                    False,
                )
            )
            print(f"  {prompt.name}: graded, {graded.passed} of {graded.of} assertions passed")
    finally:
        for canvas_id in made:
            try:
                host.delete(canvas_id)
            except drive.HostError as error:
                print(f"  couldn't take back {canvas_id}: {error}")
    return entries, made


def _dur(ms: Optional[int]) -> str:
    return "-" if ms is None else f"{ms / 1000:.1f}s"


def _check_of(entry: Dict[str, Any]) -> str:
    if entry.get("dry"):
        return "canned"
    if entry.get("reason"):
        return "unchecked"
    return "passing" if entry.get("passed") == entry.get("of") else "failing"


def table(record: Dict[str, Any], baseline: Optional[Dict[str, Any]] = None) -> List[str]:
    """The run, as a reader reads it: one line per prompt, then its totals and its verdict.

    Where a baseline is in hand, each prompt's line carries the baseline's own count and the delta
    between them — the "before" and "after" columns the plan's step 14 asks for — so a run is read
    prompt by prompt rather than only in its totals.
    """
    asked = len(record["entries"])
    of_set = (
        f"{asked} of {record['prompts']['count']} prompts"
        if record["subset"]
        else f"{record['prompts']['count']} prompts"
    )
    pick = record["model"]
    named = " / ".join(part for part in (pick.get("provider"), pick.get("model")) if part)
    browser_said = (
        "browser ready"
        if record["browser"] == "ready"
        else f"no browser: {record['browser']}"
    )
    before = {
        entry.get("name"): entry for entry in (baseline or {}).get("entries") or ()
    }
    columns = f"{'prompt':<18} {'kind':<6} {'passed':>7}"
    if baseline is not None:
        columns += f" {'before':>7} {'delta':>5}"
    columns += f" {'turns':>6} {'wall':>7} {'warn':>5} {'version':>8}  check"
    lines = [
        "Canvas bench — "
        + (f"{of_set}, dry run" if record["dry"] else of_set)
        + (f", model {named}" if named else ", the host's own model"),
        f"harness sha256 {(record['harness'].get('sha256') or 'none')[:16]}… "
        f"({record['harness'].get('bytes')} bytes) · {browser_said}"
        + (
            f" · plugin {(record['plugin'] or {}).get('version')}"
            if record.get("plugin")
            else ""
        ),
        f"host {record['machine']['name']} {record['machine']['machine']}, "
        f"{record['machine']['cpus']} cpus, python {record['machine']['python']}"
        + (f" · path {record['path']}" if record.get("path") else " · path none"),
        f"prompts sha256 {record['prompts']['sha256'][:16]}… "
        f"({record['prompts']['count']} prompts)",
        "",
        columns,
    ]
    for entry in record["entries"]:
        line = (
            f"{entry['name']:<18} {entry['kind']:<6} "
            f"{str(entry['passed']) + ' / ' + str(entry['of']):>7}"
        )
        if baseline is not None:
            was = before.get(entry["name"])
            if was is None:
                line += f" {'-':>7} {'-':>5}"
            else:
                said = f"{was.get('passed', 0)} / {was.get('of', 0)}"
                moved = int(entry["passed"]) - int(was.get("passed", 0))
                line += f" {said:>7} {format(moved, '+'):>5}"
        line += (
            f" {entry['turns']:>6} "
            f"{_dur(entry['wall_ms']):>7} {len(entry['warnings']):>5} "
            f"{str(entry.get('version') if entry.get('version') is not None else '-'):>8}  "
            f"{_check_of(entry)}"
        )
        lines.append(line)
        if entry.get("unfinished"):
            lines.append(f"{'':<18} the wait ran out before the record went still")
        for one in entry["assertions"]:
            if not one.get("ok"):
                lines.append(f"{'':<18} {one['name']}: {one.get('error') or 'it failed'}")
        for one in entry["warnings"]:
            lines.append(f"{'':<18} warning: {one}")
        for one in entry["console"]:
            lines.append(f"{'':<18} console: {one}")
        if entry.get("shots"):
            lines.append(f"{'':<18} screenshots: {Path(entry['shots'][0]).parent}")
    totals = record["totals"]
    total_line = (
        f"{'totals':<18} {'':<6} "
        f"{str(totals['passed']) + ' / ' + str(totals['of']):>7}"
    )
    if baseline is not None:
        was = (baseline.get("totals") or {}).get("passed")
        said = f"{was} / {(baseline.get('totals') or {}).get('of')}" if was is not None else "-"
        moved = int(totals["passed"]) - int(was) if was is not None else None
        total_line += f" {said:>7} {(format(moved, '+') if moved is not None else '-'):>5}"
    total_line += f" {totals['turns']:>6} {_dur(totals['wall_ms']):>7}"
    lines.append(total_line)
    if record["dry"]:
        lines.append(
            "a dry run reaches no host: the grade, the turns and the wall time are the canned "
            "fixture's own, and the machine, the harness and the warnings are measured"
        )
    return lines


def _report(record: Dict[str, Any], baseline: Dict[str, Any], path: Path) -> int:
    """Reads the run against the baseline, and answers the exit code that says what happened."""
    refused = baseline_module.incomparable(baseline, record)
    if refused:
        print("\nincomparable with the baseline:")
        for reason in refused:
            print(f"  - {reason}")
        return INCOMPARABLE
    moved = baseline_module.differences(baseline, record)
    if not moved:
        agreed = len(record["entries"])
        print(f"\nbaseline: clean — {agreed} prompt{'s' if agreed != 1 else ''} agree with {path.name}")
        return OK
    print("\nbaseline: moved")
    for line in moved:
        print(f"  {line}")
    return MOVED


def _canned_problems() -> List[str]:
    """The canned fixture, and the claims it makes about the page it carries."""
    problems: List[str] = []
    if not CANNED_PAGE.is_file():
        problems.append(f"{CANNED_PAGE.name} isn't there")
        return problems
    if not CANNED.is_file():
        problems.append(f"{CANNED.name} isn't there")
        return problems
    said = json.loads(CANNED.read_text())
    if said.get("object") != "gots.bench.canvas.canned":
        problems.append(f"{CANNED.name} isn't a canned fixture")
    prompt = prompts_module.BY_NAME.get(said.get("prompt") or "")
    if prompt is None:
        problems.append(f"{CANNED.name} names {said.get('prompt')!r}, which the set does not hold")
        return problems
    answered = [one.get("name") for one in said.get("grading", {}).get("assertions") or ()]
    if answered != [one.name for one in prompt.assertions]:
        problems.append(
            f"{CANNED.name} answers {answered}, the prompt's own assertions "
            f"{[one.name for one in prompt.assertions]}"
        )
    # The fixture's claim is that the page answers every assertion: the parts it names, the form it
    # holds and the read its script makes. A page's text can be read without drawing it, which is
    # as far as a check with no browser goes — the drawing itself is a real run's to prove.
    page = CANNED_PAGE.read_text().lower()
    for word in ("yesterday", "today", "blockers"):
        if word not in page:
            problems.append(f"{CANNED_PAGE.name} names no {word}, which its first assertion asks for")
    if "<form" not in page and "<button" not in page:
        problems.append(f"{CANNED_PAGE.name} holds no form or button, which its third assertion asks for")
    if "canvas.data.list" not in page:
        problems.append(f"{CANNED_PAGE.name} reads no collection, which its second assertion asks for")
    return problems


def _address_problems() -> List[str]:
    """The client's addresses, on the shapes the app holds a bot's base URL in."""
    problems: List[str] = []
    cases = [
        ("http://hermes:8642", "http://hermes:8642/api/plugins/gots"),
        ("http://hermes:8642/v1", "http://hermes:8642/api/plugins/gots"),
        ("http://hermes:8642/v1/", "http://hermes:8642/api/plugins/gots"),
        ("http://gw:8642/p/ops", "http://gw:8642/api/plugins/gots/p/ops"),
        ("http://gw:8642/p/ops/v1", "http://gw:8642/api/plugins/gots/p/ops"),
    ]
    for base, wanted in cases:
        found = drive.plugin_root(base)
        if found != wanted:
            problems.append(f"plugin_root({base!r}) is {found!r}, not {wanted!r}")
    if drive.multiplexed_profile("http://gw:8642/p/ops/v1") != "ops":
        problems.append("a multiplexed bot's profile isn't read off its base URL")
    return problems


def _baseline_problems() -> List[str]:
    """The reading of a run against a baseline: clean, refused, and moved."""
    problems: List[str] = []
    record = dry_record(argparse.Namespace(provider=None, model=None, base=None))
    if not record["entries"]:
        problems.append("the dry record holds no entries")
        return problems
    # Built from the identity the reader uses, so a field added to it is exercised here too.
    replica = {
        key: record.get(key)
        for key in (
            "prompts",
            "model",
            "machine",
            "harness",
            "browser",
            "plugin",
        )
    }
    replica["entries"] = [dict(entry) for entry in record["entries"]]
    if baseline_module.incomparable(replica, record) or baseline_module.differences(
        replica, record
    ):
        problems.append("the baseline rule: a copy of a record isn't read as clean")
    another = json.loads(json.dumps(replica))
    another["model"] = {"provider": "another", "model": "another"}
    if not baseline_module.incomparable(replica, another):
        problems.append("the baseline rule: another model isn't refused as incomparable")
    moved = json.loads(json.dumps(replica))
    moved["entries"][0]["assertions"][0]["ok"] = not moved["entries"][0]["assertions"][0]["ok"]
    if not baseline_module.differences(replica, moved):
        problems.append("the baseline rule: an assertion that changed its answer isn't reported")
    # The table read against a baseline prints the before column and the delta for each prompt, which
    # is the plan's step 14 read: a grade is printed beside the one it moved from, never instead.
    read = "\n".join(table(record, replica))
    header = read.split("\n\n")[1].splitlines()[0]
    if "before" not in header or "delta" not in header:
        problems.append("the table: a baseline's column isn't headed beside the run's")
    return problems


class _Planted:
    """Hermes's browser layer as a host that has it stands, answering the runner's program.

    The same stand-in the plugin's own tests plant (``plugin/tests/test_canvas_checks.py``): it
    reads the request out of the program the runner generated — which is what proves the document,
    the snapshot and the tests were serialised — answers the first test as passing and the rest as
    the page breaking them, writes the four screenshots the program takes, and keeps the requests
    it was handed so the check can read them back.
    """

    def __init__(self) -> None:
        self.requests: List[Dict[str, Any]] = []
        self.programs = 0

    def __enter__(self) -> "_Planted":
        import re
        from types import ModuleType
        from unittest.mock import patch

        from plugin import canvas_checks

        outer = self

        def browser_exec(code: str, session: str = "", timeout_s: int = 0, **kwargs):
            outer.programs += 1
            found = re.search(r"^REQUEST = (.*)$", code, re.M)
            folder = Path(re.search(r"^FOLDER = (.*)$", code, re.M).group(1).strip("'\""))
            request = json.loads(found.group(1))
            outer.requests.append(request)
            tests = [
                {
                    "name": one["name"],
                    "ok": index == 0,
                    "error": None if index == 0 else "the stub broke it",
                }
                for index, one in enumerate(request["tests"])
            ]
            shots = []
            for width, _height, mode in canvas_checks.DRAWINGS:
                path = folder / f"{width}-{mode}.png"
                path.write_bytes(b"\x89PNG\r\n\x1a\n")
                shots.append({"width": width, "mode": mode, "path": str(path)})
            return json.dumps(
                {
                    "success": True,
                    "exit_code": 0,
                    "output": json.dumps(
                        {"tests": tests, "console": ["error: the stub's page said something"],
                         "shots": shots}
                    ),
                }
            )

        tools = ModuleType("tools")
        cli = ModuleType("tools.browser_use_cli")
        cli.browser_exec = browser_exec
        cli.browser_exec_available = lambda: True
        tools.browser_use_cli = cli
        self._patch = patch.dict(
            sys.modules, {"tools": tools, "tools.browser_use_cli": cli}
        )
        self._patch.start()
        return self

    def __exit__(self, *args: Any) -> None:
        self._patch.stop()


def _drive_problems() -> List[str]:
    """The whole run loop against the stub: the client, the wait, the grading, the clean-up."""
    from . import stub as stub_module

    problems: List[str] = []
    stub = stub_module.Stub()
    server, _thread = stub_module.serve(stub)
    shots = Path(tempfile.mkdtemp(prefix="gots-bench-self-check-"))
    planted = _Planted()
    try:
        host = drive.Host(
            drive.Settings(
                base=f"http://127.0.0.1:{server.server_address[1]}",
                poll_ms=5,
                quiet_ms=20,
                max_wait_s=30,
            )
        )
        with planted:
            info = host.info()
            if "canvas" not in (info.get("features") or []):
                problems.append("the stub advertises no canvas feature, so the run refuses")
            entries, made = run_prompts(host, prompts_module.PROMPTS, shots)
    except drive.HostError as error:
        return [f"the host client raised against the stub: {error}"]
    finally:
        server.shutdown()
        server.server_close()
        shutil.rmtree(shots, ignore_errors=True)

    if len(entries) != len(prompts_module.PROMPTS):
        problems.append(f"the run answered {len(entries)} entries, not the whole set")
        return problems
    for entry in entries:
        prompt = prompts_module.BY_NAME[entry["name"]]
        if entry["of"] != len(prompt.assertions):
            problems.append(f"{entry['name']}: {entry['of']} assertions, the prompt holds {len(prompt.assertions)}")
        if entry["passed"] != 1:
            problems.append(f"{entry['name']}: {entry['passed']} passed, the stub breaks all but the first")
        if entry["turns"] != 1:
            problems.append(f"{entry['name']}: {entry['turns']} turns, one prompt is one run")
        if entry["unfinished"]:
            problems.append(f"{entry['name']}: the wait never settled against the stub")
        if entry["reason"] is not None:
            problems.append(f"{entry['name']}: the check didn't run: {entry['reason']}")
        if len(entry["shots"]) != 4:
            problems.append(f"{entry['name']}: {len(entry['shots'])} screenshots, not the four drawings")
        if not any("the stub broke it" == (one.get("error")) for one in entry["assertions"]):
            problems.append(f"{entry['name']}: no assertion carries the words the stub answered")
        if "error: the stub's page said something" not in entry["console"]:
            problems.append(f"{entry['name']}: the console's own error didn't ride the record")
    # The snapshot the check was handed is the canvas's own documents, swept a page at a time.
    swept = [
        request
        for request in planted.requests
        if "standups" in (request.get("data") or {})
    ]
    if not swept:
        problems.append("no check was handed the canvas's documents as its snapshot")
    elif not swept[0]["data"]["standups"]:
        problems.append("the snapshot's standups collection came back empty from the stub")
    if sorted(stub.deleted) != sorted(made):
        problems.append(f"the run deleted {stub.deleted}, and made {made}")
    if stub.canvases:
        problems.append(f"the stub still holds {sorted(stub.canvases)}")
    return problems


def _self_check() -> int:
    """The bench's own rules, its fixtures and its host client, with no host anywhere near it."""
    problems = (
        prompts_module.problems(prompts_module.PROMPTS)
        + _canned_problems()
        + _address_problems()
        + _baseline_problems()
        + _drive_problems()
    )
    if problems:
        print("self-check failed:")
        for problem in problems:
            print(f"  - {problem}")
        return 1
    print(
        f"self-check passed: {len(prompts_module.PROMPTS)} prompts, "
        f"{sum(len(one.assertions) for one in prompts_module.PROMPTS)} assertions, "
        "the canned fixture's claims hold, and the host client drove the stub's contract"
    )
    if not BASELINE.exists():
        # A run with no baseline is refused, so a missing one cannot read as a clean run — but the
        # baseline is taken on a real host, and this check is not one, so it says so and passes.
        print(
            f"  no {BASELINE.name} is committed: a real run is refused until one is taken with "
            "--write-baseline on a host with a browser"
        )
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    args = parser().parse_args(argv)
    if args.self_check:
        return _self_check()
    if args.dry:
        canned = json.loads(CANNED.read_text())["prompt"]
        if args.prompt and canned not in args.prompt:
            print(
                f"--dry prints the canned page's own record, which is the {canned!r} prompt's: "
                "a run of another prompt is sent to a host"
            )
            return INCOMPARABLE
        record = dry_record(args)
    else:
        if not args.base:
            print("no --base: a real run is sent to a host, and --dry prints from the canned page")
            return INCOMPARABLE
        asked = prompts_module.load(args.prompt)
        wrong = prompts_module.problems(asked)
        if wrong:
            print("the prompt set is wrong:")
            for one in wrong:
                print(f"  - {one}")
            return INCOMPARABLE
        host = drive.Host(
            drive.Settings(
                base=args.base,
                key=args.key,
                provider=args.provider,
                model=args.model,
                profile=args.profile,
                poll_ms=args.poll_ms,
                quiet_ms=args.quiet_ms,
                max_wait_s=args.max_wait,
            )
        )
        try:
            info = host.info()
        except drive.HostError as error:
            print(f"couldn't read the host: {error}")
            return INCOMPARABLE
        features = info.get("features") or []
        if "canvas" not in features:
            print(
                "this host's plugin advertises no canvas feature, so it can't hold the prompts: "
                f"it answered {features}"
            )
            return INCOMPARABLE
        if browser() != "ready":
            print(f"no browser on this host: {browser()} — every page will grade unchecked")
        shots_root = args.shots or Path("canvas-bench-shots") / datetime.now().strftime(
            "%Y-%m-%dT%H-%M-%S"
        )
        print(f"Canvas bench — {len(asked)} prompts on {host.root}")
        entries, _made = run_prompts(host, asked, shots_root)
        record = _record(
            args,
            entries,
            asked,
            dry=False,
            plugin={"version": info.get("version")},
            path=host.root,
        )

    if args.json:
        print(json.dumps(record, indent=2))
    else:
        # The baseline's own column rides the table where there is one to read: each prompt's grade
        # beside the "before" run's, with its delta (the plan's step 14). A run with no baseline —
        # or one taken on other terms — still prints its own column, and the verdict below says why
        # it can't be read.
        baseline_path = args.baseline or BASELINE
        compared: Optional[Dict[str, Any]] = None
        if baseline_path.exists():
            try:
                compared = baseline_module.load(baseline_path)
            except (OSError, ValueError):
                compared = None
        for line in table(record, compared):
            print(line)
        if compared is not None:
            print(f"\nread against {baseline_path.name}: before, after, and the delta")
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(record, indent=2) + "\n")
        print(f"\nrecord written to {args.out}")

    if args.write_baseline:
        if record["dry"]:
            print("a dry run's grade is the canned fixture's own: take the baseline on a real host")
            return INCOMPARABLE
        baseline_module.write(args.baseline or BASELINE, record)
        print(f"baseline written to {args.baseline or BASELINE}")
        return OK
    if args.no_check or record["dry"]:
        return OK
    path = args.baseline or BASELINE
    if not path.exists():
        # A comparison that goes green because the file it reads is gone is a comparison a deleted
        # baseline turns off, so a missing one is a refusal.
        print(f"\nno baseline at {path}: this run has nothing to be read against")
        return INCOMPARABLE
    return _report(record, baseline_module.load(path), path)


if __name__ == "__main__":
    sys.exit(main())
