# A call's result says which of three things happened

A reply's tool rows read a call's outcome out of its result, and two faults met in that read. A result
carrying `error: null` — the shape a successful call has — counted as an error because the key was
there rather than because it had a word in it, and the reason drawn under the row came from
`user_summary`, which describes what a call did rather than what went wrong. A command the reader had
turned down in an approval was the case that showed both: its result says `status: "blocked"`, the
host's own summary reads *You denied this command — it did not run*, and the row below it wore a
failure in red for something nobody had got wrong.

**There are three answers, and one rule gives them.** `callOutcome` says a call **worked**, **failed**
or was **refused**. A terminal command fails on a non-zero exit and its reason is the result's own
`error` (or `message`), else *Exit code N*; every other tool fails on `success: false` or on a non-empty `error`
string, and a bare `success: false` is a failure with nothing to say. A `user_summary` never stands
where an error belongs, and it never decides one: a result with `error: null`, or an empty one, is a
call that worked. A result whose `status` is `blocked` is a call the reader turned down before it ran.

**The word a failure wears belongs to the renderer, not the rule.** The rule answers what happened and,
for a failure, why; the row draws *Failed* where nothing was said (`words.ts`), so display copy has one
home and a screen reader hears the same word the eye reads.

**A refusal is its own state, and all three surfaces agree about it.** `ToolEvent.status` gains
`refused`: the call keeps the muted tone with no note under it (ADR 0096), and its sheet says
*Refused* rather than *Completed* — a command that never ran did not complete. Both folds set it from
the result, and so does the live path: a completion the host marks as an error whose preview parses as
a refusal is that refusal, because the stream's own `error` flag cannot tell the two apart.

## Considered options

- **Reading the denial's error text for the word BLOCKED.** The status is the contract; a command that
  prints *BLOCKED* in its output would be read as a refusal.
- **Keeping `user_summary` as the note's wording while holding the failure test to the error.** The
  row would then carry a reason that reads as a description of success under a red row — the same
  mismatch one layer down.
- **Treating every non-zero exit as a real failure.** A `grep` that matches nothing exits 1 and is not
  an error; but the exit code is what the host gives the app to decide by, and inventing a second
  vocabulary of benign non-zero codes would be a guess about the command.
- **A fourth status for "the host wouldn't say".** Every call ends, and the folds already settle an
  unknown result as completed; a state nothing writes would be a branch nothing could reach.
- **Also reading `status: "denied"`.** Nothing in the host, the plugin, the mock or the fixtures emits
  it — the refusal on record is `blocked` — and a rule whose whole point is to be exact about what the
  host says does not grow arms for words nothing sends.

## Consequences

- `callOutcome` (`src/lib/tools.ts`) is the one rule both folds ask — a transcript parsed
  (`lib/history.ts`) and a live turn read (`chat-next/messages.ts`) — so a call reads the same however
  its thread was opened.
- `ToolEvent.status` carries `refused` (`lib/db.ts`), and `lib/chat.ts` sets it from a failed
  completion's preview so the live row and the re-read row do not disagree.
- `scripts/test-tool-failure.mjs` pins a non-zero exit, `error: null`, an empty `error`, a bare
  `success: false`, and a blocked result; `test-tool-row-words.tsx` pins the refused call's muted row
  and its sheet's word.
- A failure's colour lands on the note under the row alone (ADR 0096).
