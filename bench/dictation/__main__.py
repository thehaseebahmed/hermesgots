"""One command that hears the fixtures on this host and prints what each take cost.

    python3 -m bench.dictation                     # hear every fixture, compare with the baseline
    python3 -m bench.dictation --cut pause-first   # the same audio, sliced another way
    python3 -m bench.dictation --out record.json   # keep the whole record
    python3 -m bench.dictation --write-baseline    # rewrite the committed baseline
    python3 -m bench.dictation --self-check        # the bench's own rules, with no decoder

It runs where the host's speech model is installed. A host without one runs ``--self-check`` and
skips the numbers, saying it skipped rather than reporting a pass (ADR 0075).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Sequence

from . import BASELINE
from . import baseline as baseline_module
from . import cut as cutting
from . import drive
from . import fixtures as fixtures_module
from . import words as words_module

# What a run answers: it was read against the baseline and agreed, a word moved, or the run can't be
# read against that baseline at all. A host with no decoder skips, which is not a pass.
OK, MOVED, INCOMPARABLE = 0, 1, 2


def parser() -> argparse.ArgumentParser:
    command = argparse.ArgumentParser(
        prog="python3 -m bench.dictation",
        description=(
            "Hear the dictation fixtures on this host, through the plugin's own take functions, and "
            "print what each take cost: its Pieces, each decode, the Cleanup, the Confirm span, the "
            "words that landed, their distance from the reference and whether the Vocabulary came "
            "back as spelled."
        ),
    )
    command.add_argument(
        "--cut",
        default="device",
        choices=sorted(cutting.POLICIES),
        help="where a Piece's cut falls (default: device, the rule the app runs today)",
    )
    from plugin.dictation_cleanup import LEVELS

    command.add_argument(
        "--level",
        default="none",
        choices=list(LEVELS),
        help=(
            "the bot's Cleanup level (default: none, which makes no call). A cleaning level needs "
            "--cleanup-url and --cleanup-model: a bench runs outside a Hermes process"
        ),
    )
    command.add_argument("--model", default="base", help="the speech model to hear with")
    command.add_argument("--compute-type", default="int8", help="the model's compute type")
    command.add_argument("--language", default="en", help="the language the fixtures are in")
    command.add_argument("--beam-size", type=int, default=5, help="the decoder's beam")
    command.add_argument("--threads", type=int, default=4, help="decode threads, pinned for a repeat")
    command.add_argument(
        "--fixture",
        action="append",
        default=[],
        metavar="NAME",
        help="hear only this fixture (repeatable)",
    )
    command.add_argument(
        "--no-hearing",
        dest="hearing",
        action="store_false",
        help=(
            "send each Piece to the decoder with no prompt. The Hearing prompt is on by default, "
            "because it is what carries a bot's Vocabulary to the decoder (ADR 0067)"
        ),
    )
    command.add_argument(
        "--no-pace",
        dest="pace",
        action="store_false",
        help=(
            "upload every Piece at once instead of at the pace the take was said, which leaves the "
            "worker no time to overlap a decode with the next Piece: the worst case at Stop"
        ),
    )
    command.add_argument(
        "--no-vocabulary",
        action="store_true",
        help="drop the fixtures' Vocabulary, which the names case is meant to fail without",
    )
    command.add_argument("--cleanup-url", help="an OpenAI-compatible endpoint for the Cleanup")
    command.add_argument("--cleanup-model", help="the model a Cleanup asks at that endpoint")
    command.add_argument("--cleanup-key", help="a bearer token for that endpoint")
    command.add_argument("--out", type=Path, help="write the run's whole record here, as JSON")
    command.add_argument(
        "--baseline",
        type=Path,
        default=None,
        help=(
            "the baseline to read this run against (default: the one committed beside the fixtures "
            "for this cut policy, e.g. baseline.json, or baseline-pause-first.json)"
        ),
    )
    command.add_argument(
        "--write-baseline", action="store_true", help="rewrite that baseline from this run"
    )
    command.add_argument(
        "--no-check", action="store_true", help="record and print, without reading the baseline"
    )
    command.add_argument("--json", action="store_true", help="print the record itself, as JSON")
    command.add_argument(
        "--self-check",
        action="store_true",
        help="check the bench's own rules and its fixture set; needs no decoder",
    )
    return command


def _dur(ms: Optional[int]) -> str:
    return "-" if ms is None else f"{ms / 1000:.1f}s"


def _clipped(text: str, width: int = 62) -> str:
    flat = " ".join((text or "").split())
    return flat if len(flat) <= width else flat[: width - 1] + "…"


def table(record: Dict[str, Any]) -> List[str]:
    """The run, as a reader reads it: one line per take, then its totals."""
    decoder = record["decoder"]
    heard = len(record["takes"])
    of_set = (
        f"{heard} of {record['fixtures']['count']} fixtures"
        if record["subset"]
        else f"{record['fixtures']['count']} fixtures"
    )
    lines = [
        f"Dictation bench — {of_set}, cut {record['cut']['name']}, "
        f"level {record['level']}, model {decoder['model']}, pace {record['pace']}"
        + (", Hearing prompt on" if record["hearing"] else ", no Hearing prompt"),
        f"{decoder['backend']} · {decoder['model']} {decoder['compute_type']} · "
        f"{decoder['language']} · beam {decoder['beam_size']} · {decoder['cpu_threads']} threads · "
        f"warm {decoder['warm_ms'] / 1000:.1f}s",
        f"host {record['host']['name']} {record['host']['machine']}, "
        f"{record['host']['cpus']} cpus, python {record['host']['python']}",
        "hallucinations "
        + (
            "filtered by Hermes's own rule"
            if record["hallucinations"] == "hermes"
            else "not filtered: no Hermes here to filter with"
        ),
        f"fixtures sha256 {record['fixtures']['sha256'][:16]}… "
        f"({record['fixtures']['count']} files)",
        "",
        f"{'take':<10} {'path':<6} {'pieces':>6} {'longest':>8} {'spoken':>7} {'decode':>7} "
        f"{'cleanup':>8} {'confirm':>8} {'wer':>5}  words",
    ]
    for take in record["takes"]:
        longest = max((piece["ms"] for piece in take["pieces"]), default=0)
        lines.append(
            f"{take['fixture']:<10} {take['path']:<6} {len(take['pieces']):>6} "
            f"{_dur(longest):>8} {_dur(take['spoken_ms']):>7} {_dur(take['decode_ms']):>7} "
            f"{_dur(take['cleanup']['ms']):>8} {_dur(take['confirm_ms']):>8} "
            f"{take['wer']:>5.2f}  {_clipped(take['heard']) or '(no words)'}"
        )
        if take["vocabulary"]["words"]:
            missed = take["vocabulary"]["missed"]
            spelled = "as spelled" if not missed else f"missed {', '.join(missed)}"
            lines.append(f"{'':<10} vocabulary: {spelled}")
        if take["heard"] != take["landed"]:
            lines.append(f"{'':<10} landed: {_clipped(take['landed'], 84)}")
    totals = record["totals"]
    lines += [
        "",
        f"{'totals':<10} {'':<6} {totals['pieces']:>6} {'':>8} {_dur(totals['spoken_ms']):>7} "
        f"{_dur(totals['decode_ms']):>7} {_dur(totals['cleanup_ms']):>8} "
        f"{_dur(totals['confirm_ms']):>8}",
    ]
    unasked = [take["fixture"] for take in record["takes"] if not take["cleanup"]["asked"]
               and take["cleanup"]["level"] != "none"]
    if unasked:
        lines.append(
            f"the Cleanup never asked a model on {', '.join(unasked)}: pass --cleanup-url and "
            "--cleanup-model to measure one"
        )
    if not any(take.get("heard") for take in record["takes"]):
        lines.append("this run landed no words anywhere, which is a broken run and not a result")
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
        agreed = len(record["takes"])
        print(f"\nbaseline: clean — {agreed} take{'s' if agreed != 1 else ''} agree with {path.name}")
        return OK
    print("\nbaseline: moved")
    for line in moved:
        print(f"  {line}")
    words = any("the words moved" in line for line in moved)
    print(
        "  a take's words moved: a change to the decoder, the prompt or the fixtures"
        if words
        else "  no take's words moved: what changed is how the take was cut or measured, not what "
        "was heard"
    )
    return MOVED


Audio = Dict[str, "tuple[Sequence[float], int]"]


def _read_all(fixtures: Sequence[fixtures_module.Fixture]) -> "tuple[Audio, List[str]]":
    """Every fixture this host can read, and the names of the ones whose container it can't.

    A WAV is read by the standard library; the app's own WebM needs the decoder's reader, and this
    check is the one a host with no decoder runs, so it says which fixture it couldn't look at.
    """
    audio: Audio = {}
    unread: List[str] = []
    for fixture in fixtures:
        try:
            audio[fixture.name] = cutting.read(fixture.audio)
        except ImportError:
            unread.append(fixture.name)
    return audio, unread


def _fixture_problems(
    fixtures: Sequence[fixtures_module.Fixture], audio: Audio
) -> List[str]:
    """The fixture set as ADR 0075 describes it, and every cut of it as a take that adds up."""
    from plugin.dictation import suffix_for

    problems: List[str] = []
    if len(fixtures) != 9:
        problems.append(f"the fixture set is {len(fixtures)} recordings, not the nine ADR 0075 names")
    for fixture in fixtures:
        if not fixture.audio.exists():
            problems.append(f"{fixture.name}: {fixture.audio.name} isn't there")
            continue
        # The plugin decides a Piece's suffix from its content type, so a manifest that says one
        # type for another file's bytes would send the host a container it isn't.
        suffix = suffix_for(fixture.content_type)
        if suffix != fixture.audio.suffix.lower():
            problems.append(
                f"{fixture.name}: {fixture.audio.name} is a {fixture.audio.suffix}, and its "
                f"manifest type {fixture.content_type} reads as {suffix}"
            )
        if fixture.name in audio:
            problems += _cut_problems(fixture, *audio[fixture.name])
    return problems


def _cut_problems(
    fixture: fixtures_module.Fixture, samples: Sequence[float], rate: int
) -> List[str]:
    """One fixture's Pieces under every policy: none empty, none missing, all of it accounted for."""
    problems = []
    total_ms = len(samples) * 1000 // rate
    for policy in cutting.POLICIES.values():
        pieces = cutting.pieces(samples, rate, policy)
        if not pieces:
            problems.append(f"{fixture.name} under {policy.name}: no Pieces at all")
            continue
        if any(piece.ms <= 0 for piece in pieces):
            problems.append(f"{fixture.name} under {policy.name}: an empty Piece")
        elif sum(piece.ms for piece in pieces) != total_ms:
            problems.append(
                f"{fixture.name} under {policy.name}: Pieces sum to "
                f"{sum(piece.ms for piece in pieces)} ms of {total_ms} ms"
            )
        try:
            drive.require_one_piece(fixture, pieces)
        except ValueError as wrong:
            problems.append(f"{fixture.name} under {policy.name}: {wrong}")
    return problems


