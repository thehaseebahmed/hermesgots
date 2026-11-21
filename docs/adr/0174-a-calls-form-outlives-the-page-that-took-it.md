# A call's form outlives the page that took it

**The question:** Hermes asks a clarify call's questions one prompt at a time. The card is one form of
pages, sent once, and then answers each question as the host asks it, with no tap. ADR 0163 gave that
form a home above the card (`CarriedForm`) so a card drawn again in the host's gap takes it back — and
left one case open in as many words: *"the form also does not survive a reload, only a gap: a chat
opened again is empty."* Reported from a phone: a reader steps out of a chat mid-call, comes back after
the host has asked its first question, fills the whole form in and sends it — and one answer goes
through per visit, the rest asked again on each return, exactly the shape 0163 fixed for a page that
stayed open.

The page's own memory is what does not survive: the component that held the form is mounted again with
nothing in it, so the answers the reader gave ahead are gone between one prompt and the next, whatever
the card does with them. And the page's effect dropped the form whenever the page stopped counting the
run live — a stream that died between two prompts, which is what a phone asleep does — so a reader who
never left the chat lost it too.

**The decision: the form is the thread's, and it is written to the device beside `answers`.**
`ThreadState.clarifyForm` holds `{ run, key, taken }` — the run that asked the call, the card's own key
for it (`promptKey`), and the form as the card took it (`TakenForm`: the picks per question, and the
prompt it last answered). The card reports it through the same `onTaken`/`taken` pair 0163 built; the
page dispatches `clarify-form` instead of holding a `useState`, and the store writes it into the
`SessionState` record, so the next mount reads it back before the host's next prompt arrives.

**The marker is kept only once the host has taken it.** `TakenForm.answeredPrompt` is the send in flight:
it stops a card drawn again mid-send from sending twice, and it means nothing to a page that did not send
it. What the device keeps is `HeldForm.delivered`, stamped in the reducer when the page's own answer comes
back accepted (the call's question set is what names the id), and handed back on the take when the chat
opens again. A page that died mid-send therefore has no marker, and the reopened card sends the question
the host is asking rather than leaving it unanswerable; a page that died after the acknowledgement has
one, and the reopened card skips that question instead of sending it twice. Skipping is what keeps the
common case whole: the host still lists the question it took while it thinks about the next, and a re-send
in that gap is refused — which would hand the form back and lose the answers the reader gave ahead.

**Keyed by the run and the call, and dropped with the run.** The key 0163 chose is unchanged — one
string, the same the card is keyed by, so a form is never answered under another name. Because that
string is built from the call's questions, the set itself has to outlive a read that names no call: a
chat big enough to be served its newest page, or a read landing while the host thinks between two
prompts, would otherwise drop it, and the next prompt would be filed under another name — the answers
given ahead handed to nothing, one per visit again even with the chat left open. The set is therefore
kept until the run ends or another call's row names it. The run is what
makes it safe to keep on a device for longer than a page: the record is filed under the run that asked
the call, the card is handed it only when that run and its key are the ones being asked, and a form taken
where no prompt is being asked is dropped rather than kept for a later call. The form goes when the
turn ends (a done read or the run's own ending), when the host says the run is gone — including while
the answered card still holds the place and no prompt is on screen — when another run is joined, or when
the card hands it back: a refused send, or a question the form has no page for. It deliberately does
*not* go when the page's event stream ends: a phone asleep drops the stream while the run carries on,
and that is precisely the gap the form is kept for. That is the rule 0163 had to state in a page effect,
now stated in the reducer where the run's own endings are.

**What this leaves open.** The identity still has the hole 0163 recorded: two calls in one run that ask
the same questions in the same words, with the same ids, share a key, and the second would be handed
the first's form. Telling them apart needs the call's own id on the prompt, which is the host's to
carry. The form is written when the card takes it, on a send, not as the reader picks — a form half
filled in and abandoned before Send goes with the page, since a pick per keystroke is a device write
per keystroke and nothing has asked for one. An answer the host took but whose response was lost looks,
to the device, like a send that never landed: the reopened card sends it once more, the host refuses, and
the form comes back to the reader to answer the rest by hand — degraded, and never the inert card the
other way round would leave. The record also holds the form for as long as the run does, rather than only
between two prompts, so a call whose last question was answered leaves one more answer set on the device
until the turn ends — dropped with it, and never read by another run's card.

**The evidence.** `test-chat-next-waiting.tsx`: a two-question call filled on both pages, sent, the
device closed, the host's second prompt raised with the chat shut, and a device opened again on the
same database — the second answer goes in with no tap, and the form is on the device in between. Red on
the base commit (the second prompt asks again and nothing is sent), green with this. The reducer's
rules — held under the prompt's run, a repeat writes nothing, handed back on a refusal, dropped when the
turn ends, when the run ends, when the host names no run, or when another run is joined — are
`test-chat-next-state.tsx`'s; the round trip through the device, and the marker it does not keep, are
`test-chat-next-store.tsx`'s; and
`question-reload-many`'s fourth leg fills the form, sends it, leaves the chat while the host thinks
about the next question, and reads `Got 5 of 5 answers.` with the chat opened again.
