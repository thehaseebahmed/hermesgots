# A dismissed notification is dismissed on every device

A user reads or answers a notification on their phone, and the same news is still sitting in the tray
of their desktop PWA, or of their other phone. Nothing today crosses: `dismiss` in `src/lib/push.ts`
closes the entries of the device it runs on, a tap closes the row it came from, and the tray's own
Mark as read moves a read mark on that one phone.

**The decision: a dismissal is a fact about the account. The device that acted tells the account, and
every other device clears its own tray.**

No push protocol can remove a notification from another device — APNs, FCM and Web Push only
deliver. So the fact is fanned out per transport, and each device answers it with the tray calls it
already has. That is the shape every multi-device app uses: WhatsApp and Signal fan read receipts to
every session and each client drops that chat's notifications; Slack keeps read state server-side per
channel and clears locally on the read event; iMessage clears the other devices' notifications by a
silent push to them; Telegram sends the read state as an update to every connected session. ntfy,
which this app's third transport publishes to, has it built in: `PUT /<topic>/<sequence_id>/clear`
emits a `message_clear` every subscribed client drops that notification for.

- The subject is the id a notification is about, which both trays already key their entries by — a
  session, a room, a mission, a meeting, a routine's job, a project (`pushSubject` in
  `src/lib/push-kinds.ts`, `Notice.subjectOf` on Android). Nothing new is stored on a phone.
- The registry owns the account's Android installs: `POST dismiss` (the app, user caller) and
  `POST push/dismiss` (a host's relay) send a data-only `{kind: "clear", session_id}` to every
  device but the one that asked. `GotsMessagingService` cancels the active entries whose tag is
  about the subject.
- Each bot's plugin owns its own web subscriptions and its ntfy topic: `POST push/dismiss` sends a
  clear push to every subscription but the origin device's, and publishes one ntfy clear per
  (category, subject) it still has outstanding — ntfy clears by the pair's sequence id, and a
  dismissal names only the id, so `push_live` keeps what a publish went out under.
- The gestures that dismiss are the ones the app already answers locally: a screen about the subject
  becoming visible, a tap, an approval answered (the host tells, since a button posts from a receiver
  that holds no account key), and the tray's Mark as read and a swipe, which queue the subject for
  the page the way a read press already queues its chat.
- Best effort throughout, like every other push here. A device that missed a clear — an expired
  subscription, a rotated token — keeps its entry until it next opens that screen. A server-side
  ledger of dismissed subjects to reconcile against was considered and left out: it is state this
  feature does not need yet.

**Cost, known.** One registry call and one call per bot on each dismissal, throttled to one per
subject per minute per device, so a tab switch doesn't re-tell the account. A clear shows one silent
entry it closes at once on the web, because Safari revokes a subscription whose pushes never show
anything. A chat whose session was compressed holds notifications about an older session than
`chatSubject` now names, so neither the local dismissal nor the broadcast reaches them — the entry
and the screen already disagreed before this change.