def _silence_problems(
    fixtures: Sequence[fixtures_module.Fixture], audio: Audio
) -> List[str]:
    """Room tone is a room: a fixture that peaks like speech would prove the wrong thing."""
    silence = next((fixture for fixture in fixtures if fixture.name == "silence"), None)
    if silence is None:
        return ["no silence fixture: the set must hold room tone"]
    if silence.name not in audio:
        return []
    samples, _ = audio[silence.name]
    loudest = max(abs(sample) for sample in samples)
    if loudest > cutting.QUIET_MAX:
        return [f"the silence fixture peaks at {loudest:.3f}, which is speech and not a room"]
    return []


def _rule_problems() -> List[str]:
    """The words rule and the vocabulary rule, on the cases whose answers are known."""
    problems = []
    if words_module.wer("the take is the host's", "the take is the host's") != 0.0:
        problems.append("the words rule: identical text isn't a distance of zero")
    if words_module.wer("one two three four", "one two three") != 0.25:
        problems.append("the words rule: one word in four is a distance of 0.25")
    if words_module.spelled(["Gots"], "the Gots plugin")["spelled"] is not True:
        problems.append("the vocabulary rule: a word that came back isn't read as spelled")
    if words_module.spelled(["Gots"], "the guts plugin")["spelled"] is not False:
        problems.append("the vocabulary rule: a word that didn't come back is read as spelled")
    return problems


