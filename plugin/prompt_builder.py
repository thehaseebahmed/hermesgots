"""The prompt Gots injects into a project session's run.

One module holds the whole thing: every fixed paragraph of the run's instructions as a private
string at the top, and one brief per kind of stage built from the session's record
(``stage_prompt``), so a reader sees exactly what the agent is told without tracing the session
bookkeeping. A stage's own name and its skills are named into the brief rather than quoted, which
keeps the fixed text cacheable across the turns of every task.
"""

from __future__ import annotations

from typing import Any, Dict, List, NamedTuple, Optional

from . import pipeline, tasks

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
_PR_RULES = (
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

# The same condition as _PR_RULES: only code sessions get it.
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


# Added to an AFK session's run instead of a user (ADR 0011, ADR 0013, ADR 0027): the points no Prompt
# and no skill may change. How the work is carried out is the project's Prompt, told after this; the
# brief is AFK's own, so it holds whatever that Prompt says. Fixed text, so the prompt cache holds
# across the session's turns; the issue's own text rides in the run's input (`afk_input`) rather than
# here.
_AFK_INSTRUCTIONS = """You are working while the user is away, and this issue was planned before they left: it is marked as ready for work, so its text is the spec and its design is settled. Implement it — don't re-open the plan. Where the issue is silent, take the smallest option that fits and say what you chose; where the code contradicts the plan, the code is right, and the pull request says where you departed from it. This session works one issue: this one. Don't go looking for others in the tracker.

The rules:
- Never ask the user anything, and never leave a plan waiting for approval: there is nobody to answer or tap it. Decide, and record the decision where the work shows why.
- The work is verified before it ships, and the pull request ships last.
- Nothing is merged or closed by you: merging the pull request is the user's decision, and the line the tool adds closes the issue with it. Don't write the `Closes` line yourself.
- No TODOs, commented-out code, debug prints or secrets in what you commit. Never push to the default branch, and keep all work inside the worktree.
- If you can't finish, don't force it: leave the tree consistent and say where it stopped and what blocks it — in the pull request body if you opened one, else in your reply. Never leave a half-done change unexplained."""

# The points no skill and no Prompt may change: the two scope sentences below quote them.
_FIXED_POINTS = (
    "the issue is the spec, the work is verified, nobody is asked anything and the pull request is "
    "shipped last"
)

_AFK_SCOPE = (
    f"A skill or a Prompt governs method only: these rules hold whatever either says — {_FIXED_POINTS} "
    "— so neither asks the user anything, merges or closes anything, or leaves the shipping to them."
)


# The method a run is told when its project has written no Prompt of its own (ADR 0027). It is the
# project's to rewrite — the brief above is what no Prompt changes — and the host serves it, so the
# app and the device hold no copy, and a project nobody edited is still told the careful method.
DEFAULT_PROMPT = """How to work:

- Work in checkpoints. Each one leaves the tree building and is worth committing on its own, in the repo's commit style.
- Write the check that fails before the code that passes it — the test, the assertion, or whatever the repo already uses — and watch it fail for the reason you mean to fix. Then make it pass. A repo with no tests is a reason to say so, not to skip the check.
- Run the repo's own gates before you call anything done: its typecheck, lint, tests and build, whatever its README, AGENTS.md or CI names, and fix what you broke. A suite you didn't run isn't passing.
- Read your own diff before you finish, as a reviewer would, and take what you find.
- Once the change is whole, apply the skills `simplify-code` and `requesting-code-review` once over all of it, not once per file: load each with skill_view, and fix what each accepts in one pass.
- Finish with a short, human summary: what landed, what each review reported and what changed because of it, what is left and why, and one line on what the user should look at first.

A planning or TDD skill applied beside this changes how a checkpoint is built, not whether it is checked."""


# A staged task's build run is briefed as it was before the Prompt (ADR 0027): its workflow is what
# its work runs by, so the method a project's Prompt now carries stays here for the stage, and
# `_BUILD_STAGE`'s "shipping step above" is still step 5.
_STAGED_BUILD_INSTRUCTIONS = """You are working while the user is away, and this issue was planned before they left: it is marked as ready for work, so its text is the spec and its design is settled. Implement it — don't re-open the plan. Where the issue is silent, take the smallest option that fits and say what you chose; where the code contradicts the plan, the code is right, and the pull request says where you departed from it. This session works one issue: this one. Don't go looking for others in the tracker.

The workflow:
1. Read. The issue and its comments, the way the line at the top says to, then the code and the tests it touches. The issue is the source of truth for what to do, not your memory of it, and a plan you didn't read is one you're guessing at.
2. Plan. Your todo list is the plan: what changes, in what order, each checkpoint leaving the repo building and worth committing. Keep the change as small as the issue allows and add nothing it didn't ask for.
3. Implement. Write the test first where the repo has tests, and follow the repo's own conventions — its AGENTS.md, its lint and format settings, the commands its README documents. Commit in checkpoints, in Conventional Commits.
4. Verify. Run the repo's own gates before you ship — typecheck, lint, tests, build, whatever it documents — and fix what you broke. A suite you didn't run isn't passing.
5. Ship. The pull request tool, action 'ship', as described above: one draft pull request whose body says what changed, how you verified it and which issue it implements, `#{issue}`. Don't write the `Closes` line yourself: the tool adds it.
6. Report. A short closing reply: what landed, what you checked, what's left.

The rules:
- Never ask the user anything, and never leave a plan waiting for approval: there is nobody to answer or tap it. Decide, and record the decision where the work shows why.
- When a decision isn't yours to guess, get a second opinion with delegate_task, weigh the answer, then decide. Record what you chose in the pull request or the code.
- If you can't finish, don't force it: leave the tree consistent and say where it stopped and what blocks it — in the pull request body if you opened one, else in your reply. Never leave a half-done change unexplained.
- Don't close the issue or merge anything yourself: merging the pull request is the user's decision, and the line the tool adds closes the issue with it.
- No TODOs, commented-out code, debug prints or secrets in what you commit. Never push to the default branch, and keep all work inside the worktree."""

# What no skill may change: every stage states it, whatever its kind and whether or not it names a
# skill, because the fixed points are AFK's and not the workflow's.
_SKILL_SCOPE = (
    f"A skill governs method only: the fixed points hold whatever it says — {_FIXED_POINTS} — so no "
    "skill unlocks the gate, asks the user anything or leaves the shipping to them."
)

# A staged task's build run (ADR 0018, ADR 0020): it stops at a gate the host runs, so there is
# nothing for it to ship. Fixed text per stage, so the prompt cache holds; the stage's name and its
# skills are named beside it rather than quoted.
_BUILD_STAGE = """This task is worked in stages, and you are in its {name} stage. The shipping step above is not yours: don't ship. Build the change, verify it, and leave the pull request to the stage that follows.

When the work is committed and the repo's gates pass for you, call the afk_gate tool with the commands you mean to be checked by — one list, each command as one shell line: whatever the repo documents as its own gates, and the tests it has. A project of more than one repo names the repo beside each command instead of a plain line, since each repo checks itself and the host runs it there. Then end the run. The host runs them in the worktree, reads their exit codes and decides; the pull_request tool refuses 'ship' from this stage, so trying only wastes a turn. Nothing is critiqued that never reached the gate, and a gate that fails — a command exiting non-zero, a tree left uncommitted, no commits beyond the base — stalls the task for the user to look at, naming the command that failed. Your last reply says what you built, what you checked and what the gate answered."""

# A one-run workflow's only stage (ADR 0020): the same run implements, gates itself and ships.
_ONE_RUN_STAGE = """This task is worked in one run, and this is it: implement the issue, verify it, and ship the draft pull request, all here. Do the shipping step above once the work is done and checked — the pull_request tool is yours to call from this stage.

Call the afk_gate tool with the commands you mean to be checked by — one list, each command as one shell line: whatever the repo documents as its own gates, and the tests it has. A project of more than one repo names the repo beside each command instead of a plain line, since each repo checks itself and the host runs it there. The host runs them in the worktree and reads their exit codes: a gate that fails — a command exiting non-zero, a tree left uncommitted, no commits beyond the base — stalls the task for the user, naming the command, so fix what it names and call it again before you ship. Your last reply says what you built, what you checked and what the gate answered."""

# The stage that opens the pull request (ADR 0020): the review, and the one run that may ship.
_REVIEW_STAGE = """This task has been built and gated, and you are in its {name} stage: the pull request is yours to open, and nothing reviews the work again before the user does. Review it as work you did not do — this transcript is the author's own account of it, and its commits are in the worktree.

Weigh what you find, then take what the review accepts and fix it in one pass, in the worktree, committing as you go: there is no second review, and the user's own read of the pull request is the next one.

Report what the review found with the afk_findings tool before you ship: one call per skill it applied, in the order the stage names them, with that skill's findings — each a title and, where it helps, a detail — and an empty list for a skill that found nothing. The details sheet counts them, so a review that found five things and one that found nothing don't read the same.

Then ship once with the pull_request tool, action 'ship', and write its body from the repo's template with a short section on what the review found and what changed because of it. Leave the Closes line to the tool, and merging or closing to the user. Don't ask the user anything: nobody is here to answer."""

# A stage after the shipping one (ADR 0020): the draft is open, so its run writes the wrap-up and
# changes nothing the user is about to read.
_SUMMARY_STAGE = """This task's work is a draft pull request already, and you are in its {name} stage: write the wrap-up for the user to read when they come back — what landed, what you checked and what is left. Change nothing: the pull request is open, and the work in it is what they are reading. Don't ship."""


class StageWords(NamedTuple):
    """A step's own words: what its run is doing, and the brief standing in for its skills."""

    doing: str
    brief: str


_WORDS = {
    pipeline.BUILD: StageWords("implementing", _BUILD_STAGE),
    pipeline.CRITIQUE: StageWords("reviewing the build of", _REVIEW_STAGE),
    pipeline.DONE: StageWords("wrapping up", _SUMMARY_STAGE),
}


def _words(kind: Optional[str]) -> StageWords:
    """The words of the step a task is in, building for a step that has none of its own."""
    return _WORDS.get(kind or pipeline.DONE, _WORDS[pipeline.BUILD])


def _pr_instructions(unattended: bool) -> str:
    return _PR_RULES + (_MERGE_READY if unattended else _MERGE_ASK)


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


def afk_prompt(record: Dict[str, Any], task: Dict[str, Any], prompt: Optional[str] = None) -> str:
    """What an AFK session's first run is told: the issue it implements, its own session's facts,
    AFK's fixed rules, and then the Prompt its project works by (ADR 0011, ADR 0027).

    The brief is AFK's own, the points no Prompt may change; everything about how the work is done
    is the Prompt — the project's words, or ``DEFAULT_PROMPT`` when it has written none. This is the
    run that opens with the issue, so the line naming it says its text is in that message and only
    the comments are left to read — the text rides in the input (``afk_input``) and not here, so the
    prompt cache still holds across the session's turns. A staged task is briefed for the stage it
    starts in instead (``stage_prompt``), and is told no Prompt: its workflow is what its work runs
    by.
    """
    if pipeline.read(record.get("pipeline")) is not None:
        return stage_prompt(record, task, handed=True)
    lines = [
        _handed_line(task, pipeline.BUILD),
        session_prompt(record, unattended=True),
        _AFK_INSTRUCTIONS,
        _AFK_SCOPE,
        prompt or DEFAULT_PROMPT,
    ]
    return "\n\n".join(line for line in lines if line)


def stage_prompt(
    record: Dict[str, Any],
    task: Dict[str, Any],
    base: Optional[str] = None,
    *,
    handed: bool = False,
) -> str:
    """What a staged task's run is told: the issue it works, its own session's facts, the stage it
    is in, the skills that stage applies in order, and — for a loop's next round — what failed.

    Every stage of a workflow is briefed the same way, whatever its name: a build implements and
    ends at the gate, the shipping stage reviews and opens the draft, and a stage after it wraps up
    (ADR 0020). ``base`` is the branch the pull request is against, and only the shipping stage is
    told it. ``handed`` says this run's own input carried the issue's text — true of the run that
    starts a task and false of every run after it, whose input names the stage and the issue.
    """
    staged = pipeline.read(record.get("pipeline"))
    kind = pipeline.kind(staged) or pipeline.BUILD
    ships = pipeline.ships(staged)
    lines = [
        _handed_line(task, kind) if handed else _task_line(task, kind),
        session_prompt(record, unattended=True),
        _STAGED_BUILD_INSTRUCTIONS.format(issue=task.get("number"))
        if kind == pipeline.BUILD
        else "",
        _base_line(base) if base and ships else "",
        _steps_line(pipeline.stage_steps(staged), ships),
        _SKILL_SCOPE,
        _retry_line(pipeline.retry(staged)),
        _brief(staged),
    ]
    return "\n\n".join(line for line in lines if line)


def afk_input(task: Dict[str, Any]) -> str:
    """The first run's input: the issue itself — its title, its body verbatim and the link — so what
    the change is judged against is in front of the agent rather than something it goes and fetches
    (ADR 0027). An issue with no body still reads as the block, with its description empty.
    """
    lines = [f"Title: {task.get('title') or ''}", "Description:"]
    body = task.get("body") or ""
    if body:
        # Verbatim, however long: the issue is the spec, and a truncated one makes a wrong plan.
        lines.append(body)
    return "\n".join(lines) + "\n\n" + _issue_link(task)


def stage_input(task: Dict[str, Any], name: Optional[str]) -> str:
    """A later stage's input: one line naming the stage and the issue, never the issue's text."""
    if not name:
        return f"Continue #{task.get('number')}" + _opened(tasks.issue_url(task))
    return f"{name} #{task.get('number')}" + _opened(tasks.issue_url(task))


def _brief(record: Optional[Dict[str, Any]]) -> str:
    """How the stage a task is in is briefed, in its own name, when it names no skills at all.

    The kind is what decides it, not the name a user gave the stage: a stage before the shipping one
    builds, the shipping stage reviews and ships, and one after it wraps up. A workflow of a single
    shipping stage is one run, which does all three.
    """
    name = pipeline.stage_name(record) or ""
    if pipeline.single_stage(record or {}):
        return _ONE_RUN_STAGE.format(name=name)
    return _words(pipeline.kind(record)).brief.format(name=name)


def _steps_line(steps: List[str], ships: bool) -> str:
    """The skills the stage applies, in order, named once each rather than quoted, and where: the
    stage that ships reads the diff, so there each one is applied to that, and every other stage is
    told how that part of the work it goes on to write is done.
    """
    if not steps:
        return ""
    use = "apply it to the diff" if ships else "follow it for how that part of the work is done"
    if len(steps) == 1:
        name = steps[0]
        return (
            f'This stage follows your skill "{name}": call skill_view(name="{name}") before you '
            f"start, and {use}."
        )
    named = ", ".join(f'"{name}"' for name in steps)
    return (
        f"This stage applies these skills in order, each once: {named}. Load each with skill_view "
        f"before you use it, and {use}."
    )


def _retry_line(retry: Optional[str]) -> str:
    """What a loop's next round is told about the round before it: the command and its exit code."""
    if not retry:
        return ""
    return (
        f"The round before this one failed its gate: {retry}. Fix what that names, run the gate "
        f"again, and end the run once it passes."
    )


def _task_line(task: Dict[str, Any], kind: str) -> str:
    """How the issue is named to a run whose input only names it: it has to read the issue itself."""
    ref = _issue_ref(task)
    return (
        f"{_opening(kind, ref)} Their issue's own text isn't repeated here: read it with "
        f"`{ref.read}` (or the API), since it is what the change is judged against."
    )


def _handed_line(task: Dict[str, Any], kind: str) -> str:
    """How the issue is named to the run that opens with it: only its comments are left to read."""
    ref = _issue_ref(task)
    return (
        f"{_opening(kind, ref)} The issue's own text is in the message this session opened with; "
        f"read its comments with `{ref.read}` (or the API) when the work needs them, since it is "
        f"what the change is judged against."
    )


def _opening(kind: str, ref: IssueRef) -> str:
    """Who the run works for and which issue it works: the sentence both briefs open with."""
    return f"You are {_words(kind).doing} {ref.where}{ref.url} for the user, while they are away."


def _base_line(base: Optional[str]) -> str:
    if not base:
        return ""
    return f"The work is against the base branch {base}."


class IssueRef(NamedTuple):
    """An issue as a prompt names it: ``repo#number``, where to open it, and how to read it."""

    where: str
    url: str
    read: str


def _opened(url: Optional[str]) -> str:
    """The issue's url in parentheses, for a prompt that names the issue beside it."""
    return f" ({url})" if url else ""


def _issue_link(task: Dict[str, Any]) -> str:
    """The issue as a Markdown link, or its number alone for a row nothing answered a url for."""
    number, url = task.get("number"), tasks.issue_url(task)
    return f"[Issue #{number}]({url})" if url else f"Issue #{number}"


def _issue_ref(task: Dict[str, Any]) -> IssueRef:
    repo, number = task.get("repo"), task.get("number")
    read = f"gh issue view {number} --repo {repo} --comments" if repo else "the API"
    return IssueRef(f"{repo}#{number}", _opened(tasks.issue_url(task)), read)


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
