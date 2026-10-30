# A working reply's three rows stand thought, tools, status — muted, with the count the only blue

Status: grilled 2026-10-30, every decision settled and recorded in
[ADR 0070](adr/0070-the-status-line-is-muted-and-the-count-is-the-only-blue.md), which amends ADR 0066
and ADR 0069, with the glossary's *Live cluster* entry written alongside and *Thinking*, *Work row*
and *Status line* amended and *Subagent line* renamed *Subagent count*. Published as #694 with tickets
#695 to #698; the build order at the end is the tickets' shape when implementation starts. #694 is
blocked by the gate issue (#700) that the docs pull request carrying this file (#699) closes — work
starts on that merge. The spec carries `ready-for-agent` and the tickets stay bare, so the agent claims
the spec and works the graph in order.

## Problem Statement

A reply that is working says so in two places, in the colour the app keeps for what the reader can act
on, and one of its rows is in the wrong place.

The thought row and the status line draw the same fact — the turn is working — in the same accent,
with the same spinner, one above the other. Neither holds anything to press, while the one thing in
that cluster that can be pressed, the count of subagents at work, sits at the bottom in the quieter
info blue. The accent therefore points at nothing a reader can do, and the pressable thing is the least
visible.

Before its first word of thinking arrives a turn wears a row with no words in it: a spinner over
nothing, offering no tap, placed behind its last call. It is the one place the thread draws "a reply's
work" and means "no work to read yet", and because it is placed behind the call it breaks the order the
rows otherwise keep — the row that says the turn is thinking stands *below* the tool row it is about,
so the foot of a working reply reads tools-then-thinking.

The loaders double up for the same reason. A turn with a thought row arriving and subagents at work
turns two spinners in about sixty pixels, which reads as two jobs going wrong rather than one reply
working, and a reply waiting on the reader turns none at all even when its subagents really are still
working — the one case where something *is* progressing says so nowhere.

## Solution

The rows a working reply ends on are three, and they stand in one order: the thought row, the tool
group's row, then the status line.

The thought row draws nothing until a word of thinking arrives. While its words arrive it turns a
loader beside the literal word "thinking", both in the row's own muted colour, and the status line
stays out of it. A turn with no thought row is said by the status line instead, in the rotating word it
already wears — so a working turn says it is thinking in exactly one place, never two.

The status line and its loader are muted, like the rows above it. Its words are the only ones that
rotate. It says nothing while a thought row above says the turn is thinking, and nothing while a call
runs, save the count of subagents at work. When the turn waits on the reader its wait words take the
place of the busy words with the loader still turning beside them. A failed or stopped reply draws no
status line at all: its error or "Stopped" stands in that place.

The count of subagents is the status line's own: a suffix at the end of its words while the turn works
or waits, and its only words once the turn is done and its subagents still run. It is the one thing in
the cluster in the info blue, and a loader wears that blue only when it turns for the count alone. One
loader turns at a time.

Nothing already drawn moves. A thought row that streamed a minute ago stays where it streamed, above
the call it led into; the order governs the live cluster at the reply's foot, and the status line
stands once, under the reply's last words.

No app code changes with this spec: it is published with its ADR, its glossary entries and its
tickets, and the tickets build it.

## User Stories

1. As someone watching a bot work, I want the thought row to say the word "thinking" while its words
   arrive, so that I know which row is working without it borrowing the footer's mood.
2. As someone reading a reply before its first word of thinking arrives, I want no empty row drawn, so
   that the thread does not show me a row with nothing in it.
3. As someone reading that same moment, I want the status line to say the turn is working, so that the
   turn is visible from its first moment anyway.
4. As someone who scrolls back through a reply, I want the rows I already read to stay where they
   streamed, so that a long answer is not rearranged under me.
5. As someone reading a working reply, I want exactly one place naming what it is doing, so that two
   rows never claim the same moment.
6. As someone watching a reply think, I want the thought row's loader and words in the row's own muted
   colour, so that the loudest colour in the thread is not spent on a row I cannot press.
7. As someone watching the status line, I want its words and loader muted too, so that the cluster
   reads as one quiet block of work rather than a highlighted footer.
8. As someone reading the status line, I want its words to be the only ones that rotate, so that the
   rotating word means "this is the live line" and nothing else.
9. As someone whose turn is thinking with no thought row yet, I want the status line to wear the
   rotating thinking word, so that the mood still moves while the turn works.
10. As someone whose bot is waiting on me, I want the wait words to take the busy words' place, so
    that the line says what I must do rather than what the bot is doing.
11. As someone whose bot is waiting on me, I want a loader to keep turning beside those wait words, so
    that the line still reads as live rather than as a stall.
12. As someone whose bot waited and then carried on, I want the same loader and the same place when it
    resumes, so that nothing on the line jumps.
13. As someone reading a reply that failed, I want no status line at all and the error standing in its
    place, so that a broken reply does not wear a working footer.
14. As someone reading a reply the host stopped, I want "Stopped" standing where the line would be, so
    that the end of the turn is said plainly.
15. As someone watching a call run, I want the tool group's row to be the only thing saying it, so
    that the same call is not named twice on one screen.
16. As someone with a call running and subagents at work, I want the count to keep its place on the
    line, so that a delegated job stays visible while the reply runs its own work.
17. As someone with subagents at work and nothing else going on, I want the count to be the status
    line's only words, so that the foot of the thread still shows one row rather than a row that
    appears and disappears.
18. As someone reading the count, I want it in the info blue, so that the one thing I can press looks
    like the one thing I can press.
19. As someone watching a working turn, I want one loader at a time, so that two spinners never read as
    two jobs.
20. As someone whose turn is done and whose subagents still run, I want the count's loader in blue,
    alone, so that I can tell the work it turns for is the count itself.
21. As someone reading a reply with a thought row and a tool row, I want the thought row above the call
    it led into, so that the working-out reads over the work it led into.
22. As someone whose reply thinks, calls, writes a paragraph, thinks again and calls again, I want that
    order kept per cluster and one status line under the reply's last words, so that the thread reads
    as the turn happened.
23. As someone reading a reply with a failed call, I want its reason to stay dented under the row it
    explains, so that a failure never drifts below the status line.
24. As someone opening a thread on a slow link, I want "Catching up…" where the reply would work,
    unchanged, so that a first read still looks alive.
25. As a screen reader user, I want the thought row's name and its sheet's heading to stay
    "Thinking…", so that the row I open is still called what it is.
26. As a screen reader user, I want the loaders left out of what I hear and the lines' words announced
    when they change, so that nothing floods my ears.
27. As someone who asked for reduced motion, I want every loader drawn but still, so that the rows say
    they are working without anything moving.
28. As someone reading a chat, a delegated agent's sub-thread or a coding session's thread, I want the
    same three rows drawn the same way, so that the app has one account of a reply's work.
29. As someone reading the app on either chat screen, I want the same three rows, so that the two
    screens cannot drift on what a working reply looks like.
30. As someone whose reply has no subagents at all, I want no count and no placeholder for one, so that
    the line says only what is happening.
31. As a maintainer, I want the order stated in one rule, so that a fourth row cannot be added by
    accident in one screen and not the other.
32. As a maintainer, I want the ADR, the glossary and the agent guide to name the order and the
    colours, so that the next reader does not reintroduce the accent loader or the empty row.
33. As a reviewer, I want no new dependency, no storage change and no plugin change, so that this
    ships as a look and a rule.

## Implementation Decisions

**One order, stated once.** The three rows are the thought row, the tool group's row, and the status
line, in that order, and the order is a rule of the live cluster at a reply's foot rather than of the
whole transcript. The rule is written where the reply's parts are placed, so both chat screens and a
delegated agent's sub-thread inherit it from one place; nothing reorders rows inside the transcript
that have already streamed. The empty row a turn wears before its first word of thinking stops being
drawn at all, which is what removes the order's one exception.

**The thought row owns its word.** While its words arrive the row says the literal word "thinking",
and neither the word nor the loader beside it is drawn from the busy-word pool; the row's muted colour
is the whole of its look. Its accessible name and its sheet's heading stay "Thinking…", and its
measured label ("Thought for 12s", "Thought it through") is unchanged. The pending state — a loader
over no words, offering no tap — is removed, along with the truth it carried that the thread names
thinking from a turn's first moment; the status line carries that moment now.

**The status line is muted and keeps one loader.** Its words and the loader beside it take the row's
muted colour in every state, the rotating word included. The wait words take the busy words' place
rather than standing beside them, and they keep the loader: a waiting turn is still a live line. A
reply whose error is shown, or that was stopped, draws no status line; the error or "Stopped" stands
where it would have.

**The count is the status line's, not a row of its own.** Wherever the count appears it is inside the
status line: a suffix at the end of the line's words while the turn works or waits, and the line's only
words once the turn is done and its subagents still run. It keeps the info blue in both forms, the
sheet it opens is unchanged, a count of zero draws nothing, and the count as a suffix never brings a
second loader. The term for it is the **Subagent count** and the component that draws it is named
after the term.

**Colour answers "can I press this"; motion answers "is something happening".** That is the rule the
two sentences above come from, stated here so the next colour choice in this cluster has a test to
pass: a loader wears the colour of the words it turns for, so it is muted beside the line's words and
blue only when it turns for the count alone.

**The tool group's row is unchanged in behaviour.** It speaks alone while any of its calls runs, a
failed group still wears its mark with the reason dented under its words, and its own spinner keeps
the row's muted colour.

**Both screens, no storage, no host.** The rows are the app's own components, drawn by the current chat
screen and by the chat screen behind the Developer switch, and they are derived from what the reply
already holds. Nothing is stored, nothing is asked of the bot's host, no plugin or schema changes, and
no dependency is added; reduced motion stills the loaders rather than removing them.

## Testing Decisions

- **What a good test asserts here** is what a reader sees: which rows are drawn, in what order, which
  one turns a loader, what the loader's colour is, and where the count sits. Not the class names, not
  the component tree — except the handful of slots and colours the suite already pins for exactly this
  reason (a loader's `motion-safe:animate-spin`, the failure's tone).
- **Unit** — the rule that places a reply's live rows: a turn with no thinking draws no thought row; a
  thought row sits above the tool row whose call it led into; a reply that thinks, calls, writes and
  thinks again keeps two clusters with one status line under its last words; a finished reply's status
  line holds the count alone or is absent. Prior art: the pure row-placing rules the thinking rows
  already go through, tested with no DOM.
- **Component** — over a seeded device: the thought row says "thinking" and carries no rotating word,
  and neither the row nor its loader is accented; the status line wears its rotating word and a muted
  loader, and says the wait words with a loader still turning; a failed or stopped reply draws no line;
  the count rides as a suffix while the turn works and as the line's only words when it is done; a
  reply with a thought row and subagents at work turns one loader, not two. Prior art: the thought-row
  and subagent-row component tests, which already mount these rows over a seeded database.
- **End-to-end** — the browser flow that already samples these rows for colour extends to read the new
  ones: muted words and loader on the line, the thought row's loader muted, the count blue, and the
  count's loader blue only when it stands alone. Colour and the loader's place are what a DOM without
  layout cannot reach (ADR 0019), and the flow keeps its row and verdict in `docs/e2e-flow-audit.md`.
- **No new flow**: the rows' shape, height and insets are unchanged, so the sweep has nothing new to
  measure; the colour sampling rides the existing flow.

## Out of Scope

- Whether a model emits reasoning at all, and how the host words its own status text.
- The subagent sheet and its cards, which the count still opens.
- The tool details sheet's step list and its spinner.
- The busy-word pools themselves: their words, their four-second pace, and the reply-and-moment seed.
- The four progress-update levels, progress reminders, and anything a reminder draws.
- The row's geometry: its 29px height, the reply's inset, the pair meeting, and the sheet it opens.
- Any animation of a row's own words, and any change to what reduced motion does beyond stilling the
  loaders.
- Re-reading a thread or rewriting rows on screen when the look changes.

## Further Notes

- ADR: [0070](adr/0070-the-status-line-is-muted-and-the-count-is-the-only-blue.md), which amends ADR
  0066 (the accent, the loaderless wait, the count as a row of its own) and ADR 0069 (the thought row
  wearing the line's word in the line's look). The code face and the fresh-thread loader those ADRs
  also decided stand.
- Glossary: the **Thinking**, **Work row** and **Status line** entries are amended, **Subagent line**
  becomes **Subagent count**, and the new **Live cluster** entry names the three rows.
- The colour rule is the one part of this that will be argued with later, so it is stated as a rule
  rather than as three colours: a loader wears the colour of the words it turns for.
- The agent guide's line describing the thought row's rotating word is wrong the moment the first
  ticket lands, and is updated in that ticket rather than here, since it maps the code as built.
- A working turn's loader count is the cheapest check a reader can make: one spinner per reply, never
  two.

## Tickets

- [ ] #695 — the thought row says its own word, and a turn with no thinking draws no row
- [ ] #696 — the status line and its loader go muted, and the wait keeps its loader
- [ ] #697 — the subagent count rides the status line, blue, and never a row of its own
- [ ] #698 — the three rows stand thought, tools, status at the reply's foot

## Build order

#695 and #696 start immediately and can land in either order: one reworks the thought row's word and
colour and removes the empty row, the other reworks the status line's look, its wait and its silence.
#697 waits on #696, because the count is a suffix of the line #696 settles. #698 waits on all three: it
is the order those rows stand in, and the tests that pin it.
