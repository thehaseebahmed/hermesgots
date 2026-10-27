"""Fail when the Hermes internals this plugin mirrors have moved under us.

Usage: python3 .github/scripts/check-hermes-internals.py <hermes checkout> <plugin dir>

The wake text is a copy of Hermes's own completion notice (#595): the first line, the
intro, the batch header, the truncation note and its Status-line mark, the iteration nudge and the
machine-provenance footer are Hermes's sentences, composed here rather than imported, and three of
its internals are read by name (``_active_subagents``, ``_run_statuses``, ``interrupt_subagent``).
Hermes renames and rewrites them without knowing this plugin exists, so this check says so on the
next pull request, or on the weekly run, instead of on a user's wake.

Everything here reads source text — a substring of a Hermes file, a module-level string constant, or
the same on the plugin side — so it runs against any checkout with no host and no network. The
plugin is never imported: its import chain wants a Hermes host (``plugin/__init__.py`` pulls
aiohttp and cryptography). Both directions matter: a sentence Hermes no longer writes fails, and so
does a plugin constant that drifted from the one Hermes writes now.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path
from typing import Dict, List, Optional, Tuple

# What the plugin reads by name, and the notice text it mirrors, in the Hermes checkout. A tuple of
# relative paths means "any of these holds it" — the API server's run table has moved once already.
ANCHORS: Tuple[Tuple[Tuple[str, ...], str], ...] = (
    # The live-subagent registry: the record a delegation's own card reads, and the per-child stop
    # that card's button calls.
    (("tools/delegate_tool_registry.py",), "_active_subagents"),
    (("tools/delegate_tool_registry.py",), "def interrupt_subagent"),
    # The run table the gate check reads, in whichever module holds it.
    (("gateway/platforms/api_server.py", "gateway/platforms/api_server_runs.py"), "_run_statuses"),
    # Core's completion notice: first line, intro, truncation note, its Status-line mark, the batch
    # header, and the line a failed child gets.
    (("tools/process_registry_notifications.py",), "[ASYNC DELEGATION COMPLETE — "),
    (
        ("tools/process_registry_notifications.py",),
        "A background subagent you dispatched earlier has finished. You may",
    ),
    (("tools/process_registry_notifications.py",), "TRUNCATED — subagent hit its iteration cap"),
    (
        ("tools/process_registry_notifications.py",),
        "Unrecorded outcomes remain unknown; inspect evidence before retrying side effects.",
    ),
    (("tools/process_registry_notifications.py",), "hit max_iterations — work may be incomplete"),
    (("tools/process_registry_notifications.py",), "background processes completed."),
    (("tools/process_registry_notifications.py",), "The subagent did not complete successfully (status="),
    # The nudge a truncated child's transcript is recognized by, on both sides.
    (("agent/context_compressor.py",), "You've reached the maximum number of tool-calling iterations allowed"),
    # The status markers the app's snapshot check reads an item line by.
    (("tools/todo_tool.py",), '_STATUS_MARKERS = {"completed": "[x]"'),
    # The process notices the app draws nothing of, told from a message that names one.
    (("tools/process_registry_notifications.py",), "[IMPORTANT: Background process "),
    (("tools/process_registry_notifications.py",), "matched watch pattern"),
    (("tools/process_registry_notifications.py",), "heartbeat #"),
    (("tools/process_registry_notifications.py",), "background processes completed."),
    # The caps on what a plugin may add to the system prompt as a section, and on the host's own
    # context files. A section past the first is dropped whole at render — the reason
    # plugin/openui.py refuses to register one — and SOUL.md past the third is truncated head and
    # tail with a marker naming the file read_file recovers it from. Gots injects neither: the host
    # reads SOUL.md as the session's identity, for coding sessions too. Pinned, never copied.
    (("hermes_cli/plugins_dispatch.py",), "DEFAULT_SYSTEM_PROMPT_SECTION_MAX_CHARS = 4_000"),
    (("hermes_cli/plugins_dispatch.py",), "MAX_SYSTEM_PROMPT_SECTIONS_TOTAL_CHARS = 8_000"),
    (("agent/prompt_builder.py",), "CONTEXT_FILE_MAX_CHARS = 20_000"),
)

# Hermes's own constants, read out of the checkout as they are: they are what the plugin's copies are
# compared against, so nothing here restates the sentence.
FOOTER_REL = "gateway/run_notifications.py"
NUDGE_REL = "agent/context_compressor.py"
NOTICE_REL = "tools/process_registry_notifications.py"
REPLAY_REL = "agent/context_compressor.py"
TODO_REL = "tools/todo_tool.py"
RELOAD_REL = "agent/conversation_compression.py"

CONSTANTS: Tuple[Tuple[str, str, str, str], ...] = (
    (FOOTER_REL, "INTERNAL_NOTIFICATION_FOOTER", "footer", "the machine-provenance footer"),
    (NUDGE_REL, "MAX_ITERATIONS_SUMMARY_REQUEST", "nudge", "the iteration nudge"),
    (NOTICE_REL, "_TRUNCATED_SUMMARY_NOTE", "note", "the truncation note"),
    (REPLAY_REL, "_INFLIGHT_TASK_REPLAY_HEADER", "replay", "the restatement's header"),
    (TODO_REL, "TODO_INJECTION_HEADER", "snapshot", "the preserved task list's header"),
    (RELOAD_REL, "_PRUNED_SKILL_RELOAD_NOTICE_HEADER", "reload", "the reload notice's header"),
)

# The plugin's copies. Each is compared, character for character, with the value the checkout holds
# now; ``_canonical`` folds the two placeholder spellings where a sentence carries one.
COPIES: Tuple[Tuple[str, str, str], ...] = (
    ("WAKE_HEADER", "header", "the completion notice's first line"),
    ("WAKE_INTRO", "intro", "the completion notice's intro"),
    ("NOTIFICATION_FOOTER", "footer", "the machine-provenance footer"),
    ("BATCH_HEADER", "batch", "the batch header"),
    ("TRUNCATED_NOTE", "note", "the truncation note"),
    ("TRUNCATED_MARK", "mark", "the Status line's truncation mark"),
    ("ITERATION_NUDGE", "nudge", "the iteration nudge a child's transcript is recognized by"),
)

APP_SEAM_REL = "app/src/lib/compaction-seam.ts"

# `whole` is how much of the host's text the app's copy carries: the three headers word for word, the
# notice's body as the opening that tells it from a message quoting the header.
APP_COPIES: Tuple[Tuple[str, str, str, bool], ...] = (
    ("REPLAY_HEADER", "replay", "the restatement's header", True),
    ("TASK_SNAPSHOT_HEADER", "snapshot", "the preserved task list's header", True),
    ("RELOAD_NOTICE_HEADER", "reload", "the reload notice's header", True),
    ("RELOAD_NOTICE_BODY", "reloadBody", "the notice's own opening", False),
)

# The plugin's own half of the names above: a rename here would leave the checks below passing while
# the plugin stopped reading what they guard.
PLUGIN_NAMES: Tuple[Tuple[str, str], ...] = (
    ("_active_subagents", "the live-subagent registry"),
    ("_run_statuses", "the run table the gate check reads"),
    ("interrupt_subagent", "core's per-child stop"),
)

TOTAL = (
    len(ANCHORS) + len(CONSTANTS) + len(COPIES) + len(APP_COPIES) + len(PLUGIN_NAMES) + 1
)

_OPENING = re.compile(r"(?:[rRbBuUfF]{0,2})('''|\"\"\"|'|\")")
_SPACE = " \t\r\n\f\v"


def _skip_space(src: str, pos: int) -> int:
    """Past whitespace, a line continuation and ``#`` comments: what may sit between two literals."""
    while pos < len(src):
        if src[pos] in _SPACE:
            pos += 1
        elif src.startswith("\\\n", pos):
            pos += 2
        elif src[pos] == "#":
            nl = src.find("\n", pos)
            if nl < 0:
                return len(src)
            pos = nl + 1
        else:
            break
    return pos


