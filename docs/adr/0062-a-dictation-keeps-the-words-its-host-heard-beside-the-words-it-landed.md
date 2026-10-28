# A dictation keeps the words its host heard beside the words it landed

A dictation's row holds the words that landed in the composer — after Cleanup. What the host's speech
model actually wrote is gone the moment the tidied text replaces it: the cleanup call is given the
joined text of the take's pieces and answers the tidied one, and only that answer is ever written. So
the log can say what you sent, never what the model heard, and the two differ by exactly the thing
worth seeing — the fillers, the pause-shaped punctuation, the misheard name the vocabulary did not
cover. A dictation's whole quality argument rests on that gap, and the screen the log exists for could
not show it.

The row therefore keeps both texts. `heard` is one string: the take as the host heard it, its pieces'
texts joined in the order they were cut, which is precisely what the cleanup was handed — so the two
blocks are a true account of what the cleanup did, and nothing has to be reconstructed to compare
them. It is stored on every take, not only where the cleanup changed the words: the words as heard
are a fact about the take rather than a diff of the cleanup, and the case that most needs them is the
one where the cleanup did not answer at all, leaving the heard words as the words that landed. A row
written this way carries two texts and no third field: a cleanup that failed and one that found
nothing to change both read as identical texts, and telling them apart is not worth a column.

`heard` travels with the row it belongs to — the same `POST dictations` body at commit, the same
column on the bot's host, the same Dexie record in the device's mirror (ADR 0060). Nothing syncs, no
second endpoint exists, and a host too old to know the field ignores it: the mirror is healed from
that host, so a `heard` its host never kept goes with the row on the next reconcile rather than being
defended by the device, which would make the one table with a single source of truth have two. The
field is display-only. `words`, `ms`, the month a row is grouped in, the row's preview line and the
Stats totals all keep reading the landed text, so a take whose heard words were longer (the fillers)
still counts as what landed. A `heard` the host cannot take — not a string, or past the same length
bound the words carry — is dropped and the row is written anyway: the dictation is what every other
screen reads, and a malformed second copy is never a reason to lose it.

The sheet draws the heard text under a **Heard** heading whenever the row has one, and the words that
landed under **Cleaned up** only where they differ — so a take the cleanup left alone reads as one
block, and a row from before this change (or from a host that never kept it) reads exactly as the
sheet read before. Both blocks are drawn at reading size, whole, in the sheet's one scroll: a scroll area inside
a bottom sheet is a trap on a phone, and a reader who scrolled this far meant to read the text. Copy
still takes the landed words — the ones you would paste — with both blocks left selectable.

## Considered options

- **Only where the cleanup changed the words.** The field would read as a diff of the cleanup, and a
  taking whose cleanup failed or timed out would keep none — the case the feature exists for.
- **The take's pieces, each with its timing.** Truer to what the host produced, and it shows where the
  pauses fell; rejected because a piece is an upload unit and not a unit of meaning (ADR 0038), and a
  list of fragments is not a text anyone reads.
- **The heard text on the device only.** Smaller on the host, and nothing extra to wipe. Rejected:
  the host is the log's durable copy, so a reinstall would lose the one record of what the model
  heard, and a reconcile would take it away regardless.
- **A third field saying whether a cleanup answered**, so a single block could be labelled truthfully.
  Rejected: it changes nothing a reader would do, and the schema stays two texts wide.
- **A heading over the heard text always, even for a row that has none.** Rejected: it would claim a
  text the row does not hold.

## Consequences

- Every dictation now carries two bounded texts (`MAX_TEXT` each) on its bot's host and in the device
  mirror, so the log's store roughly doubles and a Clear takes both with the row.
- A row reconciled against a host too old to keep `heard` loses it; the second block simply stops
  drawing. No feature flag, no version gate: the row itself says what it holds.
- The commit path grows one argument — the joined heard text, which `useChunkedDictation` already
  holds when it settles — and the sheet's component test covers a row with both texts, a row with the
  same text twice and a row from before the field.
