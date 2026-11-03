# A user's message draws its own markdown, on the bubble

**The user's own message is drawn by the reply's renderer, not as the characters it was typed in.** It
had been the one part of a thread where a person could see their own syntax: a message carrying a
code span, a fenced block, emphasis or a link showed the backticks and the asterisks, while the reply
under it — read from the same host, on the same screen, through `Markdown` — drew them. A note that
pasted a stack trace or named a file in backticks read as though the app had not taken it in. What the
message keeps is the bubble: right aligned, the cue for who spoke, the primary fill while it hasn't
gone through (ADR 0034, and the dimmed bubble a queued or refused one wears is ADR 0071).

**The words are drawn by the reply's renderer, on the bubble's own fill.** `Markdown` takes a `tone`
— `page` for a reply on the app's background, `fill` for the user's words on a bubble of the app's
own colour — and the renderer owns every class that tone changes: a code span and a fence are a wash
of `currentColor`, and a fence's label and the icon beside it a shade of it, rather than `bg-muted`
and the muted grey. That is what makes one rule work on the primary bubble and on the muted one a
held message wears: both fills are a colour the muted grey sits at the same lightness as, so a block
of code would otherwise be invisible on one and its label illegible on the other. The
bubble keeps `whitespace-pre-wrap`, which the renderer's elements inherit, so a two-line note stays
two lines. Markdown draws inside that rule rather than replacing it.

**One component draws the user's words, wherever a thread shows them.** `UserBubble` owns the
bubble's fill, its padding, the whitespace rule and the `fill` tone, and the message, each steer the
reply was split around and the Moved marker all call it. The marker was the one that would have gone
wrong: it draws the whole message it moved, so a message that reads as markdown in its thread would
have read as backticks in Main the moment triage moved it. A held or queued message is the same
words, so chat-next's own rows draw them through `Markdown` in the same tone while they wait; they
keep the muted bubble they wear, which is theirs and not the thread's. What does **not** move is a
card's preview of a thread's opener (`thread-card.tsx`): it clamps to four lines, a clamp needs one
box rather than a tree of blocks, and the same bubble may be drawing the chat's title rather than a
message at all, so it stays characters (ADR 0082 settles which words go in that bubble; this
decision only says how a message in a thread is drawn).

**A typed line break stays, and a block boundary is not a line break.** On the bubble the renderer's
wrapper is `whitespace-normal` with `[&_*]:whitespace-pre-wrap`, and the bubble itself keeps
`whitespace-pre-wrap` for the `Suspense` fallback's sake. Normal on the wrapper matters because
react-markdown leaves a newline between one top-level block and the next: under an inherited pre-wrap
that newline paints a blank line nobody typed, on top of the gap the blocks already get. Pre-wrap on
the elements is what keeps the breaks inside a paragraph, so a two-line note stays two lines.

**Both thread renderers draw it.** `message-item.tsx` is the row every conversation draws — a chat's,
a coding session's, a delegated agent's sub-thread — and `chat-next/page.tsx` is the dev route whose
markup the chat-next tests read. The screen behind the Developer switch draws the same `MessageItem`,
with its queued and held rows in the file beside it. All of them now show the user's words the same
way, so a message cannot flip from its syntax to its rendering as it moves between surfaces.

## Considered options

- **Inline markdown only** — emphasis, a code span, a link, no blocks. Rejected: a pasted fence would
  still show its own backticks, which is half the report, and it is a second renderer to keep in step
  with the reply's.
- **Draw a message the way a reply is drawn** — on the page, in no bubble. Rejected: the bubble is
  what makes a thread read as a conversation, and a message is the part of it that is not the agent's.
- **Render markdown only where a message looks like markdown**, and leave a plain note its exact
  characters. Rejected: which of two renderings a message gets would hang on a heuristic, and one
  stray character would flip its line breaks with it.

## Consequences

- Typed syntax is now interpreted. A message whose text really holds a leading `#`, a `**` pair or an
  underscore pair reads as markup, and the way out is a fenced block or a backslash.
- A message can draw an image where it used to show a URL, since `MediaImage` is part of the renderer's
  component set: a pasted `data:` image URL becomes a picture in the bubble.
- The bubble's words come from the app's lazy renderer chunk, memoized block by block like a reply. A
  thread holding a message now waits on that chunk rather than drawing text at once, and the plain-
  text fallback holds the message's place until it lands. A chunk that *fails* is the renderer's own
  problem, and it was already the reply's: the deferred work in `fixes.md` records it rather than
  papering over it here.
- The whitespace pair is the rule that keeps line breaks without inventing them, so a later change to
  the bubble's styling has to keep both halves: drop the elements' pre-wrap and every message
  collapses to its paragraphs; drop the wrapper's `whitespace-normal` and every message gains a blank
  line between its blocks.