def _read_string(src: str, pos: int) -> Optional[Tuple[str, int]]:
    """``(text, end)`` for the string literal opening at ``pos``, as written.

    Escapes are left as they stand and an f-string's ``{...}`` is kept verbatim, because every
    literal compared here is plain text and a count is compared as the placeholder it is.
    """
    match = _OPENING.match(src, pos)
    if not match:
        return None
    quote, end = match.group(1), match.end()
    while end < len(src):
        if src.startswith(quote, end):
            return src[match.end():end], end + len(quote)
        if src[end] == "\\":
            end += 2
            continue
        end += 1
    return None


def _joined(src: str, marker: str) -> Optional[str]:
    """The literal that starts with ``marker``, joined with the literals continuing it.

    Python spells a long sentence as adjacent literals; this is what makes such a sentence comparable
    as one string.
    """
    start = src.find(marker)
    if start < 0:
        return None
    parts: List[str] = []
    pos = start
    while True:
        piece = _read_string(src, pos)
        if piece is None:
            return "".join(parts) or None
        text, pos = piece
        parts.append(text)
        following = _skip_space(src, pos)
        if _read_string(src, following) is None:
            return "".join(parts)
        pos = following


def _constant(src: str, name: str) -> Optional[str]:
    """The text a module-level ``NAME = "..."`` carries, an implicit concatenation joined."""
    match = re.search(r"(?m)^" + re.escape(name) + r"\s*=\s*", src)
    if not match:
        return None
    pos, depth, parts = match.end(), 0, []
    while pos < len(src):
        pos = _skip_space(src, pos)
        if pos >= len(src):
            break
        if src[pos] == "(":
            depth += 1
            pos += 1
            continue
        if src[pos] == ")":
            if not depth:
                break
            depth -= 1
            pos += 1
            if not depth:
                break
            continue
        piece = _read_string(src, pos)
        if piece is None:
            break
        text, pos = piece
        parts.append(text)
        if not depth:
            # Outside a parens group the statement ends with the line: a literal on the next one
            # belongs to whatever comes next.
            line_end = src.find("\n", pos)
            following = pos
            while following < (len(src) if line_end < 0 else line_end) and src[following] in " \t":
                following += 1
            if following < (len(src) if line_end < 0 else line_end) and _read_string(src, following):
                pos = following
                continue
            break
    return "".join(parts) or None


