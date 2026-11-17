# A call's form outlives the card that took it

**The question:** Hermes asks a clarify call's questions one prompt at a time. The card that holds them
is one form of pages, sent once — and then it answers each question as the host asks it, with no tap
(`QuestionCard`). Between two prompts the card holds its place for `BETWEEN_MS` and stands down
otherwise, so a host that asks nothing more hands the composer back rather than leaving a dead card on
it. What happens to the form in that gap belongs to the card: `committed`, the whole form, and `sentFor`,
the prompt it last answered.

A host takes its own while between two questions — the model loop it runs — and a real one can take
longer than the hold. The card is then drawn again for the next question with an empty form, and every
answer the reader gave ahead is gone with the card that held it: one answer gets through per visit, and
the rest need the chat left and opened again, once each. Reported from a real host, with a call of
three.

**The decision: the screen drawing the card keeps the form (`CarriedForm`), and hands it back to a card
drawn again.** The card records the form it took, and the prompt it answered, as the reader filled it in
(`onTaken`); a card handed one (`taken`) opens with those picks on their pages and answers the question
the host is waiting on from them. The card's own shape travels — `Picked` per question, not the wire's
answers — so nothing has to be reconstructed from an answer that lost how it was given. The hold stays
what it was: the card leaving the composer is a display choice, not the end of what the reader gave.

**Keyed by the call, and dropped with its run.** The form is filed under the call's own `promptKey`, the
same string the card is keyed by — one identity for one call, so a form is never looked for under a
name other than the one it was stored with. It is dropped when the page stops drawing that call or the
run ends, rather than merely not handed over, so no answers sit in the page past their call.

A card drawn again for a question the form has no page for — a call whose ask was read differently, its
ids not the ones the form was filled under — hands the form back instead of holding it: the reader
answers that question themselves. A form that stayed committed on a question it could not answer would
leave every control disabled for the rest of the run.

**A refused send takes the form back.** The card clears it on a refusal as well as its own copy, so a
host that refused does not have the rest of the answers tried behind a card that has stopped, and the
reader sees the form filled on the page it was refused on.

**What this leaves open.** The form is the page's state, not the store's: `ThreadState` already holds a
call across prompts (`between`, `questionSet`, `answeredPrompts`), and a `form` there, cleared where
those are, would be the same fact in one place instead of a run-and-call key rebuilt here. It is a
reducer and a `Doing` field away, and not what this fix needed. The form also does not survive a
reload, only a gap: a chat opened again is empty, as it has always been — persisting it beside `stats`
and `answers` in the `SessionState` record is the step to take if a phone that locks mid-call turns out
to want it.

**The identity has one hole, and it is the host's to close.** Two calls in one run that ask the same
questions in the same words, with the same ids, are one key: the second would be handed the first's
form. Nothing on a prompt read names the clarify call — only the prompt's own id does, and that changes
with every question — so telling them apart means carrying the call's id on the prompt
(`lib/run-prompt.ts`, and the payload the plugin serves). The run guard covers a later run asking the
same words, which is the case a retry makes.

**The evidence.** `question-reload-many` on the `slow-clarify` mock — a host that withholds a prompt
from streams that were not there for it, thinks for three seconds before its first question and takes
seven between two, longer than the card's hold — in three ways: the wait is up and the chat is left and
opened again; the chat is left before the host asks; and a run is answered, carries on and asks a second
call. The first is red on the base commit (the card is back on question 2 of 5 with nothing filled in)
and green with this. The card's own rules are `test-question-card.tsx`'s: take up the form it took,
answer from it, never answer a prompt twice, hand the form back when it has no page for the question,
and take none up for a lone question.
