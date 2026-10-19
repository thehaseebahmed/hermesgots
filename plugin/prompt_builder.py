"""The prompt Gots injects into a project session's run.

One module holds the whole thing: every paragraph of the run's instructions as a private string at
the top, and ``session_prompt`` joining them for a session's record, so a reader sees exactly what
the agent is told without tracing the session bookkeeping.
"""

from __future__ import annotations

from typing import Any, Dict

from . import tasks

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
    "When the work is done and you've checked it, ship it yourself with the pull_request tool and "
    "action 'ship': it commits what's left, pushes this branch and opens a draft pull request, or "
    "pushes to the one open. Don't ask first, and don't use git push or gh for it. Write the "
    "description from the repo's pull request template when it has one (named below), else with "
    "Summary, Changes and How to test sections. The pull request stays a draft. Pass force: true "
    "only after a rebase or amend. action 'update' changes the open pull request's title or body, "
    "and 'status' reports without writing. Merging and closing are the user's decision: the tool "
    "refuses them, "
)
_MERGE_ASK = "so ask the user with clarify instead."
_MERGE_READY = (
    "and nobody is here to be asked, so say in the pull request that it is ready to merge and "
    "leave it a draft."
)

# The same condition as _PR_INSTRUCTIONS: only code sessions get it.
_DONE_INSTRUCTIONS = (
    "Two things the run's prompt emphasises once the work is done: don't share the pull request url "
    "or the commit message in your reply — the pull_request result and the session's pull "
    "request list already surface them where the user sees them. And before you finish, update your "
    "todo list to its final state: every item completed, or cancelled where it was dropped."
)
# Added whenever a session has worktrees: the working rhythm, so a long run reads as work in
# progress rather than a hang, and a short one doesn't narrate every edit. Fixed text, so the prompt
# cache holds. The app's mock repeats it; keep them the same.
_PROGRESS_UPDATES_INSTRUCTIONS = (
    "Keep the user in the loop as you work, at a working rhythm rather than a running commentary. "
    "Post a short update between checkpoints — what landed, what you're doing next — so a long "
    "stretch of tool calls never reads as a hang. Keep the todo list current as you go: mark items "
    "done as they land and add what you discover. When something keeps failing, say what you tried "
    "and what you now think is wrong before the next attempt. Thinking out loud while you plan is "
    "welcome. Don't narrate each edit, read or command — the tool calls already show those; keep "
    "what you do say technical enough to follow the work without spelling out every implementation "
    "detail."
)


# Added to an AFK session's run instead of a user (ADR 0011, ADR 0013): the issue was planned before
# the user left, so this is implementation, not design, and there is nobody to ask. Fixed text, so
# the prompt cache holds across the session's turns; the issue is named in one line beside it rather
# than quoted, because the agent can read it from GitHub itself.
_AFK_INSTRUCTIONS = """You are working while the user is away, and this issue was planned before they left: it is marked as ready for work, so its text is the spec and its design is settled. Implement it — don't re-open the plan. Where the issue is silent, take the smallest option that fits and say what you chose; where the code contradicts the plan, the code is right, and the pull request says where you departed from it. This session works one issue: this one. Don't go looking for others in the tracker.

The workflow:
1. Read. Fetch the issue and every comment as it says above if you haven't already, then read the code and the tests it touches. The issue is the source of truth for what to do, not your memory of it, and a plan you didn't read is one you're guessing at.
2. Plan. Your todo list is the plan: what changes, in what order, each checkpoint leaving the repo building and worth committing. Keep the change as small as the issue allows and add nothing it didn't ask for.
3. Implement. Write the test first where the repo has tests, and follow the repo's own conventions — its AGENTS.md, its lint and format settings, the commands its README documents. Commit in checkpoints, in Conventional Commits.
4. Verify. Run the repo's own gates before you ship — typecheck, lint, tests, build, whatever it documents — and fix what you broke. A suite you didn't run isn't passing.
5. Ship. The pull request tool, action 'ship', as described above: one draft pull request whose body says what changed, how you verified it and which issue it implements, with `Closes #<number>` once the work is complete.
6. Report. A short closing reply: what landed, what you checked, what's left.

The rules:
- Never ask the user anything, and never leave a plan waiting for approval: there is nobody to answer or tap it. Decide, and record the decision where the work shows why.
- When a decision isn't yours to guess, get a second opinion with delegate_task, weigh the answer, then decide. Record what you chose in the pull request or the code.
- If you can't finish, don't force it: leave the tree consistent and say where it stopped and what blocks it — in the pull request body if you opened one, else in your reply. Never leave a half-done change unexplained.
- Don't close the issue or merge anything yourself: merging the pull request is the user's decision, and `Closes #<number>` is how the issue closes with it.
- No TODOs, commented-out code, debug prints or secrets in what you commit. Never push to the default branch, and keep all work inside the worktree."""


def _pr_instructions(unattended: bool) -> str:
    return _PR_INSTRUCTIONS + (_MERGE_READY if unattended else _MERGE_ASK)


def session_prompt(record: Dict[str, Any], unattended: bool = False) -> str:
    """What the run's system prompt tells the agent: its worktrees (fixed per session), where its
    generated files go, how to keep the user in the loop as it works, how to open its pull request
    and the repos' templates and, in plan mode, the shape of the plan.
    """
    worktrees = _worktree_line(record)
    lines = [
        worktrees,
        _files_line(record),
        _PROGRESS_UPDATES_INSTRUCTIONS if worktrees else "",
        _pr_instructions(unattended) if worktrees else "",
        _DONE_INSTRUCTIONS if worktrees else "",
        _template_line(record),
    ]
    if record.get("mode") == "plan":
        lines.append(_PLAN_INSTRUCTIONS)
    return "\n".join(line for line in lines if line)


def afk_prompt(record: Dict[str, Any], task: Dict[str, Any]) -> str:
    """What an AFK session's run is told: the issue it implements, its own session's facts, then how
    to work a planned issue with nobody to ask (ADR 0011, ADR 0013).

    The issue's text isn't quoted here — the agent fetches it, and the line naming it is all that
    has to be fixed per task, so the prompt cache still holds across the session's turns.
    """
    lines = [_afk_task_line(task), session_prompt(record, unattended=True), _AFK_INSTRUCTIONS]
    return "\n\n".join(line for line in lines if line)


def afk_input(task: Dict[str, Any]) -> str:
    """The run's input: one line naming the issue and where it is, never its text (ADR 0011)."""
    url = tasks.issue_url(task)
    return f"Implement Issue #{task.get('number')}" + (f" ({url})" if url else "")


def _afk_task_line(task: Dict[str, Any]) -> str:
    repo, number = task.get("repo"), task.get("number")
    url = tasks.issue_url(task)
    where = f" ({url})" if url else ""
    read = f"gh issue view {number} --repo {repo} --comments" if repo else "the API"
    return (
        f"You are implementing {repo}#{number}{where} for the user, while they are away. "
        f"Their issue's own text isn't repeated here: read it with `{read}` (or the API) and work "
        f"from that."
    )


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
