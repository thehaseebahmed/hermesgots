# A reply keeps its thinking in runs, each drawn after the tool call that broke it

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

The duration was already measured client-side, the first reasoning delta of the run to its last, and
0029 held it in memory alone; now it is written to the reply's row on the device that watched, never
synced and never read off the host. That is the part of 0029 that changes its mind: a reload keeps its
numbers where 0029 threw them away. What does not change is that the number is this device's own
observation — Hermes's own CLI, TUI and Desktop all measure it the same way and keep it in memory, and
nothing in the host's record knows how long thinking took — so a device that never watched a run think
says "Thought it through" rather than a bare "Thought", words that claim no number it doesn't have.
The same reply still reads "Thought for 12s" where it ran and "Thought it through" on one that caught
up, and that asymmetry is still deliberate.

0029's other clause goes with it: a project session's own thread draws thinking now too, like every
other thread. Hiding it there was about keeping a worktree's thread free of the chat's furniture; what
changed is that a run's row is now the thread's account of what the model was doing between its tool
calls, and a coding session that drops it loses the same thing a chat would.
