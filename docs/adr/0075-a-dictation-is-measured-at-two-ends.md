# A dictation is measured at two ends, and only one of them sees a decoder

Dictation is tuned by argument. A take's row keeps how many words were said and how long they took to
say; the host states a bound it will not pass; the model picker prints realtime factors nobody has
timed. What a Stop actually costs — the words arriving in the composer — is recorded nowhere, so a
change to a Piece's length, to the prompt the decoder is given, or to which model hears it is defended
by reasoning and re-argued in the next session. ADR 0067 recorded that gap in its own words — the
Hearing prompt's quality "is measurably different, and it is not knowable from a spec which way a take
reads better on the host that hears it" — and shipped without the comparison it had just called the
only way to know.

Two numbers replace the argument, and neither of them is "the take's latency". The **Confirm span** is
the host's: from the Confirm arriving to its answer leaving, the quantity `wait_ms` already bounds.
**Stop to text** is the device's: from the last word of the take to the words standing in the composer.
They are measured on different machines and cover different work — a cloud host's Confirm span holds a
whole-take upload and decode, a local one's does not — so one number blended from them would blame the
phone for the host, or the host for the phone.

The host's number is measured by a bench that runs where the decoder does and drives a take's own
functions in process: the same upload, the same worker, the same Confirm, with no HTTP, no browser and
no version gate between the measurement and the thing measured. It records each Piece's decode, the
Cleanup, the Confirm span, and the words against a reference transcript. The audio is a committed set
of fixtures chosen by what can go wrong rather than by count — one Piece, a sentence that straddles a
pause, a long unbroken take, room tone, names said against a Vocabulary, speech over the floor the app
calls quiet — and the cut policy is an argument to it, so the same audio is sliced two ways and the
only variable is where the cut falls. A committed baseline makes the diff of one file the history, and
every run carries the machine, the model, the level, the cut policy and the fixtures' hash beside its
numbers, because a number without them cannot be compared with anything.

The device's number is measured in the lane that already dictates: a timestamp at the Stop the user
presses and another where the composer takes the text. It is the app's own share — the recorder
closing, the last Upload, the Confirm's round trip, the insert — and no more than that, because the
mock behind the lane answers a constant and cannot feel a decoder. The lane reports the number; the
bench holds the bar.

What a change is held to is a budget rather than a behaviour: a p95 for Stop to text on a stated host,
a zero delta for the words on unchanged inputs, and a names case that fails once the Vocabulary is
removed. ADR 0019's rule that a test belongs to the cheapest tier that would fail for its reason does
not reach this: a bench measures and does not fail, and a timing assertion inside a required check is a
flake waiting for a busy runner. So the bench is a job of its own — on the nightly sweep, and on a pull
request that touches the host's speech path.

## Considered options

- **One end-to-end number taken on a phone against a real provider.** The number a user feels, with
  nothing decomposed. Rejected: a phone, a network, a recorder and a decoder end up in one figure, and
  a change to any of them moves it — which is the argument this exists to end, kept in a table.
- **A bench against the running host, over its own routes.** Closest to what the app does. Rejected:
  it puts a server, a port, a version gate and a body-size limit between the measurement and the
  decoder, and the fixture's audio would then travel through the code under test.
- **Generated audio, made at test time.** No bytes in the repository. Rejected: a synthesised voice
  changes with its engine, and a reference transcript regenerated to match is a WER improvement that
  is really the voice getting easier; a comparison across weeks needs the same bytes.
- **Keeping the numbers on the dictation row.** Rejected: the row's spoken span is the denominator for
  words per minute, and a row mirrored between two machines cannot hold a figure whose halves belong
  to different ones.
- **Measuring by hand and writing it in the ticket.** The cheapest possible start. Rejected: it is
  exactly what ADR 0067 declined to do, and a figure in a ticket dies with the branch.
- **A timing assertion in the plugin's unit tests.** No new job. Rejected: a decoder is not installed
  on every runner, and a required check that fails on a slow one is turned off within a week.

## Consequences

- The bench is a job of its own, so a red run is about a number and not about the plugin's tests; the
  plugin's own cases keep their stubbed transcription and stay fast.
- Committed fixtures cost a few megabytes in a repository that ships a phone app; in exchange a
  comparison across months is meaningful.
- The bar is a p95 on a stated host, so the bench can never say "dictation is fast" — only that a
  change did not make this machine slower, and by how much.
- The picker's speed numbers can become measurements rather than the printed guesses they are now,
  because the bench is the decoder that produces them.
- The lane's figure cannot become a bar on the decoder: the mock behind it answers a constant, so the
  number is the app's share and the spec says so where the flow prints it.
- A change to a Piece's length now moves two numbers at once — the count of decodes and the tail a
  Stop waits for — which is the coupling ADR 0074's Consequences already named and nothing measured.
- A host with no decoder can still run every gate the plugin has; the bench skips, and says it
  skipped rather than reporting a pass.

What holds it: the bench's record is compared field by field with a baseline committed beside the
fixtures, so a run that changes a number changes a file a reviewer reads; the fixtures' hash rides in
the record, so a regenerated voice cannot be compared with an older one; and the lane prints its
figure from the flow that already asserts a take lands, so the app's share is stated where its
behaviour is already pinned.
