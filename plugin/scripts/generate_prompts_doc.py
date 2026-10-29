"""Generates docs/prompts.md: the prompts the plugin tells, so the words a run is injected with are
readable without starting a session. Two families live in it — the ones a session is told, and the
ones dictation sends to a model, to tidy what was heard and to spell what it will hear. The staged
task's own briefs are left out: they are briefed for a workflow's stage and named under
`## User's Workflow`. Run it from the repo root:

    python3 plugin/scripts/generate_prompts_doc.py

The Prompts doc workflow (``.github/workflows/prompts-doc.yml``) runs it whenever the builder
changes and opens a pull request when the doc moves. Absolute paths (the repo checkout and the
throwaway dirs below) are scrubbed to a placeholder, so the doc is byte-identical on every machine
and an unchanged builder produces no pull request.
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path
from typing import Any, Dict

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

_base = Path(tempfile.mkdtemp(prefix="prompts-doc-"))

from plugin import dictation, dictation_cleanup, prompt_builder  # noqa: E402

PLACEHOLDER = "/home/agent"
BRANCH = "hermes/spry-thimble-d105"

# Real dirs, so ship.template() finds the pull request templates; the temp root is scrubbed from
# the output along with the checkout, so only the placeholder appears in the doc.
_repos = _base / "projects"
for name in ("web", "api"):
    (_repos / name / ".github").mkdir(parents=True)
    (_repos / name / ".github" / "pull_request_template.md").write_text(
        "## Summary\n", encoding="utf-8"
    )


def _repo(name: str) -> dict:
    return {
        "name": f"o/{name}",
        "repo_root": str(_repos / name),
        "path": str(_repos / name),
        "branch": BRANCH,
    }


SINGLE = {
    "session_id": "memento-1",
    "path": str(_repos / "web"),
    "branch": BRANCH,
    "mode": "accept_edits",
    "repos": [_repo("web")],
}
MULTI = {**SINGLE, "repos": [_repo("web"), _repo("api")]}

VARIANTS = [
    (
        "Single repo",
        "The common case: the base prompt — its heading, the guidelines and the tools — and last "
        "Current Session, naming its worktree, its pull request template and the directory "
        "throwaway work goes in.",
        SINGLE,
    ),
    (
        "Two repos",
        "A session that spans the project: every worktree is named in `## Current Session`, the "
        "primary repo's is the working directory, and both repos' templates are listed.",
        MULTI,
    ),
    (
        "Plan mode",
        "`## Plan mode` between the base prompt and this session's facts: the shape of the plan the "
        "agent writes before anything is allowed to change.",
        {**SINGLE, "mode": "plan"},
    ),
]

# An AFK run is a project session the plugin starts itself, so its record is the same shape; the
# branch is the task's own, and the task is what the run's first message and its lines name.
TASK: Dict[str, Any] = {
    "repo": "o/web",
    "number": 265,
    "title": "The frontier is read from GitHub and listed",
    "url": "https://github.com/o/web/issues/265",
    "created_at": "2026-10-01T00:00:00Z",
    "body": "## What to build\n\nThe frontier is read from GitHub, oldest first.\n",
}

AFK = {
    **SINGLE,
    "session_id": "memento-afk-0123456789ab",
    "branch": "hermes/afk-265",
    "repos": [{**_repo("web"), "branch": "hermes/afk-265"}],
}

# What a project's own Prompt looks like in the doc: its words in place of the default, the one
# part of a run's method it can change.
PROJECT_PROMPT = """How we work here:

- Small commits on a branch of their own, Conventional Commits, nothing squashed.
- A test for every behaviour, and none for styling.
- Run `pnpm lint` before every commit, not only at the end."""

AFK_VARIANTS = [
    (
        "An AFK run on the default Prompt",
        "A project that wrote no Prompt of its own: the base prompt, `## Away From Keyboard` with "
        "AFK's fixed brief, then `## User's Workflow` holding ``DEFAULT_PROMPT`` — the method "
        "every untouched project works by (ADR 0027).",
        prompt_builder.afk_prompt(AFK, TASK),
    ),
    (
        "An AFK run on a project's own Prompt",
        "The same run with the project's words under `## User's Workflow` where the default was, "
        "which is the one part of the method it can change.",
        prompt_builder.afk_prompt(AFK, TASK, PROJECT_PROMPT),
    ),
]

# What dictation's calls are shown, and the words the bot spells its own way: the same three the
# cleanup rules say to spell from the vocabulary, so a reader sees what the input really looks like.
VOCABULARY = ("memento", "haseeb", "hermes-agent")
HEARD = (
    "so i was thinking um we should move the retry logic into the plugin and then uh check the logs"
)
WHOLE = (
    HEARD
    + ". and then we could move them to the third of March and i will run it half past four tomorrow"
)
HINT = "Gots, memento, hermes-agent, spry-puffin"


def _model_prompt(system: str, instructions: str, example: str) -> str:
    """One cleanup call as the model receives it: the system line, the rules, then the input.

    The input is built by the module's own ``_prompt``, so the doc shows the labels and the
    vocabulary line exactly as a call sends them.
    """
    return (
        "System:\n"
        f"{system}\n\n"
        "Instructions:\n"
        f"{instructions.strip()}\n\n"
        "Input:\n"
        f"{dictation_cleanup._prompt(example, VOCABULARY)}"
    )


def _level(level: str, note: str) -> tuple:
    """One cleanup level's call: its prompt as built, and the promise the level makes."""
    asked = dictation_cleanup.DictationCleanupPrompt.Of(level).Build()
    return (f"Dictation cleanup: {level}", note, _model_prompt(asked.system, asked.instructions, WHOLE))


