# One working look for the status line and the thinking row, and a code face for coding sessions

**Amends [ADR 0066](0066-the-status-line-wears-a-rotating-word-and-a-loading-thread-says-so.md)**
on one point: the thinking row's "Thinking…" is no longer left literal. It also makes the code
session's face reach the composer, the user's bubbles and the status line.

**The status line and a thinking row that still thinks are one thing.** They drew the same fact —
the turn is working — in two looks: the footer's line in the accent colour with a rotating word, the
row muted with a fixed "Thinking…". The row now says the status line's own thinking word (seeded by
the reply's id, so the word is the same whichever of the two is speaking), in the same colour, loader
and height (`WORKING_ROW_CLASS`, `WORK_ROW_CLASS`), so a turn moving between them changes nothing
the reader sees but the words' source. What stays literal is unchanged in kind: the row's accessible
name and its sheet's heading ("Thinking…"), a finished row's "Thought for 12s", a tool row's words
and the waiting words.

**What is said in a coding session is in JetBrains Mono; a tool call's input and output are in it
everywhere.** `CHAT_FACE` is provided at the root of both chat screens for a chat that has a project:
the user's bubbles, the replies, the status line, the work rows, a thought's body in its sheet (the
context crosses the portal) and the text typed in the composer. A plain chat with a bot keeps the
app's face, and the chrome — headers, pills, buttons, a sheet's heading — keeps it in both. A tool
call's input and output are the one part that is always `font-code` (`tool-card.tsx`), chat or session.
The font loads with the app's styles rather than chat-next's chunk, since the current chat screen
draws it too; the files themselves are fetched only when a glyph needs them.
