# A row's words are what the host stored, read once at the fold's door

The app typed a transcript row's `content` as `string | null` — in `Row` for the chat screen and in
`SessionMessage` for the one it replaced — and read it directly: the words went into a turn, a tool
row's result went to `settleTool` and from there to `readEnvelope`, a steer's went to `steerWords`, a
compaction's to `summaryOf`. The type was wrong. Hermes answers a row's content in three shapes:
a plain string, a list of parts, or one structured dict. A message that carried a photo is stored as
the parts the model read; a tool result that returned an image is stored as a list too
(`make_tool_result_message` wraps "text parts of a multimodal list"), and the host's own transcript
read renders all three as text (`_coerce_message_text` in `tui_gateway/session_history.py`).

So one row of either shape brought the whole screen down, and it did so in whichever place happened to
read it first: a tool row threw `text.trim is not a function` in `readEnvelope`, and a user's or an
assistant's row threw `text.trimStart is not a function` in `summaryOf`. A guard at the throw site
would have moved the crash to the next reader rather than ended it.

**A row's words have one reader, and the fold reads every row through it.** `rowText` in
`src/lib/row-text.ts` is that rule, and it is the host's own: a string is itself; a list joins its
text parts and stands every other part as the placeholder the host draws for a client that keeps no
bytes (`[image]`, `[audio]`, `[<type>]`); one dict reads by the kind it names; nothing is the empty
string. It is import-free, so it runs as a pure rule in the unit tier (`scripts/test-row-text.mjs`).

**The door is the fold, not each reader.** `foldTurns` maps the rows it is given through `rowText`
once, before anything below it sees a row, so everything inside the fold — the boundary read, the
scaffolding tests, the steer's words, the tool result, the failed turn's line — holds a string by
construction. `Row.content` says what the host can send (`RowContent`: a string, a list of parts, one
structured dict or nothing) and the internal row type says what the fold hands on (`content: string`),
so the compiler holds the next reader to the door instead of to a comment.

**A picture reads `[image]`, never its bytes.** An inline photo's part is a base64 data URI, and the
thread paints media from its own attachment markers and `MEDIA:` tags; the host's remote-client read
makes the same choice (`inline_images=false`). Flattening the URL into a message would put megabytes
into a bubble that draws nothing.

The older chat screen's fold (`src/lib/history.ts`) reads `SessionMessage` the same way and still has
this bug. It is out of this change because the screen the crash came from is the chat screen's, and
the same reader is what fixes it: `turnsFromRows` takes `rowText` at its own door, with no new rule.
