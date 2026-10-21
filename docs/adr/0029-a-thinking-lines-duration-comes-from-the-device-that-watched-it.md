# A thinking line's duration is shown only where the device watched it think

A reply now carries the model's thinking above it: a line that reads "Thought for 12s", streams open
while the model thinks, folds once the answer starts, and opens again on a tap. The number is the
problem. A finished reply already prints its own stats under it — tokens, tokens a second, and the
turn's duration out of `MessageStats.durationMs`, which the host records — so a second figure above
the same reply has to be something the app actually knows, or it is the same number said twice in two
different types.

Nothing in the host's record says how long the thinking took. Live, this device can watch it: the
first reasoning delta to the first answer delta, held in memory for the turn. On reload the reasoning
arrives whole, on a transcript row that carries only the row's own time, and sync carries no timings
at all. So the line shows a number only for a turn this device watched think, and a restored turn
reads bare "Thought".

Three alternatives were each worse. Subtracting the turn's start time from the answer row's time puts
a second, near-identical number under the stats line, and it swallows the wait a queued message spent
before its run began — a message that waited four minutes reads "Thought for 4m 3s". Reading
`stats.durationMs` is honest about its source but is the same seconds the stats line already prints,
one line away. Persisting a duration would need a field the host does not have, would be wrong on the
next device that reads it, and has no source at all for a turn another device ran.

What this costs is worth saying plainly: the same reply reads "Thought for 12s" on the device that ran
it and "Thought" on one that caught up, and that is deliberate rather than a sync bug. Anyone reaching
for a fix should know the number cannot be recovered after the fact — it needs a host field, not a
guess in the app. The cost of the live timer is that it lives in memory: navigating away and back
drops the number while the thinking itself, kept with the reply, stays.

The switch that used to hide the work went with the same change. Settings → Appearance no longer
offers Simplified chats, because a thread now shows what it ran, what it cost and what it thought
whoever it is with — the folding line is what keeps that readable, and a reply's thinking stays folded
until the user asks for it.
