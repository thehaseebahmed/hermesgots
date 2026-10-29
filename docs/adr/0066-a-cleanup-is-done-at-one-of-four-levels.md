# A cleanup is done at one of four levels

The cleanup had one rule and it was a floor: fillers out, punctuation, casing, numbers, a spoken list
as a list — and never a reworded word. A take that came back as *"Hello, I'm just wanted to check how
long does it take for a big transcription to transcribe I guess?"* was answered with two commas and a
full stop, because every defect worth fixing in it — a false start, an agreement error, a word order —
counted as rewording. The rule that made the cleanup safe made it useless, and no model change could
better it: the ceiling was the instruction.

So a take is cleaned up at one of four levels, and the level is a bot's choice: **None** makes no
call at all, and the heard words are what lands; **Light** takes out fillers, false starts and slips
and repairs grammar, punctuation, casing and numbers; **Medium** does Light's work and tightens —
wordiness, redundancy, run-ons — without dropping information; **High** does Medium's work and
compresses, restructuring a sentence, dropping hedges and low-value words, and reordering within it.
No level adds content, answers a question the take asked, or changes a name, a number or what the
person asked for.

The level is kept on the bot's host beside the cleanup model and read for every take, so it survives
a plugin restart and every device on that bot agrees; a bot that has never picked runs **Light**, the
only level that keeps every word and the closest to what shipped before. The answer check stops being
a proof that every word survived and becomes a bound against garbage: an answer outside 0.6x–1.4x of
the text at Light, 0.45x–1.4x at Medium or 0.25x–1.4x at High is discarded and the heard words land —
never a lower level's answer, since a second call costs more than the tidying is worth. **High**
raises the host's cleanup deadline to 12 s and Stop's wait with it, so the level that reads most is
never silently the level that loses its race.

## Considered options

- **One level with a wider rule.** Cheap, and it fixes the reported take. Rejected: nobody tunes a
  bot's cleanup then, and a person who wants their words verbatim has no way to say so.
- **A free-text cleanup instruction per bot.** The most flexible. Rejected: unbounded, untestable,
  and nothing can be promised about what a hand-written instruction does to a take.
- **The level on the device, like Developer.** Rejected: it decides a call the host makes, and two
  devices on one bot would disagree about the text of the same dictation.
- **Keeping the length check as a word-preservation proof.** Rejected: at High it would reject every
  honest answer, so the check has to mean "not garbage" rather than "every word survived".
