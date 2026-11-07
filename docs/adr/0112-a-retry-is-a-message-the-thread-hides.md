# A retry is a message the thread hides

Retry on a turn the host gave up on re-asks the user's request. It sent the same words again, so the
host's transcript grew a second `user` row with the same text — and the thread had only two ways to
read that: draw both, which puts the request twice in a row with the failed attempt's calls between
them, or hide the failed turn, which deletes work the reader may need — what the fold used to do.
Neither is the truth: the request was asked once, it failed, and it was asked again.

**So a retry is a message of its own kind.** The app writes it as the host's own notices are written —
a bracketed header on line 1, a bracketed line to close it, the request between them
(`src/lib/retry-message.ts`) — and both folds read that shape and draw no request for it. The turn it
opens is still a turn: its reply is the answer the reader is waiting for, drawn under the turn that
failed, whose request, calls and failure all stay where they were. The header is the model's, and it
says what it is for: the request below is the same one again, and the work that attempt did is above
in the transcript, so the retry carries on instead of starting over.

**Two markers, not one.** A header alone is something a person can type or paste into a message, and
their message must stay theirs — the wake prompt's rule, and the compaction seam's. So the request
stands between an opening line and a closing one, and only the app writes both. A message that quotes
one of them, or carries a header with words but no end, is the user's and draws as it always has.

**Nothing is written back.** The row is the host's once the run starts, and the shape is read off its
text on every device, so a chat opened a month later, on another phone, draws the same thing. The host
keeps the failed turn and the retry as they are, which is what a person reading the transcript in
Hermes's own dashboard sees; Gots is the only surface that folds the two into one request.

## Considered options

- **Hide the failed turn and draw the resend as the user's message again.** What the app did until
  now. Rejected: the calls that ran and the files they wrote go off the screen, and the reader cannot
  see what the second attempt is carrying on from — which is exactly what made this a bug report.
- **Draw both requests.** Honest about the host's rows, and wrong about the conversation: the thread
  reads as if the user typed the same thing twice, and the second bubble sits under a failure it does
  not explain.
- **Have the plugin stamp the retry's row with a `display_kind`.** The plugin writes its own rows, but
  this one is Hermes's `user` row, written when the run starts; stamping it after the fact means a new
  route, a hook, and a window where other devices fold it as a plain message. Rejected as machinery
  for a mark that the text already carries — and it would leave the shape unreadable to a device
  running an older build, which text never is.
- **Send the marker alone, with no request under it.** Half the tokens, and the model is asked to read
  the request from the turn above. Rejected: a compaction can sit between the two, the retry's own
  row is what the run is given, and a request the model has to reconstruct is a request it can get
  wrong.

## Consequences

- A retry's request is in the host's transcript twice, in the user's own words once. The second copy
  costs the tokens the first send cost, and is what the model is handed.
- The marker's **tokens** are the contract and the sentence after each is prose: rewording what the
  model reads is not a change to what the folds recognise, so old rows keep folding as retries.
- `retryText`/`requestIn`/`isRetryText` are one rule for the writer and every reader
  (`app-view.tsx` sends, `fold.ts` and `history.ts` fold, `messages.ts` and both views draw a
  retry's not-sent row), pinned by `test-retry-message.mjs`. `requestOf` in `fold.ts` is the one
  decode of a request, used by the fold and by the turn this device streams, so the live copy and
  the transcript's copy agree field for field — and `drawsRequest` is the one rule both views ask,
  built on `askedByUser`, which is also how a chat counts the turns the user asked.
- The current screen's catch-up keeps a retry's answer: its turn has no message of the user's, the
  shape a wake run's and a routine's have, so `turnsOf` hands `reconcile` one `noRequest` and it
  writes the reply rather than passing it by.
- A not-sent retry draws the words its markers carry, and nothing else: `heldWords` decodes the
  request and drops the attachment marker lines too, since a bubble draws neither.
- A user who pastes a whole retry, markers and all, into a message has it folded as one — the same
  hole the wake prompt and the reload notice have, and the reason the closing line is required.
  `SendHow.retry` does not get them out of it: it shapes the turn this device streams and keeps that
  send out of triage, but the thread drawn a moment later is the transcript's, and `requestOf` reads
  it there from its text like any other fold. Their message is therefore hidden on their own screen
  too — the hole is a property of marking a memory rather than the row, not a race.
- Nothing of a retry's send is deleted, and a failed turn is no less a turn the user asked: it is the
  one the retry answers. A retry's own turn is not counted, so a chat's turn count is what the reader
  sent, not what the app asked twice.
- A retry is not triaged again: it re-asks where the request was made, rather than being read as a
  new message that might belong to a thread.
