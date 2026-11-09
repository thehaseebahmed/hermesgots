# A reply is written as markdown, because the app draws it as markdown

Replies came back as one block of prose: a long answer with no paragraphs to break it, no list where
there were four findings, a command left as a bare word in a sentence. The thread draws a reply
through `react-markdown` (`app/src/components/chat/markdown.tsx`), with `ul` a disc list and `ol` a
decimal one, so nothing was lost on the way in — the reply never held any markdown to draw.

The cause was in the prompt, and it was the host's. Hermes gives every `api_server` run a platform
hint (`agent/prompt_builder.py`): *"You're responding through an API server. The rendering layer is
unknown — assume plain text. No markdown formatting (no asterisks, bullets, headers, code fences).
Treat this like a conversation, not a document."* That hint is right about an unknown renderer and
wrong about this one, and every Gots run is an `api_server` run. Nothing the plugin said contradicted
it: `prompt_builder`'s sections, the plan shape and AFK's brief are all silent on formatting, and a
grep for "markdown" across the prompts the plugin writes found one line, about a table's cells.

**So the plugin tells every session how a reply is written** (`replies.py`, the section
`gots_replies`): that the app draws a reply as markdown and the plain-text default does not hold
here, then the shapes — paragraphs with a blank line between them, a list for three or more points
or for steps in order, a code span for a command or a path and a fenced block for a longer snippet, a
heading only where a long reply needs scanning, and a short answer kept short. A model handed two
instructions needs the contradiction resolved in words; leaving it to prompt order would be a coin
toss it could not see.

**It is a system-prompt section, not a line in `prompt_builder`.** A plain chat has no worktree, so
`session_prompt` is never built for it and its `instructions` carry only the app's own hint: every
line added to `prompt_builder` would reach coding sessions and no chat. A registered section reaches
both, and AFK's own run with them. It is the seam `openui`'s library and a routine's delivery already
use, and the host takes it — a session's prompt from this host carries `## Plugin Context` sections
already. Hermes renders sections in the volatile tail, after the stable platform hint
(`agent/system_prompt.py`), so the rule is the last thing a run is told about formatting rather than
something said before it.

Four things follow, and each is a price worth naming:

- **A section is frozen when the session starts.** A chat already open keeps the words it was
  started with and goes on writing plain replies until a new chat opens; Hermes restores the frozen
  bytes on resume and never rewrites them.
- **A host without the call gets no rule.** `register_section` answers `False` where this Hermes
  predates `register_system_prompt_section` or refuses the section, and the plugin serves every
  route as it did. Those bots keep the plain replies rather than losing a feature.
- **It is charged on every turn.** About seven hundred characters ride in every session's prompt, on
  a section capped at four thousand, past which the host drops a section whole.
- **It is guidance, not enforcement.** The model can still answer in one block; what changes is that
  it is now told markdown once per session and told that nothing above it disagrees.

Two alternatives were turned down: a renderer rule that turns a lone newline into a paragraph break,
which would invent structure the model did not write and would change how the user's own messages
are drawn (the user's choice); and a per-bot switch for how replies are formatted, which is a setting
nobody asked to change back.

`tests/test_replies.py` holds the section's words to the shapes it asks for, holds it under the
host's cap, and checks that a host without the call still gets `False` rather than a raise.
