# A failure's own words are drawn where it happened

The app reports a failed write by putting the host's own sentence in a toast. Of the hundred and seven
error toasts this repository had, ninety-seven repeat what the host said, most of them through one
shape: `error instanceof Error ? error.message : "Couldn't save that."` The app's sentence is the
fallback; the sentence the reader actually gets is usually the host's, and it is a sentence they may
have to read twice, act on, or copy into a support thread. A toast shows it for two to four seconds,
near the foot of the screen, away from the control that caused it, and on a phone it is the platform's
toast, which the page cannot hold open.

**So a failure's own words are drawn in the screen that caused it, and the app's own sentences stay
toasts.** Two kinds of words were being treated as one. A host's sentence is about *this* attempt,
under *this* control, and it belongs where the control is, with a way to dismiss it: `Refusal`, a
`Banner` of the error tone over `Alert`, whose `role="alert"` is what announces it and whose `Dismiss`
is `Retry`'s twin. An app-authored sentence — "Couldn't save that.", "That isn't a number." — is a
fact about the app, not about the attempt, and it is exactly what a toast is for. `attempt` answers
rather than announcing: `{ ok: true } | { ok: false, said?, alone }`, where `said` is the host's words
and `alone` the sentence the call would have said by itself. The seam reaches no toast at all, which
is what makes drawing a failure in its surface the only way a caller can report one.

**The decision is made once, in `refuse`.** `refuse` holds the host's words where the write was made,
and says the app's sentence in passing when the host said nothing usable — including when the failure
is the browser's own (`TypeError: Failed to fetch` is the network speaking, not the host), which
`lib/words.ts` decides by marking the app's sentences as its own rather than by guessing at spellings.
`useRefusal(subject)` holds one refusal per surface, keyed by what the surface is about, cleared as the
same control's next write starts, on a dismiss, on unmount, and when the subject changes: the same
reset `useReadAttempt` already gives a read, for the same reason. A surface with no notice in the tree
— a routine's message row, a page mounted without its `Screen` — says the words in passing rather than
keeping them where nothing draws.

**The rule is held by a guard, not by memory.** `scripts/test-error-toasts.mjs` reads every source file
with the TypeScript compiler and fails a toast whose words are built from a failure — a `.message` or
`.say` read, a caught binding, `String(error)`, or any of those inside a template or a `+` — and fails
a call to `attempt` whose answer is dropped. What it cannot see, it says it cannot see: a message
carried through a renamed local, a helper it does not know, a module that re-exports the seam. The
places that legitimately keep a host's words are named in `scripts/error-toast-allowlist.json` by file
**and** function, with a reason, one call each, under a stated ceiling; an entry that no longer holds
its call fails, and so does a list that grows. The list stands at thirty-one, the work the next change
picks up one entry at a time.