def _baseline_problems() -> List[str]:
    """The committed baseline, and the reading of a run against it: clean, refused, and moved."""
    if not BASELINE.exists():
        return [f"{BASELINE.name} is missing: a run has nothing to be read against"]
    fixtures = fixtures_module.load()
    committed = baseline_module.load(BASELINE)
    problems = []
    if committed.get("object") != baseline_module.OBJECT:
        problems.append(f"{BASELINE.name} isn't a {baseline_module.OBJECT}")
    for key in baseline_module.IDENTITY:
        if key not in committed:
            problems.append(
                f"{BASELINE.name} has no {key}, so a run can't be refused as incomparable with it"
            )
    if (committed.get("fixtures") or {}).get("sha256") != fixtures_module.digest(fixtures)["sha256"]:
        problems.append(f"{BASELINE.name} was taken on other bytes than these fixtures")
    named = {take.get("fixture") for take in committed.get("takes") or ()}
    if named != {fixture.name for fixture in fixtures}:
        problems.append(
            f"{BASELINE.name} names {sorted(named)}, the manifest "
            f"{sorted(fixture.name for fixture in fixtures)}"
        )
    for take in committed.get("takes") or ():
        for key in ("spoken_ms", "pieces_ms", "heard", "wer"):
            if key not in take:
                problems.append(f"{BASELINE.name}: {take.get('fixture')} has no {key}")

    # A check that can't tell a clean run from a refused one and a moved word from either would
    # pass every run it was handed.
    def replica(takes: Any) -> Dict[str, Any]:
        # Built from the identity the reader uses, so a field added to it is exercised here too
        # rather than leaving this check testing a shape from before it existed.
        run = {key: committed.get(key) for key in baseline_module.IDENTITY}
        run["takes"] = [dict(take) for take in takes]
        return run

    takes = committed.get("takes") or ()
    same = replica(takes)
    if baseline_module.incomparable(committed, same) or baseline_module.differences(committed, same):
        problems.append("the baseline rule: a copy of the baseline isn't read as clean")
    another = replica(takes)
    another["cut"] = {**another["cut"], "name": "another policy", "floor_ms": 1}
    if not baseline_module.incomparable(committed, another):
        problems.append("the baseline rule: another cut policy isn't refused as incomparable")
    moved = replica(takes)
    moved["takes"][0]["heard"] = "something else entirely"
    if not baseline_module.differences(committed, moved):
        problems.append("the baseline rule: a take whose words moved isn't reported")
    return problems


