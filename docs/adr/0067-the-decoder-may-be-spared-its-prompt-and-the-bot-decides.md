# The decoder may be spared its prompt, and the bot decides

What a host's speech model is given before it listens — the host's own initial prompt, a hint naming
the bot and its chat, the bot's vocabulary, and the take's text so far — was assembled ad hoc in one
function and sent with every piece. It is now a structure with its own builder, and the bot keeps or
withholds it as one thing, read for every piece so a change lands on the next one.

It starts withheld. Withheld, the model hears the audio alone: names and jargon come back as its own
guess rather than the bot's spelling, and a sentence cut at a pause loses the carry-over from the
piece before it. Nothing is thrown away by that — the vocabulary and the hint go to the cleanup
instead, which is where the tidying happens anyway — but the quality is measurably different, and it
is not knowable from a spec which way a take reads better on the host that hears it.

So the setting exists to be compared rather than to be believed: a **Hearing prompt** row on the
bot's Speech-to-text page, under Developer, writing a value the host keeps and reads per piece. It
stays after the comparison as the escape hatch, which is why withholding is recorded here: a take
with no prompt to the decoder is deliberate, not a regression someone should "fix".

## Considered options

- **Deleting the prompt outright.** Simplest, and it is where this is heading. Rejected for now: the
  cost is real and the only way to weigh it is to hear the same take both ways on the real host.
- **Two transcription routes, one prompting and one not.** Rejected: two code paths for one decode,
  and the client would have to choose between them per piece.
- **The switch on the device, like the rest of Developer.** Rejected: the decode runs on the host, so
  every device on that bot has to see the same answer.
- **Folding the choice into the cleanup level.** Rejected: they change different things — one changes
  what Cleanup may write, the other what the model hears — and tying them would forbid comparing a
  level with a decode.
