"""The prompt Memento injects into a project session's run.

One module holds the whole thing: every paragraph of the run's instructions as a private string at
the top, and ``session_prompt`` joining them for a session's record, so a reader sees exactly what
the agent is told without tracing the session bookkeeping. The Theseus-mode segment still comes
from ``theseus.instructions`` — it creates the session's run folder as a side effect, so it stays
where that behavior lives.
"""

from __future__ import annotations

from typing import Any, Dict

# Added to the run's instructions in plan mode. Fixed per mode, so the prompt cache holds across
# the turns of one mode. The app's mock repeats it; keep them the same.
_PLAN_INSTRUCTIONS = """You are in plan mode: change nothing. Read what you need. Then, before you write the plan, settle every choice the user would otherwise be left to make: ask with the clarify tool, every question in one call, your recommended answer first. If you can't ask (no clarify tool, or no answer came), decide it yourself and record the decision under Risks and assumptions. Then make your whole final reply the plan below and stop; the user approves it before you act. It is saved to a file as written, so write it for someone who hasn't read this chat, and a plan with an open question isn't finished. Use this Markdown shape exactly:

# Plan: <short title>

## Overview
What was asked, the problem it solves and the outcome, in two to five sentences.

## Approach
The design you chose and why. One line each for the alternatives you rejected.

## Changes
One entry per file or area: its path, what changes and why, and the existing functions you'd reuse.

## Checkpoints
Split the work into checkpoints that each leave the code building and worth committing, in order. For each:
### Checkpoint N: <name>
- Commit: `type(scope): summary` in Conventional Commits form, unless the user asked for another style
- Steps: the concrete edits
- Done when: how you'd know it works

## Verification
How to test the whole change end to end: commands, what to look at, expected results.

## Risks and assumptions
What could go wrong, and each decision you made without the user: what you chose and why. Nothing here is left for the user to decide."""
# Added whenever a session has worktrees. Fixed text, so the prompt cache holds.
_PR_INSTRUCTIONS = (
    "When the work is done and you've checked it, ship it yourself with the open_pull_request tool: "
    "it commits what's left, pushes this branch and opens a pull request, or updates the open one. "
    "Don't ask first, and don't use git push or gh for it. Write the description from the repo's "
    "pull request template when it has one (named below), else with Summary, Changes and How to "
    "test sections."
)
# The same condition as _PR_INSTRUCTIONS: only code sessions get it.
_DONE_INSTRUCTIONS = (
    "Two things the run's prompt emphasises once the work is done: don't share the pull request url "
    "or the commit message in your reply — the open_pull_request result and the session's pull "
    "request list already surface them where the user sees them. And before you finish, update your "
    "todo list to its final state: every item completed, or cancelled where it was dropped."
)


def session_prompt(record: Dict[str, Any]) -> str:
    """What the run's system prompt tells the agent: its worktrees (fixed per session), where its
    generated files go, how to open its pull request and the repos' templates and, in plan mode,
    the shape of the plan."""
    worktrees = _worktree_line(record)
    lines = [
        worktrees,
        _files_line(record),
        _PR_INSTRUCTIONS if worktrees else "",
        _DONE_INSTRUCTIONS if worktrees else "",
        _template_line(record),
    ]
    if record.get("mode") == "plan":
        lines.append(_PLAN_INSTRUCTIONS)
    if record.get("mode") == "theseus":
        from . import theseus

        lines.append(theseus.instructions(record))
    return "\n".join(line for line in lines if line)


def _worktree_line(record: Dict[str, Any]) -> str:
    repos = record.get("repos") or []
    if not repos:
        return ""
    if len(repos) == 1:
        return (
            f"You are working in a git worktree of {repos[0]['name']} at {repos[0]['path']} "
            f"(branch {repos[0]['branch']}). Keep all work inside it."
        )
    lines = [
        f"- {repo['name']} at {repo['path']}" + (" (your current directory)" if i == 0 else "")
        for i, repo in enumerate(repos)
    ]
    return (
        f"You are working in git worktrees of this project's repos, all on branch {repos[0]['branch']}:\n"
        + "\n".join(lines)
        + "\nKeep all work inside them."
    )


def _files_line(record: Dict[str, Any]) -> str:
    """Where the session's generated files go, and the tool that files them. Fixed per session (the
    folder is), so the prompt cache holds across its turns; empty for a record from before it."""
    folder = record.get("files_dir")
    if not folder:
        return ""
    return (
        f"Files you make for the user — screenshots, images, charts, reports, markdown — belong in "
        f"this session's library at {folder}, not in the worktree. File each one with the "
        f"library_add tool (its path and a folder name, one level): name folders after the flow "
        f"or change the files belong to, kebab-case — library-tab for work on the library tab, "
        f"library-tab-tree-view for a follow-up change to it — not the file type, and file names "
        f"kebab-case with their extension (dashboard-light.png). The tool makes {folder}/<folder> "
        f"if it needs to, moves the file there and answers with its new path; a name that isn't "
        f"kebab-case, or a file of that name already in the folder, is an error — fix the name "
        f"and call again. Return an image's new path in a MEDIA:<path> tag so the user sees it. "
        f"Source edits stay in the worktree."
    )


def _template_line(record: Dict[str, Any]) -> str:
    from .ship import template

    found = [(repo["name"], template(repo.get("path"))) for repo in record.get("repos") or []]
    found = [(name, path) for name, path in found if path]
    if not found:
        return ""
    if len(record.get("repos") or []) == 1:
        return f"Its pull request template is {found[0][1]}."
    return "Pull request templates: " + "; ".join(f"{name}: {path}" for name, path in found) + "."
