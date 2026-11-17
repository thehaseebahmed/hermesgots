# A speech setting is followed by the answer it moves

**The question:** the switch on a bot's Speech-to-text page did not take effect in the chat's
composer until five minutes had passed. Where does a setting that another screen draws from have to
send the news?

Enabling speech-to-text on a bot's own page did not take effect in the composer. The switch is on the
Speech-to-text page (`stt.enabled`, written through the host's `stt` route); the mic is in a chat, and
it is drawn from the host's own answer about whether it can hear a take — `dictation.info()`, which
the plugin recomputes from `is_stt_enabled` on every call. So the host was right about the switch the
whole time. The device was not: `readDictationInfo` in `lib/dictation.ts` keeps that answer per
connection for `DICTATION_INFO_MS`, five minutes, and returns it without asking again; the composer's
`useDictationInfo` poll runs `onShow: false`, and a read of its own would only have hit the same
five-minute copy. Nothing in the write path touched that copy, so a reader who flipped the switch,
went back to the chat and found the mic still greyed out — "Speech-to-text is turned off on the
host." — read it as the switch having done nothing, and could wait up to five minutes for the poll
to say otherwise.

**The decision: a write of the two settings that answer it is followed at once by the read that says
what it did.** `writeStt` in `lib/host-speech.ts` answers the host's fresh block and then calls
`refreshDictationInfo`, which is `readDictationInfo`'s own forced read. A chat already open takes the
change in the frame it lands (`useSyncExternalStore` on the same map); a chat opened afterwards
composes from the fresh answer, which is the case the report describes — the page replaced the chat,
and the composer mounted again on a copy that predated the switch.

**The two settings are the pair that answer the question, not the whole page.** The rest of the page
— the local model, the language, the initial prompt, the VAD and its thresholds, the trim, the echo,
each provider's own model — is `writeStt`'s too, and none of them moves whether or where the host
hears a take. `HEARD_KEYS` in `lib/host-speech.ts` is that pair (`stt.enabled`, and the provider the
host resolves), and a write of any other key leaves the mic where it is. `write`'s own keys (the
speech model, the cleanup model, the level, the Hearing prompt) are not followed by a read either:
refreshing the level would close ADR 0074's stated stale bound by the same stroke, which is a
decision that ADR owns and this one does not make.

**Three guards make the forced read safe, and each is load-bearing.**

- The answer on hand stands until the new one lands, so turning the feature *on* does not flicker
  through the greyed control the reader was looking at.
- A forced read that fails leaves the copy's clock where it was. Re-stamping it would hold the answer
  from before the write for another five minutes — the staleness this change exists to remove, in the
  one case the host cannot answer.
- A read already in flight when the write landed is dropped instead of landing: `generations`, per
  connection, is `features.ts`'s own idiom for the same race (a read begun before a refresh writes
  nothing), because the composer's poll and the write can be out at the same moment, and the poll's
  answer would otherwise put the pre-write answer back and stamp it fresh.

The poll's pace is untouched: a host moved by something this device did not write still waits for a
read, which is the pace ADR 0074 records for the shared answer. What changed there is where the news
comes from — **the host says it, on the stream it already keeps open**, rather than each device
waiting out its copy.

**A write made elsewhere is news the host publishes.** The answer lives on the bot's host, and the
writes that move it are not all this device's: another phone's settings page, and a `hermes` on the
command line editing `stt:` by hand. Two halves, one per writer:

- The plugin notes a `settings` row when its own settings route writes a key — the `stt` route, and
  General's and the providers' beside it, since they share one handler. Every stream open on that
  profile carries it within a tick, and every device that hears it reads the answer again.
- The file's other writers have no hook here at all, so `stream.watch_config` stamps the profile's
  `config.yaml` — its size and the moment it changed — on a two-second tick, and a moved stamp
  becomes a row like any other. A row, not a live frame, so a device that was away reads it back from
  its own cursor, and one that was listening hears it in a couple of seconds.

Neither is throttled. The ledger coalesces a tool loop's rows inside a quarter of a second, which is
right for a loop and wrong here: two settings written a moment apart are two changes, and a device
told to read once would keep the state between them.

**The app draws it wherever the answer is drawn.** `settings` is a kind in `lib/live.ts`, and
`useDictationInfo` re-reads when a frame names its own connection — the composer's mic and the
Bubble's mirror go through it, and the composer is never remounted, which is the case the second
report named: a chat already on screen, a switch flipped on another device.

