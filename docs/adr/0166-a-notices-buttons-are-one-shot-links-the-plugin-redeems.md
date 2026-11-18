# A notice's buttons are one-shot links the plugin redeems

An Android notice about a chat is drawn as that chat's conversation, and it carries Reply on a finished
or failed run and Mark as read on those and a routine's message. A Reply has to reach the bot with the app
closed, but the phone holds no bot key it may use from a broadcast receiver.

**The decision: every button that acts on the host is a one-shot link the plugin minted for that notice,
and the plugin redeems it.**

- Approvals already worked this way (`push/answer/{token}`). Reply is the same kind of link,
  `push/reply/{token}`. Its purpose is stored with its hash, so a reply link can't answer an approval and an
  approval link can't post a reply (`answers.claim` redeems only the purposes the caller allows).
- A redeemed reply is queued on the chat's session in the plugin's own outbox, with a body the plugin
  builds: the chat's pinned model, the app's run hint and a project session's prompt. It counts as the
  user sending again, so a queue a failed run paused goes on. The dispatcher posts it with the home's own
  key.
- A reply link lives a day, longer than the push, because a tray entry outlives its delivery. It is
  withdrawn when the registry answers that no phone received the notice, so no live credential sits
  where nobody can press it.
- Mark as read touches no host. The phone queues the press, and the page drains the queue into this
  device's read mark the next time it runs.
- Android draws the conversation itself. The notice names the chat, the phone keeps one long-lived
  shortcut per chat, and the bot's plain face is the sender, so Android badges it with the app's icon.
  The browser tray and ntfy keep the badged `notify.png` and get no buttons.

**Cost, known.** A reply link is a bearer credential that can queue one message for a day. Each notice
takes one reply; more happen in the app. On a bot still using the old chat screen, a catch-up that lands
the notice's own turn more than a minute late can bring its dot back, because no row on the device tells
that turn from a newer one. The dot errs towards showing, never towards hiding news.
