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

- *Server and token*: **Hermes's own** (changed 2026-11-15). Hermes's ntfy platform reads
  `NTFY_SERVER_URL` (`https://ntfy.sh` where unset) and `NTFY_TOKEN` (a bearer token, or `user:pass`
  for Basic) from the profile's environment. The plugin reads the same two through
  `agent.credential_pool.get_env_prefer_dotenv` under the profile's scope, and writes them with
  Hermes's own `.env` writer, so a profile has one ntfy server and one token whichever side set
  them. Any http or https server is accepted: whether the host can reach it is the host's own
  network's business, and only a caller holding the bot's API key can set it. The token builds the
  same header Hermes builds from it.
- *Topic*: **Gots's own, per bot profile**, kept in the plugin's store, so it follows the bot to
  every phone and a second phone joins without typing anything. A phone keeps only whether it is on
  (`Settings.ntfyOn`). The topic Hermes listens on (`NTFY_TOPIC`) is refused, since Hermes reads
  what lands there as messages to the agent and would be handed its own notifications. The
  categories a topic carries are one list for every phone on it, and the "app is open, say nothing"
  rule holds a publish back only while *every* phone that chose ntfy has the app open.
- *Auth*: a token is **required** before anything is published, though Hermes's own platform
  treats `NTFY_TOKEN` as optional. It never leaves the host: a read answers only `token_set`.
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
With ntfy the screen also lists the bots exactly as Speech-to-text's Bots tab does — the Settings
menu's own row, the bot's picture, On or Off — each opening the bot's own **Notifications** page in
its settings (`/settings/bots/<id>/notifications`, gated on `push_ntfy`). That page captions its cards
by owner: *Gots* holds the Topic, *Hermes* holds the Server URL and the Auth token. Each value is a row
opening the edit every other setting uses — a pushed screen below 1024px and a centred card from it
(ADR 0055) — the server's edit has a Reset back to Hermes's default, and *Remove ntfy* at the foot
takes Gots's topic and its phones only, leaving Hermes's own variables alone.

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

