# A relayed link is pressed only by a phone the bot knows

ADR 0167 made a notice's Reply and an approval's buttons one-shot links the plugin redeems. The links
are bearer credentials, and on Android they travel in a data message through the Gots registry and
Firebase Cloud Messaging. FCM encrypts each hop with TLS but not the payload end to end
([Firebase](https://firebase.google.com/docs/cloud-messaging/encryption)), so whoever relays the push
can read the link. Until then the registry could not act on a bot at all, since the bot records it
stores are sealed to the account's inbox. A link let it, or Google, queue a turn for a day or answer an
approval for ten minutes. In an Auto project session that turn runs its tools without asking.

**The decision: a link minted for the relay is pressed only with a signature from a key the phone holds
in its Android Keystore.**

- Each phone makes a P-256 pair in its Keystore (`NoticeKey.kt`). The private half can't be read out.
  The page hands the public half to each bot's plugin over the bot's own key (`POST push/key`), and
  never through the registry, which could otherwise hand over a key of its own.
- A token minted for the relay is marked `signed` (`answer_tokens.signed`, schema v75). Every reply
  link is one, and the relay gets an approval pair of its own, separate from the pair Web Push and ntfy
  carry. A press of a signed token must carry `X-Gots-Key`, which names the key by the SHA-256 of its
  DER, and `X-Gots-Signature`, an ECDSA signature over `gots-notice-v1`, the purpose, the token and the
  reply's words. The route checks this before it claims the token, so a refused press is a 403 and
  spends nothing. The token is one-shot, so a signature can't be replayed.
- A profile no phone has handed a key to mints no relay link: no Reply, and no buttons on Android.
  An APK from before the key loses its tray buttons until it updates. A link that can't be pressed
  safely is worse than none.
- Signed relay links the registry put on no phone are withdrawn, as reply links already were.
- The browser's buttons stay a press alone. Web Push is encrypted to the browser (RFC 8291), so nobody
  in between reads them.

**Cost, known.**
- ntfy's buttons still travel readable by the ntfy server, as before.
- A notice's words are still readable by the registry and Google. Encrypting the whole payload to the
  device is #1110.
- Whoever controls the phone itself can use its key, as they can use the app.