def _ts_constant(src: str, name: str) -> Optional[str]:
    """The text an exported ``const NAME = "..."`` carries, wrapped below the ``=`` or not."""
    match = re.search(r"(?m)^export const " + re.escape(name) + r"\s*=\s*", src)
    if not match:
        return None
    pos = match.end()
    while pos < len(src) and src[pos] in _SPACE:
        pos += 1
    piece = _read_string(src, pos)
    return piece[0] if piece else None


def _ts_strings(src: str, name: str) -> Optional[List[str]]:
    """The strings an exported ``const NAME = ["a", "b"]`` holds."""
    match = re.search(r"(?m)^export const " + re.escape(name) + r"\s*=\s*\[", src)
    if not match:
        return None
    end = src.find("]", match.end())
    if end < 0:
        return None
    body, pos, out = src[match.end():end], 0, []
    while True:
        while pos < len(body) and body[pos] not in "\"'":
            pos += 1
        piece = _read_string(body, pos)
        if piece is None:
            return out or None
        text, pos = piece
        out.append(text)


def _todo_markers(src: str) -> Optional[List[str]]:
    """The bracket characters a task item's status is printed in, one per marker."""
    found = re.findall(r'"\w+": "\[([^\]])\]"', src)
    return found or None


def _status_mark(src: str) -> Optional[str]:
    """The Status line's truncation suffix, which core appends inline rather than naming."""
    match = re.search(r'"(\s*\[TRUNCATED:[^"\n]*max_iterations[^"\n]*\])"', src)
    return match.group(1) if match else None