## Considered options

- **Reading `info` again every time the page comes back into view** (`onShow: true` on the composer's
  poll). Rejected: `readDictationInfo` answers from the five-minute copy without a force, so
  returning to the chat would still read the answer from before the switch. Making every return a
  forced read also puts a request on every app resume, for a fact that changes when somebody flips a
  switch and not otherwise.
- **Shortening `DICTATION_INFO_MS`.** Rejected: the answer feeds `wait_ms`, which the take's bar holds
  to, and the pace is ADR 0074's.
- **Dropping the kept answer on a write and letting the next read start from `checking`.** Rejected:
  the composer draws a disabled mic while it is checking, so turning the feature *on* would flicker
  through the same greyed control the reader was looking at, and turning it *off* would leave a mic
  that still looks pressable for the length of a request.
- **Writing the answer locally from the setting the device just sent** — the switch says on, so the
  mic appears without asking anything. Rejected: whether a take can be heard is not one key. The host
  also answers whether a provider resolves, whether a key is set, and which local backend it has, so
  a device drawing its own answer would offer a mic that cannot record — the failure ADR 0069 was
  written to end.
- **Reading again after every speech write, the level and the model among them.** Rejected: it is a
  second decision (ADR 0074's bound), and the report is about whether the mic is there at all.
- **Putting the refresh inside `write`, so no future writer can forget it, or inside `hermes.ts`,
  where the route that moved the answer lives.** Rejected for now: `setSttSetting` has one caller, so
  nothing can forget it today; `write` would drag ADR 0074's bound along; and `hermes.ts` cannot reach
  the map without inverting an import, which is a registry of its own — a change big enough to be its
  own task.
- **A short life for just the readiness answer, read when the app comes back into view** — a small
  route with a 15–30 second copy, so a device hears another writer soon after it looks. Rejected: it
  is still a timer and still a guess about when to look, the answer rides `/info` beside the feature
  list and a rooms roster (so a short pace is an expensive one), and it cannot tell a device that is
  already on screen and idle. The stream costs one stat per store every two seconds and no request at
  all until something changes.
- **Drawing the mic always and letting the first take carry the host's refusal.** Rejected: that is
  the mic ADR 0069 was written to remove — a control that looks usable and is not — and it trades a
  stale answer for a failed take.
- **A push notification per settings change.** Rejected: the phone already has a stream open while
  the app is on screen, which is when this matters; a push for a switch would also wake a device that
  cannot draw anything of it.

## Consequences

- A write of either key costs one more read of the same `info` route the composer already polls. It
  answers the feature list as well, and it happens at the press rather than on a timer. A provider
  pick is the one write that costs two: the route reads `speech` after it as well, which it already
  did for the row the pick moved (ADR 0132).
- `refreshDictationInfo` is the forced read and nothing else, so the other readers of that answer
  follow it with no change of their own: the phone's Bubble (`primeDictationInfo`), the take's own
  `dictationWaitMs`, and whether a take leaves the host all read the same map.
- A write made by another device, or by a `hermes` on the CLI, reaches this one in about two seconds
  while the app is on screen, as one row on the stream that was already open and one read of `/info`.
  A phone with the app closed learns nothing until it opens — where its first read is fresh anyway —
  or, if it was following before it went away, replays the row from its cursor.
- The settings reader is one task per store for the plugin's life, as the title reader is: a stat
  every two seconds, and none of the cost is per device.
- A host whose plugin is older than this sends no `settings` frame, so the app falls back to what it
  had: five minutes, the read on mount, and the mic's own retry.
- Both surfaces that draw this composer — `chat-next`'s page and the route's own `chat.tsx` — hold the
  same component and therefore the same fix; a room's chat and a canvas's do too.
- `scripts/test-composer-dictation.tsx` pins the three cases: the switch flipped here and the chat
  opened afterwards, the same flipped off, and a switch written on another device with the chat
  already open and never remounted. The plugin's two writers have their own tests —
  `test_settings_events` for the route and `test_stream_settings` for the file. The failed-refresh
  clock and the generation drop are still reasoned here without a case of their own.
- **Left open:** the app keeps that host answer twice. `lib/features.ts` holds its own copy of the same
  `/info` for the feature list and the rooms roster, on its own pace, so the two can disagree — the
  plugin advertising a feature this answer refuses. Collapsing them into one cached read with each
  reader taking its field is the deeper fix, and it rewrites ADR 0128's and ADR 0074's paces together.
