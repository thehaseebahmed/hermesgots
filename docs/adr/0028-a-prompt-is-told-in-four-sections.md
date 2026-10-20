# A prompt is told in four sections, the fixed ones first

Every prompt Gots injects was a flat list, built in whatever order the pieces were added: the worktree
line first, then the library folder, the working rhythm, the pull request rules and the done block,
then — for an AFK run — the brief and the project's Prompt. The first line was always the thing that
differs most between sessions, a path and a branch, so two runs of the same bot shared no opening
tokens at all. Nothing was wrong with the words; the shape was.

So a prompt is now told in named sections, always in the same order:

- `## You are Gots!` — who is being addressed, the two tools every session can use (`library_add`,
  `pull_request`) and the rules for them, the working rhythm, the done block, and the one precedence
  rule. No path, branch, repo or issue appears here.
- `## Plan mode` — the plan's shape, for a session in plan mode alone.
- `## Away From Keyboard` — AFK's opening and, for a run of its own, the fixed points no Prompt and no
  skill may change.
- `## User's Workflow` — the project's Prompt (or `DEFAULT_PROMPT`), inside the AFK section, or a
  staged task's workflow steps and stage brief in its place.
- `## Current Session` — the issue or stage the run works, its worktrees, its library folder and its
  repos' pull request templates. Everything that varies, last.

The order is the decision, and the last section is what makes it hold: nothing that changes per
session sits above `## Current Session`, so every session's prompt opens with the same bytes, and two
AFK runs of different projects stay identical past `## Away From Keyboard`.

Four things followed from having sections, and each was a choice:

- **The precedence rule is said once.** It was said three times — in the brief's scope sentence, in the
  staged brief's own scope sentence, and in `DEFAULT_PROMPT`'s own paragraphs — and each named a
  different pair of layers. The first section now carries one sentence: everything in the prompt holds
  whatever a skill or a User's Workflow says, because a skill changes how the work is done and never
  whether it is checked. The briefs lost their copies.
- **The merge sentence is one line.** It had two tails, "ask the user with clarify" where someone is
  present and "say it is ready to merge" where nobody is — a choice that made an AFK run and a session
  with the user present share nothing before it. One sentence covers both: say in the pull request
  that it is ready to merge and leave it a draft. Whether anyone is there to answer changes nothing
  about what to do; a user who is present can answer that question in chat anyway.
- **AFK's opening is written once.** The one-run brief and the staged build brief opened with the same
  paragraph word for word, so the section holds it once and each shape supplies only what follows.
- **The library rule names no folder.** It used to carry `files_dir` three times. The rule is
  `## You are Gots!`'s, the folder is a session fact, and the rule points at `## Current Session` for
  the path, which names it once.

What this buys is worth stating honestly. Hermes appends a run's `instructions` to the end of the
system message and marks them "injected at API-call time only, never cached"
(`agent/system_prompt.py`), and its cache breakpoints sit on the stable prefix and on the end of that
message. So on a provider with implicit prefix caching — OpenAI, Gemini and their like — a shared
opening inside `instructions` is a real hit; on Anthropic it is not, because the breakpoint covers the
whole system message and any difference in the tail misses it. The order is still the right one, since
it is the order Hermes uses on its own prompt (stable, context, volatile), and a section a reader can
find is worth having whatever a provider caches. What it is not is a guarantee.

A plain chat is untouched: it sends no `instructions` at all, so nothing here reaches it. The shared
opening is shared by project sessions and their AFK runs, which is where the tokens are.

The sections are what `docs/prompts.md` shows, since it renders the prompts as they are built, and
`tests/test_afk_prompt.py`'s `SectionTests` pins the order and the shared opening — a test that two
runs of different projects open with the same bytes is the one that fails if a path ever creeps back
above `## Current Session`.
