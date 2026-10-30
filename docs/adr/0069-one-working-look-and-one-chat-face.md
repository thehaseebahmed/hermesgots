# One working look for the status line and the thinking row, and one face for everything said in a chat

**Amends [ADR 0066](0066-the-status-line-wears-a-rotating-word-and-a-loading-thread-says-so.md)**
on one point: the thinking row's "Thinking…" is no longer left literal. It also generalises the
code session's face of ADR 0065's chat-next to every chat.

**The status line and a thinking row that still thinks are one thing.** They drew the same fact —
the turn is working — in two looks: the footer's line in the accent colour with a rotating word, the
row muted with a fixed "Thinking…". The row now says the status line's own thinking word (seeded by
the reply's id, so the word is the same whichever of the two is speaking), in the same colour, loader
and height (`WORKING_ROW_CLASS`, `WORK_ROW_CLASS`), so a turn moving between them changes nothing
the reader sees but the words' source. What stays literal is unchanged in kind: the row's accessible
name and its sheet's heading ("Thinking…"), a finished row's "Thought for 12s", a tool row's words
and the waiting words.

**Everything said in a chat is in JetBrains Mono, whatever the chat.** The face used to follow
`projectId`, which drew the same thread two ways. It is now `CHAT_FACE`, provided at the root of
both chat screens: the user's bubbles, the replies, the status line, the work rows, a thought's body
and a call's input and output in their sheets (the context crosses the portal) and the text typed in
the composer. The chrome — headers, pills, buttons, a sheet's heading — keeps the app's face, because
those never ask for it. The font loads with the app's styles rather than chat-next's chunk, since
the current chat screen draws it too; the files themselves are fetched only when a glyph needs them.
