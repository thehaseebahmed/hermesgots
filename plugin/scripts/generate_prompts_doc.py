"""Generates docs/prompts.md: every session prompt prompt_builder can produce, so the prompt a
run is injected with is readable without starting a session. Run it from the repo root:

    python3 plugin/scripts/generate_prompts_doc.py

The Prompts doc workflow (``.github/workflows/prompts-doc.yml``) runs it whenever the builder
changes and opens a pull request when the doc moves. Absolute paths (the repo checkout and the
throwaway dirs below) are scrubbed to a placeholder, so the doc is byte-identical on every machine
and an unchanged builder produces no pull request.
"""

from __future__ import annotations

import sys
import tempfile
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

# theseus.session_folder resolves the profile home through hermes_constants, which only exists
# inside Hermes; the multi-repo Theseus variant needs it, so point it at a throwaway home.
_base = Path(tempfile.mkdtemp(prefix="prompts-doc-"))
_constants = types.ModuleType("hermes_constants")
_constants.get_hermes_home = lambda: str(_base)  # type: ignore[attr-defined]
sys.modules["hermes_constants"] = _constants

from plugin import prompt_builder  # noqa: E402

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
    (
        "Theseus mode, one repo",
        "The Theseus segment on top of the single-repo prompt: the skill to read and how a run "
        "works on this host. A single-repo session's run stays in its worktree.",
        {**SINGLE, "mode": "theseus"},
    ),
    (
        "Theseus mode, two repos",
        "The same segment, with the run folder both repos' checkpoints share.",
        {**MULTI, "mode": "theseus"},
    ),
]

HEADER = """# Session prompts

> Generated file — do not edit. Regenerate with `python3 plugin/scripts/generate_prompts_doc.py`
> (the Prompts doc workflow runs it whenever `plugin/prompt_builder.py` changes and opens a pull
> request when the doc moves).

Every project session's run carries the prompt `prompt_builder.session_prompt(record)` builds for
its record: where its worktrees are, where its generated files are filed, how it opens its pull
request and which templates it follows. Plan and Theseus sessions get their mode's segment on top.
"""


def _scrub(text: str) -> str:
    return text.replace(str(_base), PLACEHOLDER).replace(str(ROOT), PLACEHOLDER)


def build() -> str:
    parts = [HEADER]
    for title, note, record in VARIANTS:
        parts.append(f"## {title}\n\n{note}\n\n```text\n{_scrub(prompt_builder.session_prompt(record))}\n```")
    return "\n".join(parts) + "\n"


if __name__ == "__main__":
    (ROOT / "docs").mkdir(exist_ok=True)
    (ROOT / "docs" / "prompts.md").write_text(build(), encoding="utf-8")
    print(f"wrote {ROOT / 'docs' / 'prompts.md'}")
