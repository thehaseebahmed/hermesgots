# A model divider comes from the host's record, and from the newest turn's own pick until it speaks

A chat's thread draws a divider above the turn where its model changed, named by the host's record of
the models the session's calls ran on (`model_changes` on the plugin's context route). The report that
started this was a switch made in a project session that showed up minutes later, long after the turn it
belonged to: the divider had not been misplaced, it had been waiting for information the app only asked
for when that turn ended.

The record is the source a divider is drawn from, and the whole of it for every turn but the newest. A
turn the app can name from its own pick is only a claim about what will run: a pick whose provider is
missing never reaches the host at all (`modelOf` drops the model from the run), so the pill can name one
model while the host runs another. A divider that names a model the host never ran would be worse than
no divider — it is the one thing in a thread claiming to be a fact about what happened. So a divider is
only drawn where the model *before* a change is known: unknown never counts as different.

The newest turn is the exception, because the host has not recorded its call yet. There the record's
silence is not an answer, and this device's own pick is the newer word on what the turn runs — as it is
in the pill above the composer. The record's own row for the turn replaces the pick the moment the read
brings it, and a turn with a newer one below it keeps what the record carried into it: by then no row
inside that turn means the pick never reached the host, and nothing changed. Without this, a switch could
only ever be shown once the host had recorded the call — which is the delay the report was about.

So the app asks for the record when a turn opens, where nothing names the turn above it (no pick, and no
row read yet), rather than leaving the switch unknown until the turn it started ends. It is a fired read:
the send path never waits on one.

## Considered options

- **Mark the pick instead of comparing models.** Rejected: the mark would be drawn where the user picked,
  not where the model changed, and it would survive being wrong — a pick that never reached the host
  marked as a change that never happened.
- **Read the record on every send.** Rejected: a chat whose picks the device already knows has nothing to
  learn from it, and the app counts its requests per turn, so the read is asked for only where the turn
  above can't be named at all.
- **Read while a turn runs** (poll for the record). Rejected: the record can only name calls that have
  already run, so polling through the middle of a turn spends requests to learn what the turn's own end
  will report anyway.
- **Draw nothing until the record covers the change**, leaving the read where it was. Rejected: that is
  what the bug was — a divider arriving with the turn's end, minutes late, reads as a misplaced divider
  rather than a late one.
- **Keep the pick only while the turn is being written.** Rejected: the divider blinks off the instant
  the reply finishes and returns when the read lands, on every switch, to be wrong about a pick the host
  ignored only until the next turn settles it.

## Consequences

- A switch shows as soon as its turn opens, on a long turn too, wherever the turn above it is one the app
  can name: a pick, or a row of the record it has already read.
- Where nothing names the model before a change — turns that ran before any pick was made, with no record
  read — the thread stays silent until the record arrives, and stays silent for good if the host never
  recorded those turns. That is the invariant working, not a gap in it.
- The newest turn's divider can name a model the host did not end up running, for as long as the record
  is silent about that turn. The record's own row corrects it when it lands, and sending a further turn
  settles it either way.
- The record is what makes a thread agree across devices: a chat another device picked a model for shows
  its divider here, where only the host can place it.
- The mock now records the model that ran — the host's own when a turn asked for none — as the plugin's
  hook does, since without it no flow could reach the case this decision is about.
- `GLOSSARY.md` now separates a **Model pick** (Gots' own setting, and a wish) from a **Model change**
  (the host's record), which is the distinction this decision turns on.
