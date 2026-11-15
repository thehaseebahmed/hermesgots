# A phone picks its notification transport, and Settings has one Notifications entry

The Android app could be notified one way: Firebase, through the registry, because the service
account key that sends it cannot live on a user's Hermes host. An APK built without a
`google-services.json` therefore had no notifications at all and no row saying so. Settings also
carried the feature twice — a *Notifications* switch on the menu and a *Notification settings* row
beside it that meant something different on each platform (ADR 0050).

## Decision

**ntfy is a second transport for the phone.** The plugin publishes the same news to a topic on an
ntfy server, and the ntfy app on the phone shows it. ntfy needs no key that can't live on a host, so
the plugin publishes itself (`plugin/ntfy.py`) and the registry is not involved. A build without
Firebase offers ntfy alone; a build with it stays on Firebase until the user picks ntfy.

**This is not Hermes's ntfy delivery platform.** That carries a routine's own answer to a channel
set up in Hermes. This carries "a session needs you" to the user's phone. They share a protocol and
no configuration, and nothing wires one to the other.

**The choices that were Haseeb's** (asked 2026-11-15, not decided for him):

- *Server*: **any** http or https server, `https://ntfy.sh` prefilled. Whether the bot's host can
  reach it is the host's own network's business, so a LAN, loopback or plain-http server is taken.
  The plugin therefore posts to whatever address the app hands it; the caller already holds the
  bot's API key, which is the authority to start the agent on that host.
- *Topic*: **per bot profile**, not per device and not per account (changed 2026-11-15, after first
  being per account). The target — server, topic, token — is the profile's own, held by its host, so
  it follows the bot to every phone: a second phone reads it from the host and joins it without the
  token being typed again. A phone keeps only whether it is on (`Settings.ntfyOn`). The categories a
  topic carries are still one list for every phone on it, and the "app is open, say nothing" rule can
  only hold a publish back while *every* phone that chose ntfy has the app open.
- *Auth*: an access token is **required**. It is stored in plain text on the bot's host beside the
  bot's API key, sent as `Authorization: Bearer`, and never read back — a host answers only
  `token_set`, and a form may leave the field empty to keep the one the host holds.
- *Existing installs*: keep Firebase as the default where the build has it.
- *Name*: the one entry is **Notifications**.
- *Tap*: the notification carries `gots://open?kind=&id=`, which opens the Android app.
- *Firebase's system row*: kept, inside the merged screen.

**Firebase is one setting for all bots; ntfy is a setting of each bot** (2026-11-15). The menu has a
single *Notifications* row saying On or Off (and the transport, where there is a choice). Its screen
is the device's: the switch, the Delivery pick, and the types. It asks the transport what it can do
(`src/lib/push-transport.ts`) rather than the platform: Firebase, whose categories are the phone's
channels, gets the row that opens Android's own settings, shown while notifications are off too;
Web Push and ntfy, with no channel per category, get the app's own list, which the sender enforces.
With ntfy the screen also lists the bots, one row each saying where that bot publishes, and a row
opens the bot's own **Notifications** page in its settings (`/settings/bots/<id>/notifications`,
gated on `push_ntfy`). That page holds the bot's server, topic and access token as rows, each opening
the edit every other setting uses — a pushed screen below 1024px and a centred card from it
(ADR 0055) — and *Remove ntfy* at its foot behind a confirmation. The host takes the target a field at
a time and publishes only once it holds all three; moving it to another server drops the token,
which belongs to the server it was made on.

**No fourth copy of the lists.** The category ids stay in the three places they were. ntfy's sender
reuses the plugin's `CATEGORIES` and `LEGACY_CATEGORIES`; each category's importance is sent by the
app with the target instead of being restated on the host. The one thing copied is the sentence a
notification says (`WORDS`), which the sender has to hold, and `plugin/tests/test_ntfy.py` fails
when it drifts from `fcm.ts`.

**One device, one transport.** Picking a transport turns the other off first: Firebase's token is
deleted from the registry, or the phone leaves the topic. Because that delete can fail offline, the
plugin also tells the registry to skip every device that chose ntfy, so a token left on file stays
quiet.

## What ntfy loses

- **Channels.** ntfy's Android app has a channel per *priority*, not per category. Importance
  survives as priority (4 peeks, 3 sounds, 2 is silent); a category's own sound, its Do Not Disturb
  override and its switch in Android's settings do not. The switch moves to the sender.
- **The tray.** The notification is the ntfy app's, so the app cannot take it out of the tray when
  its screen is opened (ADR 0132), and it wears ntfy's icon rather than the app's.
- **Truth.** ntfy's own mute and minimum-priority settings are invisible to the app, which can read
  *On* while the phone stays silent.
- **Privacy and limits.** The server operator sees the topic and every title. ntfy.sh caches a
  message for twelve hours and holds its publishers to its own daily limits.

