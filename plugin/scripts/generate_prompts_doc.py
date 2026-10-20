"""Generates docs/prompts.md: every prompt prompt_builder can produce, so the words a run is
injected with are readable without starting a session. Run it from the repo root:

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

from plugin import pipeline, prompt_builder, workflows  # noqa: E402

PLACEHOLDER = "/home/agent"
BRANCH = "hermes/spry-thimble-d105"
FILES_DIR = f"{PLACEHOLDER}/files/spry-thimble-d105"

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
    "files_dir": FILES_DIR,
    "repos": [_repo("web")],
}
MULTI = {**SINGLE, "repos": [_repo("web"), _repo("api")]}

VARIANTS = [
    (
        "Single repo",
        "The common case: one worktree (the session's working directory), the library folder and "
        "the repo's pull request template.",
        SINGLE,
    ),
    (
        "Two repos",
        "A session that spans the project: every worktree is named, the primary repo's is the "
        "working directory, and both repos' templates are listed.",
        MULTI,
    ),
    (
        "A session from before library folders",
        "No ``files_dir`` on the record, so the library line is left out; everything else is the "
        "single-repo prompt.",
        {**SINGLE, "files_dir": None},
    ),
    (
        "Plan mode",
        "The plan-mode segment on top of the single-repo prompt: the shape of the plan the agent "
        "writes before anything is allowed to change.",
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

# The preset's own workflow, placed at its build stage: what a staged task's first run is told,
# which is a stage's brief rather than the project's Prompt.
STAGED = pipeline.start(
    {
        "id": "preset:staged",
        "name": "Build · Test · Review · Summary",
        "stages": workflows.from_skills("plan", ("code-review",)),
    }
)

AFK_VARIANTS = [
    (
        "An AFK run on the default Prompt",
        "A project that wrote no Prompt of its own: the fixed brief, the sentence putting it above "
        "any skill or Prompt, then ``DEFAULT_PROMPT`` — the method every untouched project works "
        "by (ADR 0027).",
        prompt_builder.afk_prompt(AFK, TASK),
    ),
    (
        "An AFK run on a project's own Prompt",
        "The same run with the project's words where the default was, which is the one part of the "
        "method it can change.",
        prompt_builder.afk_prompt(AFK, TASK, PROJECT_PROMPT),
    ),
    (
        "An AFK task in a workflow's build stage",
        "A project on a workflow: its run is told no Prompt, and its brief is the stage's own — "
        "implement the issue, then end at the gate the host runs.",
        prompt_builder.afk_prompt({**AFK, "pipeline": STAGED}, TASK),
    ),
]

HEADER = """# Session prompts

> Generated file — do not edit. Regenerate with `python3 plugin/scripts/generate_prompts_doc.py`
> (the Prompts doc workflow runs it whenever `plugin/prompt_builder.py` changes and opens a pull
> request when the doc moves).

Every project session's run carries the prompt `prompt_builder.session_prompt(record)` builds for
its record: where its worktrees are, where its generated files are filed, how it keeps the user in
the loop while it works, how it opens its pull request and which templates it follows. Plan sessions
get that mode's segment on top.

An AFK run carries `prompt_builder.afk_prompt(record, task, prompt)`: the same session facts, then
AFK's fixed brief — the points no Prompt and no skill may change — the sentence putting the brief
above both, and the project's Prompt, which is `DEFAULT_PROMPT` where the project wrote none. A task
in a workflow is briefed for its stage instead and is told no Prompt.
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
    return "\n".join(parts) + "\n"


if __name__ == "__main__":
    (ROOT / "docs").mkdir(exist_ok=True)
    (ROOT / "docs" / "prompts.md").write_text(build(), encoding="utf-8")
    print(f"wrote {ROOT / 'docs' / 'prompts.md'}")
