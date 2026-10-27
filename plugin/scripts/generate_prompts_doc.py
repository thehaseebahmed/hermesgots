"""Generates docs/prompts.md: the prompts a session is told, so the words a run is injected with
are readable without starting a session. The staged task's own briefs are left out — they are
briefed for a workflow's stage and named under `## User's Workflow` — and the doc carries the shapes
a project session and an AFK run are given. Run it from the repo root:

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

from plugin import prompt_builder  # noqa: E402

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
        "The common case: the base prompt — `# You are Gots!`, then `## Tools` with its "
        "`### library_add` and `### pull_request` subsections — and last `## Current Session` "
        "naming its worktree, its pull request template and the directory throwaway work goes in.",
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

HEADER = """# Session prompts

> Generated file — do not edit. Regenerate with `python3 plugin/scripts/generate_prompts_doc.py`
> (the Prompts doc workflow runs it whenever `plugin/prompt_builder.py` changes and opens a pull
> request when the doc moves).

Every prompt is told in the same sections, in the same order. `# You are Gots!` opens the base prompt,
and `## Tools` under it gives each tool the run can use a subsection of its own — `### library_add`
for the files it makes, `### pull_request` for shipping the work — followed by how to keep the todo
list and the user in step. Then comes the mode: `## Plan mode` for a planning session, `## Away From
Keyboard` for an AFK run, with `## User's Workflow` beneath it. Last is `## Current Session`, with
everything only this session knows: the issue or stage it works, its worktrees, its repos' pull
request templates and the directory throwaway work goes in. The fixed sections come first so two runs
share their opening (ADR 0028).

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
    return "\n\n".join(parts) + "\n"


if __name__ == "__main__":
    (ROOT / "docs").mkdir(exist_ok=True)
    (ROOT / "docs" / "prompts.md").write_text(build(), encoding="utf-8")
    print(f"wrote {ROOT / 'docs' / 'prompts.md'}")