def _canonical(text: str) -> str:
    """The comparison form of a copy that carries a placeholder.

    The two sides name their interpolation differently (``{n}`` here, ``{len(messages)}`` there;
    ``{subagent_id}`` here, ``{deleg_id}`` there), so each side's braces fold to one token: what has
    to match is the sentence around them. Folded by shape rather than by the constant's name, so a
    rename can never silently drop the folding and compare raw against folded. Every other constant
    is compared exactly.
    """
    return re.sub(r"\{[^{}]*\}", "{placeholder}", text) if "{" in text else text


def _head(root: Path) -> str:
    """`` @ <short sha>`` when the checkout is a git clone, so a failing run names what it read."""
    try:
        done = subprocess.run(
            ["git", "-C", str(root), "rev-parse", "--short", "HEAD"],
            capture_output=True,
            text=True,
            timeout=15,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    rev = done.stdout.strip()
    return f" @ {rev}" if done.returncode == 0 and rev else ""


def main(argv: List[str]) -> int:
    if len(argv) != 3:
        print("usage: check-hermes-internals.py <hermes checkout> <plugin dir>", file=sys.stderr)
        return 2
    hermes, plugin = Path(argv[1]).resolve(), Path(argv[2]).resolve()

    text: Dict[Path, Optional[str]] = {}
    reported: set[Path] = set()
    failures: List[str] = []

    def read(path: Path) -> Optional[str]:
        if path not in text:
            try:
                text[path] = path.read_text(encoding="utf-8")
            except OSError:
                text[path] = None
        return text[path]

    def absent(rels: Tuple[str, ...]) -> bool:
        """True when none of ``rels`` reads; the group is named once, however many checks want it."""
        paths = [hermes / rel for rel in rels]
        if any(read(path) is not None for path in paths):
            return False
        if not any(path in reported for path in paths):
            reported.update(paths)
            failures.append(f"hermes:{' or '.join(rels)}: missing file")
        return True

    def sourced(rel: str) -> Optional[str]:
        return None if absent((rel,)) else read(hermes / rel)

    # The Hermes side: the internals, then the text.
    for rels, literal in ANCHORS:
        if absent(rels):
            continue
        if not any(literal in (read(hermes / rel) or "") for rel in rels):
            failures.append(f"hermes:{' or '.join(rels)}: missing {literal!r}")

    derived: Dict[str, Tuple[str, str]] = {}

    def derive(key: str, rel: str, source: Optional[str], reader, what: str) -> None:
        if source is None:
            return  # its file is already reported missing
        value = reader(source)
        if value is None:
            failures.append(f"hermes:{rel}: {what} not found")
            return
        derived[key] = (value, rel)

    notice = sourced(NOTICE_REL)
    footer = sourced(FOOTER_REL)
    nudge = sourced(NUDGE_REL)

    derive("header", NOTICE_REL, notice, lambda src: _joined(src, '"[ASYNC DELEGATION COMPLETE — '),
           "the completion notice's first line")
    derive("intro", NOTICE_REL, notice,
           lambda src: _joined(src, '"A background subagent you dispatched earlier has finished.'),
           "the completion notice's intro")
    def _batch_header(src: str) -> Optional[str]:
        """The batch header, identified by its sentence rather than its first 13 characters: the
        module writes other ``[IMPORTANT:`` lines, and one arriving earlier must not rebind this
        comparison to the wrong one."""
        joined = _joined(src, '"[IMPORTANT: ')
        if joined is not None and "background processes completed" not in joined:
            return None
        return joined

    derive("batch", NOTICE_REL, notice, _batch_header, "the batch header")
    derive("mark", NOTICE_REL, notice, _status_mark, "the Status line's truncation mark")
    for rel, name, key, what in CONSTANTS:
        derive(key, rel, sourced(rel), lambda src, name=name: _constant(src, name), what)
    derive(
        "reloadBody",
        RELOAD_REL,
        sourced(RELOAD_REL),
        lambda src: _joined(src, '"The task list above crossed'),
        "the reload notice's own opening",
    )
    derive("markers", TODO_REL, sourced(TODO_REL), _todo_markers, "the status markers an item prints")

    # The plugin side: the same names, and the same sentences.
    delegation = plugin / "delegation.py"
    src = read(delegation)
    if src is None:
        failures.append("plugin:delegation.py: missing file")
    else:
        for literal, what in PLUGIN_NAMES:
            if literal not in src:
                failures.append(f"plugin:delegation.py: missing {literal!r} ({what})")
        for constant, key, what in COPIES:
            value = _constant(src, constant)
            if value is None:
                failures.append(f"plugin:delegation.py: missing constant {constant} ({what})")
                continue
            if key not in derived:
                # Never a skip: a key that names no check is this script drifting from itself, and
                # a silently skipped comparison is the one failure it exists to catch.
                failures.append(
                    f"plugin:delegation.py: {constant} ({what}) compares against unknown check {key!r}"
                )
                continue
            expected, rel = derived[key]
            if _canonical(value) != _canonical(expected):
                failures.append(
                    f"plugin:delegation.py: {constant} ({what}) is not what hermes:{rel} writes — "
                    f"hermes {expected!r} plugin {value!r}"
                )

    seam = read(plugin.parent / APP_SEAM_REL)
    if seam is None:
        failures.append(f"app:{APP_SEAM_REL}: missing file")
    else:

        def app_pair(constant: str, key: str, what: str) -> Optional[Tuple[str, str, str]]:
            """The app's copy, the host's text and the file it came from: ``None`` once reported."""
            value = _ts_constant(seam, constant)
            if value is None:
                failures.append(f"app:{APP_SEAM_REL}: missing constant {constant} ({what})")
                return None
            if key not in derived:
                failures.append(
                    f"app:{APP_SEAM_REL}: {constant} ({what}) compares against unknown check {key!r}"
                )
                return None
            expected, rel = derived[key]
            return value, expected, rel

        for constant, key, what, whole in APP_COPIES:
            pair = app_pair(constant, key, what)
            if not pair:
                continue
            value, expected, rel = pair
            held = _canonical(value) == _canonical(expected) if whole else (
                _canonical(expected).startswith(_canonical(value))
            )
            if not held:
                failures.append(
                    f"app:{APP_SEAM_REL}: {constant} ({what}) "
                    f"{'is not' if whole else 'does not open'} what hermes:{rel} writes — "
                    f"hermes {expected!r} app {value!r}"
                )

        marks = _ts_strings(seam, "SNAPSHOT_MARKERS")
        if marks is None:
            failures.append(f"app:{APP_SEAM_REL}: missing SNAPSHOT_MARKERS (an item's status markers)")
        elif "markers" not in derived:
            failures.append(
                f"app:{APP_SEAM_REL}: SNAPSHOT_MARKERS compares against unknown check 'markers'"
            )
        else:
            expected_marks, rel = derived["markers"]
            if sorted(marks) != sorted(list(expected_marks) + ["?"]):
                failures.append(
                    f"app:{APP_SEAM_REL}: SNAPSHOT_MARKERS (an item's status markers) is not what "
                    f"hermes:{rel} prints — hermes {sorted(expected_marks)!r} app {sorted(marks)!r}"
                )

    if failures:
        print("\n".join(failures))
        print(f"hermes-internals: {len(failures)} findings")
        return 1
    print(f"hermes-internals: {TOTAL} checks hold against {hermes}{_head(hermes)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
