# The status line wears a rotating word, and a thread still loading says so

**Amends [ADR 0064](0064-a-work-row-turns-a-spinner-and-wears-its-mark-again.md)** on one point: its
status line is no longer the fixed "Thinking…" and "Writing…".

A thread opened while its first read is out drew nothing, so it looked stuck, and a loading bot's
Main drew the greeting that says there is nothing here. The footer's two fixed words were also the
only sign that a reply worked between its rows.

**The footer's working words are a mood, and a single word.** "Thinking…" and "Writing…" on the
status line, and the new "Catching up…" a thread says while it loads, are dressed in one word from
a pool of their own (`src/lib/busy-words.ts`) that changes every four seconds, never repeats the
one before, and is the same for the same reply and moment, so a streamed token redrawing the row
never changes it. The pools are original words and never a phrase.

**What stays literal is what is true.** The thinking row's "Thinking…" and "Thought for 12s" (a
duration this device measured), a tool row's "Running a command…", "Waiting for your answer",
"Waiting for approval" and "Stopped" say something the reader may act on, so they are not dressed.

**The count of subagents follows the words.** With working words it is their suffix and rides on the
status line's one loader; with none it is a work row of its own, with its own loader in its own
blue.

**Catching up is the thread's, not the host's.** `catchingUp` is true while the first read is out and
the host has not been found away; an away host keeps its banner. A Main that is catching up draws
no greeting.