def _speech_prompt() -> str:
    """What faster-whisper is given as its prompt, in the order `dictation.py` builds it.

    It is not instructions: Whisper reads a prompt as what was just said, which is why the parts go
    in this order and why the text before the clip comes last. A bot that withholds its Hearing
    prompt sends the model none of it (ADR 0067).
    """
    return (
        dictation.DictationHearingPrompt()
        .WithInitialPrompt("<the host's own initial_prompt, when it sets one>")
        .WithHint(HINT[: dictation.MAX_HINT])
        .WithVocabulary(VOCABULARY[: dictation.MAX_VOCABULARY])
        .WithContext("<the end of what was said before this clip>")
        .Build()
    )


# Dictation's own prompts, below the session's: they are calls on the bot's model rather than
# instructions to a session, so they are told apart by their headings and their `System:` line.
DICTATION_VARIANTS = [
    _level(
        "light",
        "A take's whole text is tidied once when it ends, at the level its bot runs (ADR 0066). "
        f"Light removes what was stumbled over — fillers, a false start, a slip — and repairs the "
        f"grammar, punctuation, casing and numbers, keeping every other word. An answer outside "
        f"{dictation_cleanup.SHORTER['light']}x–{dictation_cleanup.LONGER}x of the text is thrown "
        f"away, and the words as heard land instead.",
    ),
    _level(
        "medium",
        "Medium does Light's work and tightens: wordiness, redundancy and run-ons go, without "
        f"dropping information. Its answer may run to {dictation_cleanup.SHORTER['medium']}x of the "
        "text before it is thrown away.",
    ),
    _level(
        "high",
        "High compresses: it may restructure a sentence and drop what a listener could not act on, "
        f"keeping every fact, number, name and request. Its answer may run to "
        f"{dictation_cleanup.SHORTER['high']}x of the text, and it is given "
        f"{dictation_cleanup.HIGH_DEADLINE_S:.0f} s rather than {dictation_cleanup.DEADLINE_S:.0f} s.",
    ),
    (
        "Dictation: the speech model's prompt",
        "Not instructions. faster-whisper is given a prompt it reads as what was just said, so the "
        "parts are in one order and each is capped: the host's own `initial_prompt`, then the names "
        f"this clip may mention (up to {dictation.MAX_HINT} characters), then the bot's own "
        f"vocabulary (up to {dictation.MAX_VOCABULARY} words), then the text before this clip — the "
        f"last {dictation.MAX_CONTEXT} characters — because its end matters most. A bot whose "
        "Hearing prompt is not sent gives the model none of it, and the cleanup carries the names.",
        _speech_prompt(),
    ),
]


HEADER = """# Prompts

> Generated file — do not edit. Regenerate with `python3 plugin/scripts/generate_prompts_doc.py`
> (the Prompts doc workflow runs it whenever `plugin/prompt_builder.py` changes and opens a pull
> request when the doc moves).

Two families of prompt live here. A session's is what an agent is injected with, and it is told in
the same sections, in the same order. Dictation's are the calls the app's speech-to-text makes: the
one that tidies a finished take, at each of the three levels that call a model (ADR 0066), and the
prompt the speech model itself is given (ADR 0067) — and they are the last four sections.

Every prompt is told in the same parts, in the same order. `# You are Gots!` opens the base prompt
with an overview of what the bot is, then `## Do` and `## Don't` — the guidelines it works by, a line
each — then `## Tools`, where every tool the run may use gets a line saying the use it is for
(`library_add` for the files it makes, `pull_request` for shipping the work). Then comes the mode:
`## Plan mode` for a planning session, `## Away From Keyboard` for an AFK run, with `## User's
Workflow` beneath it. Last is `## Current Session`, with everything only this session knows: the
issue or stage it works, its worktrees, its repos' pull request templates and the directory
throwaway work goes in. The fixed sections come first so two runs share their opening (ADR 0028).

Every project session's run carries the prompt `prompt_builder.session_prompt(record)` builds for
its record; plan sessions get that mode's section as well. An AFK run carries
`prompt_builder.afk_prompt(record, task, prompt)`: the same base prompt, then AFK's own — its fixed
points, the ones no Prompt and no skill may change — and the project's Prompt beneath them, which is
`DEFAULT_PROMPT` where the project wrote none.
"""


def _scrub(text: str) -> str:
    return text.replace(str(_base), PLACEHOLDER).replace(str(ROOT), PLACEHOLDER)


def _section(title: str, note: str, text: str) -> str:
    return f"## {title}\n\n{note}\n\n```text\n{_scrub(text)}\n```"


def build() -> str:
    parts = [HEADER]
    for title, note, record in VARIANTS:
        parts.append(_section(title, note, prompt_builder.session_prompt(record)))
    for title, note, text in AFK_VARIANTS:
        parts.append(_section(title, note, text))
    for title, note, text in DICTATION_VARIANTS:
        parts.append(_section(title, note, text))
    return "\n\n".join(parts) + "\n"


if __name__ == "__main__":
    (ROOT / "docs").mkdir(exist_ok=True)
    (ROOT / "docs" / "prompts.md").write_text(build(), encoding="utf-8")
    print(f"wrote {ROOT / 'docs' / 'prompts.md'}")