def _self_check() -> int:
    """The bench's own rules and its fixture set, answered without a decoder anywhere near it."""
    fixtures = fixtures_module.load()
    audio, unread = _read_all(fixtures)
    problems = (
        _fixture_problems(fixtures, audio)
        + _silence_problems(fixtures, audio)
        + _rule_problems()
        + cutting.app_rule_problems(cutting.POLICIES["device"])
        + _baseline_problems()
    )
    if problems:
        print("self-check failed:")
        for problem in problems:
            print(f"  - {problem}")
        return 1
    print(
        f"self-check passed: {len(fixtures)} fixtures, {len(cutting.POLICIES)} cut policies, "
        f"{BASELINE.name} taken on these bytes"
    )
    for name in unread:
        print(f"  {name}: its container needs the decoder's own reader, so only a run checks its shape")
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    args = parser().parse_args(argv)
    if args.self_check:
        return _self_check()

    fixtures = fixtures_module.load(only=args.fixture)
    policy = cutting.POLICIES[args.cut]
    if args.baseline is not None:
        baseline = args.baseline
    elif args.cut == "device":
        baseline = BASELINE
    else:
        baseline = BASELINE.with_name(f"baseline-{args.cut}.json")
    settings = drive.Settings(
        model=args.model,
        compute_type=args.compute_type,
        language=args.language,
        beam_size=args.beam_size,
        cpu_threads=args.threads,
        level=args.level,
        hearing=args.hearing,
        pace=args.pace,
        vocabulary=not args.no_vocabulary,
        cleanup_url=args.cleanup_url,
        cleanup_model=args.cleanup_model,
        cleanup_key=args.cleanup_key,
    )
    try:
        record = drive.run(fixtures, policy, settings)
    except drive.NoDecoder as missing:
        print(f"skipped: {missing}")
        return 0

    # Room tone lands no words. A run where it does is not a baseline to be compared with — it is
    # a decoder writing over silence, which the next baseline would otherwise commit as clean.
    silent = next((take for take in record["takes"] if not take.get("reference")), None)
    if silent is not None and silent.get("heard"):
        print(
            f"\n{silent['fixture']} is room tone and landed {silent['heard']!r}: this host wrote "
            f"words over silence, so its numbers are not a baseline"
        )
        return MOVED

    if args.json:
        print(json.dumps(record, indent=2))
    else:
        for line in table(record):
            print(line)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(record, indent=2) + "\n")
        print(f"\nrecord written to {args.out}")

    if args.write_baseline:
        baseline_module.write(baseline, record)
        print(f"baseline written to {baseline}")
        return OK
    if args.no_check:
        return OK
    if not baseline.exists():
        # A gate that goes green because the file it compares against is gone is a gate that a
        # deleted baseline turns off, so a missing one is a refusal.
        print(f"\nno baseline at {baseline}: this run has nothing to be read against")
        return INCOMPARABLE
    return _report(record, baseline_module.load(baseline), baseline)


if __name__ == "__main__":
    sys.exit(main())
