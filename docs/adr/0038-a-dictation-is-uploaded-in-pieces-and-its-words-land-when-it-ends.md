# A dictation is uploaded in pieces and its words land when it ends

A dictation shows no words while the user talks. The recording is cut into pieces at pauses, each
piece is transcribed by the bot's host while the rest is still being spoken, and the whole text lands
in the composer once, at the end — tidied by one cleanup pass over the finished text. The live path
is deleted with its endpoints: `POST dictation/take` and its `audio`, `stop` and `cancel` children,
the `dictation_stream` feature on `info`, `dictation_stream.py`, and the bar's transcript region.

This reverses ADRs 0015 and 0016, which built the live bar on the claim that hearing-while-talking is
what makes dictation feel like talking rather than recording. The call now is that the preview is not
wanted: the piece path also uploads while the user talks, so the host still hears during the take —
only the reading surface goes. What 0015 decided for privacy stands unchanged: the same host speech
model transcribes every piece, no cloud engine, no key, and the answer to "make it more accurate" is
still the host speech model and the bot's vocabulary. Its accuracy objection to pieces — a shorter
piece is a shorter sentence for Whisper — is carried by the piece caps instead: a piece closes at a
pause or at its length cap, so most pieces are whole sentences, and it is the same model either way.

Cleanup survives and moves. ADR 0017 rejected one pass over the whole dictation because the text was
already on screen and the pass would rewrite what the user was reading; with no live preview nothing
has been read, so the whole-text pass is the natural shape. One bounded call when the take ends, the
same instructions, the same model override and the same fallback to the raw words — and one call per
dictation instead of one per phrase. Vocabulary, which 0017 carried in the decoder's prompt and the
cleaner's, now rides in each piece's transcription and in the end cleanup, so the Words section on the
Dictation tab keeps its meaning. The tab itself is gated on the `dictation` feature instead of
`dictation_stream`, so its settings stay reachable on every host that can dictate.

## Considered options

- **Keeping the take endpoints and only hiding the bar.** Rejected: dead routes rot, and an old app
  against a new host already falls back to pieces — it streamed only where the host advertised
  `dictation_stream`.
- **A feature flag over the streaming path.** Rejected: the same rot, plus a second implementation
  kept green for a switch nobody would throw.
- **Cleanup per piece as it transcribes.** Rejected: more calls while the user is still talking, and
  a piece is not a unit of meaning — punctuation belongs to the sentence the pause cut, and only the
  whole text shows the cleaner what was one list and what was one sentence.
- **No end cleanup, the raw words only.** Rejected: the fillers and the missing punctuation are most
  of what makes a dictation unsendable, and the point was to keep the tidying, not the timing of it.

## Consequences

- The voice bar is a meter again — level, elapsed time, Stop, Send, Cancel — and never a reading
  surface. The two-window commit rule, the "Preparing…" and "Behind" states and the per-phrase
  commit go with the stream module.
- The end-of-take waits cover the cleanup: Send waits a few seconds instead of 1.5 s, Stop keeps its
  8 s, and the host's cleanup deadline is raised for a whole text. Past the wait the raw words land —
  a wedged host costs the tidying, never the words. The cleanup keeps the answer-length sanity check,
  so a model that rewrites is still discarded.
- `POST dictation/cleanup` is the one endpoint added: the finished text in, the tidied text out. The
  batch transcription route, the warm route and the speech settings routes are untouched, and the
  Cleanup model picker on the Dictation tab and its field on the speech settings route stay as they
  are (ADR 0036 still stands).
- One take at a time per bot, the kept-pieces store, the failure lines and the retry all stay as they
  are: they were never the preview's.
- An old app against a new host falls back to pieces on its own; a new app against an old host never
  asks for a take. Neither direction needs a version gate.

Supersedes ADR 0015 (a dictation is heard by its bot's host while the user talks), ADR 0016 (a
dictation commits words that have stopped changing, and shows them in its bar) and ADR 0017 (a
finished phrase is cleaned up before it is committed).
