---
status: superseded by ADR-0038
---

# A finished phrase is cleaned up by the bot's model before it is committed

A speech model writes down what it heard, not what was meant. It keeps every "um", it cannot tell a
list from a run-on, and it punctuates by pause rather than by grammar. That gap is most of what
separates a dictation that can be sent from one that has to be edited — and it is a text problem, not
an audio one, so the fix belongs after the phrase, not in a bigger model.

Each phrase is cleaned up as it finishes: fillers out, punctuation and casing repaired, numbers and
dates written as numbers and dates, spacing tidied, a spoken list turned into a list, and the bot's
vocabulary spelled the way it is spelled. It never rewords. The cleanup runs while the user keeps
talking, so its few hundred milliseconds are spent behind the words instead of in front of them; by
the time a phrase is read it is already clean, and only the tail phrase — the one that finishes when
the user stops — is exposed.

It runs on the bot's own model through the plugin's model access, which is what makes it cost
nothing extra and need no key. That model can be a slow one, so the Dictation tab carries an override,
respected only where the plugin's own model-override permission is granted. The call is bounded: when
it misses its budget or fails, the phrase is committed as the host heard it. A cleanup that arrives
late is worse than one that did not arrive.

## Considered options

- **Deterministic rules only.** Free, instant, and predictable — and it cannot mend a dropped word, a
  run-on, or a misheard number, which is most of what is left after the model's own punctuation.
- **One pass over the whole dictation at Stop.** The only shape that can fix grammar across
  sentences, and it rewrites text the user has already read, at the exact moment they are reading it.
  Rejected: the whole design of the take is that the text never moves once it is on screen.
- **A dedicated fast model with its own key.** Predictable latency, another key to enter, and a
  second vendor in a feature this ADR's sibling (ADR 0015) just took a vendor out of.
- **Rewording for grammar, not just cleanup.** Rejected: the user's words are the message, and a
  model given licence to reword will occasionally change what they said.

## Consequences

- The phrase is the unit of commit, cleanup and undo of meaning: nothing is cleaned up twice, and a
  phrase is never re-cleaned when a later window hears it again — it is already committed.
- Cleanup's instructions carry the bot's vocabulary, so a name the host heard as a common word is
  corrected to the word the user means. The decoder's prompt carries it too; the two together are why
  the vocabulary is worth a settings surface.
- The bound is two seconds (`dictation_cleanup.DEADLINE_S`), kept by the host on a thread of its
  own, because the plugin's model access takes no timeout: the phrase is committed when the budget
  is up whatever the model is still doing. The app's own wait on the answer that carries the phrase
  is longer, so a cleanup is never what a slice times out on.
- "Much longer or shorter" is measured in words: an answer that loses more than half the phrase or
  adds more than half again is discarded, with a word of slack each way so a short phrase whose
  number became a digit — "twenty five" is 25 — is still a tidying.
- Every phrase costs one small model call. A take with twenty phrases costs twenty of them, which is
  the price of the text being clean while it appears; a bot whose model is expensive is a bot whose
  user should set the override.
- A reply that comes back much longer or shorter than what went in is discarded and the raw phrase is
  kept, so a model that decides to help is not allowed to rewrite the message.
- The tail phrase's cleanup is the one the user waits for at Stop or Send, so it is the one with the
  tightest budget and the one that must never be allowed to fail the take.
