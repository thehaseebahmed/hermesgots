# A reply keeps its thinking in runs, each drawn after the tool call that broke it

**Superseded in its row-count, fold and cap clauses by [ADR 0049](0049-thought-rows-that-touch-draw-as-one-and-open-until-the-answer.md)
(2026-10-24):** rows drawn with nothing between them are one row, every row of a live turn stays open
until the answer begins, and an open row carries no cap, fade or Show more. Everything else this ADR
decided — runs in arrival order, each anchored to the call that broke it, the span measured by the
device that watched, and the honesty of the three labels — stands; 0049 changes how rows are drawn
and when they open, not what a run is.

**Superseded in its placement clause by [ADR 0051](0051-a-tool-row-never-lands-between-two-thought-rows.md)
(2026-10-25):** the title's "each drawn after the tool call that broke it" no longer holds — a stretch
draws above the tool row whose call it follows, so a tool row never lands between two thought rows.
Runs, their anchoring to the call they follow and the spans measured here stay as this ADR set them;
where a row is drawn moved, what a run is did not.

Supersedes 0029. The thinking line stopped being one line: long reasoning read as an undifferentiated
wall of plain text, and a turn that thought between tool calls showed it all hoisted above the work it
was thinking about. A reply now keeps its thinking in runs — `reasoningRuns: { text, afterToolId?,
spanMs? }[]` — and a thread draws one row per run, placed after the tool call that broke it, so what
the model thought before a call sits above that call and what it thought after sits below it. Rows
stream open while their run thinks, fold when the run ends, and open again on a tap.

The shape follows the wire, which offers almost nothing to hang placement on: reasoning arrives as
plain text chunks with no timestamps, no block ids and no offsets, and the only structure is arrival
order and the tool-call ids around it. So the runs are kept in arrival order, each anchored to the id
of the call it follows, and nothing is invented — no split-point offsets into a blob (string surgery
over structure the API never sent) and no full event list (a refactor that would re-anchor content
too, which nothing here needs). The ingest records the order as it arrives, and the transcript rebuild
keeps it row by row, so a reloaded or synced chat draws the same rows in the same places; a stored
reply from before this change migrates as one run at the top, which is where its single blob was drawn
anyway. An opened run reads as a reply does — markdown, not raw pre-wrapped text — capped with a fade
and Show more, scrolled to its newest words and following them while the run still streams.

Runs break only where a tool call starts. A steer the user sends mid-reply, or an approval they answer,
resumes the model with no call in between, so the thinking after it is the same stretch and grows the
same run: one row, drawn once, however many times the user has spoken. A completion that arrives with
no start to match also gets its card and also breaks a run, because the turn really did start a call
there. The runs are built by one rule, used both by the ingest that fills a streaming reply and by the
rebuild that reads a chat back from its transcript, so a reloaded or synced chat draws the same runs in
the same places the live one did.

The duration was already measured client-side, the first reasoning delta of the run to its last, and
0029 held it in memory alone; now it is written to the reply's row on the device that watched, never
synced and never read off the host. That is the part of 0029 that changes its mind: a reload keeps its
numbers where 0029 threw them away. What does not change is that the number is this device's own
observation — Hermes's own CLI, TUI and Desktop all measure it the same way and keep it in memory, and
nothing in the host's record knows how long thinking took — so a device that never watched a run think
says "Thought it through" rather than a bare "Thought", words that claim no number it doesn't have.
The same reply still reads "Thought for 12s" where it ran and "Thought it through" on one that caught
up, and that asymmetry is still deliberate. A catch-up that replaces the reply's runs from the
transcript carries the local spans onto the runs whose text sits unchanged in the same place, and
leaves a run whose stretch was rewritten without one; messages do not sync, so the span never leaves
the device that measured it, which is the point.

0029's other clause goes with it: a project session's own thread draws thinking now too, like every
other thread. Hiding it there was about keeping a worktree's thread free of the chat's furniture; what
changed is that a run's row is now the thread's account of what the model was doing between its tool
calls, and a coding session that drops it loses the same thing a chat would.

A row says one of three things: "Thinking…" while its run is still streaming, "Thought for 12s" where
this device measured that run, and "Thought it through" where it did not. A run this device did not
watch — a reply picked up from a transcript, a run rebuilt from another device's replay — reads the
third, honestly, rather than wearing a number nobody measured.

One row per run, and only one: a row streams open while its run is the reply's newest and the reply is
still thinking with no answer begun, folds the moment the run ends (a call starting, the answer
starting, the turn finishing), and a tap opens it again for as long as the thread is mounted. Every
thread draws them — a chat's, a delegated agent's sub-thread, which is drawn as a chat's thread is, and
a coding session's own thread, which is the worktree's conversation and thinks the same way.

## Considered options

Three alternatives were each worse. Keeping a reply's thinking as one string with markers inside it
saying where each call fell would draw the working-out away from the thing it was about, and would need
a second format inside the first. Keeping the runs only in the device's row, without deriving them from
the transcript, would lose them on every other device and on any chat whose rows were rebuilt — reading
them back from the transcript's rows in order is what makes a synced or reloaded chat draw the same
runs in the same places. Keeping the span in the page's memory, as ADR 0029 did, costs the number on
the very reload that keeps the thinking, and reads "Thought it through" over a run this device watched
think a minute ago.
