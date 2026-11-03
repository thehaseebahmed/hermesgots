# Cleanup is only for a take its host transcribes

A take leaves the host whenever the bot's **Speech provider** is a cloud one (ADR 0069), and the
**Confirm** ran **Cleanup** on it anyway (ADR 0074). So a Groq take was decoded by a vendor and then
rewritten by a second model that never heard the audio and could not check one word of it against the
recording, while the bot's Speech-to-text page offered the **Cleanup level** and the cleanup model as
live choices whose effect nobody could see. The two texts were the only evidence, and their difference
could not be attributed to either model.

The rule is now the bot's route: Cleanup runs only for a take its host transcribed. A take that left
the host is transcribed once and those words are what land — the level answered as **None**, `cleaned`
false, `heard` equal to the text, so the sheet draws one block. The bot's level is not cleared,
rewritten or validated: it is kept, unread, and read again the moment the route is **Local**, so a bot
sent to a vendor for a week does not come home at **Light**.

The rule lives in the host, inside the Confirm, because that is the one call that runs Cleanup and
because a second client confirming the same take must get the same answer as this one. The app draws
the consequences rather than deciding anything: the cleanup's three rows (the level, the model and the
**Hearing prompt**) greyed and untappable under one reason line, and a row's own muted line reading
**Not tidied** in the same words a take the user set to None reads — it is the same state, and the page
is where the why lives. A cloud take's bound shrinks with the work it no longer does: the number a
Confirm is held to carries the queue and the upload, and no cleanup deadline.

## Considered options

- **Cleaning every take, as ADR 0074 had it.** Today's behaviour: one rule, no branch, and a vendor's
  words tidied by a model that cannot hear what it is correcting. Rejected by the product rule, and
  rejected on its own account too — the second pass is invisible in the only two things a user reads.
- **Refusing the Confirm with a 409 when a cloud take's level is not None.** Keeps the wire honest and
  makes the rule impossible to ignore. Rejected: a refusal on the Confirm does not refuse a cleanup,
  it fails a finished take, so a user whose bot was left at Light loses the words they just said to a
  settings mismatch they may not know they have.
- **The app confirming with an explicit `none` for a cloud take.** No host change, and the level on the
  row becomes the app's claim rather than the host's. Rejected: the rule would live in the client a
  second client need not share, and the host would still be willing to clean.
- **Hiding the cleanup card on a cloud host.** A shorter page, and a reader cannot tell a setting that
  is unavailable from one the app never had. Rejected for greying: what a reader can see is what the
  bot holds.
- **Clearing the level on a cloud host, and restoring it on a return to Local.** One state, no stale
  setting. Rejected: the app does not know when the route changed, so the level would have to be
  remembered somewhere else, and a bot that briefly resolves a vendor would lose the level its user
  chose.

## Consequences

- A name the vendor misheard stays misheard on a cloud host. ADR 0069 leaned on the cleanup to carry
  the bot's **Vocabulary** and the chat's names exactly where a cloud decode sends no **Hearing
  prompt**; that repair is gone for as long as the bot's takes leave the host, and the page says why
  instead of pretending it still runs.
- A cloud bot's level is a setting that does nothing until the bot comes back to Local. It is kept
  rather than reset, and the app tells the reader that with a reason line rather than by hiding it.
- The row's line for a cloud take says **Not tidied**, which is what happened and not who chose it.
- A cloud take's Confirm bound is the queue plus the upload; a local take's still carries the level's
  own deadline, so a fifth level moves a local host's bar and not a cloud one's.
- Nothing on the wire changes shape. An older app confirms and reads the same answer, and only a build
  that knows the rule draws its reason.

This amends ADR 0074's clause that a complete take is tidied at the bot's level, and reverses ADR
0069's clause that the cleanup carries the bot's names on a cloud take. Everything else both decided
stands: the upload-then-Confirm wire, one text landing when a take ends, the bounded wait, and the
provider rule.
