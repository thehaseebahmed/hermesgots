# Every notification type is named for what happened, and a phone switches them in Android's own screen

Status: grilled 2026-10-24, every decision settled and recorded in ADR 0050. Published as #557 with
tickets #558, #559, #560, #561 and #562; the build order at the end is the tickets' shape when
implementation starts. #557 is blocked by the gate issue #564 that this docs pull request (#563)
closes — work starts on that merge. The spec carries `ready-for-agent` and the tickets stay bare, so
the agent claims the spec and works the graph in order.

## Goal

Every notification type keeps its own switch, and each platform switches them where its user already
goes. On the web the **Notification settings** row opens the app's list — five features, sixteen
types, a bulk switch per feature — because the web has no channels and that list is the only switch
there is. On Android the same row opens the phone's own notification settings for Gots: the master
switch, then every channel with its own on/off, sound and peek setting. The app offers no list of its
own there at all, and reads the phone instead: at launch and on every resume it asks which channels
exist and what importance each holds, and registers only the ones still allowed — an importance of
none being the user's no — with an empty list when notifications are off altogether. Coming back from
the phone's screen is a resume, so a channel switched off there reaches the registry on the way back
into the app. Each type is renamed for the event it reports and reads as *Feature: event* in
Android's flat list and as the bare event under its feature heading on the web; only what waits on the
user peeks over the screen; and a channel exists only if this device can reach what it is about.

## What this is not

- **Not a change to what a push says.** The body sentence, the title, the bot character and where a
  tap lands are untouched; this is about which types a device wants and what they are called.
- **Not a new set of types.** The sixteen stay sixteen, on their existing ids, so a phone keeps its
  channels and its history; nothing is merged, split or added.
- **Not a change to muting.** A bot's mute and a chat's mute stay on the plugin, so they work with the
  app closed and on every device — a different thing from switching a type off.
- **Not a change to delivery.** The plugin, the registry's send path and Firebase stay as they are,
  beyond the test push's channel.
- **Not the web's layout.** The in-app list keeps its feature headings, its order, its bulk switches
  and its defaults; only its name changes.
- **Not turning things on from the app.** Android owns the master switch and each channel's sound and
  peek; the app only reads them back.
- **Not iOS.** There is no iOS app, and a PWA on iOS has no channels — it keeps the list, which is the
  only switch there.
- **Not the implementation.** This spec, ADR 0050 and the glossary entries are what this change ships
  first; the build is the five tickets below, once the pull request carrying this file merges.

## Decisions

1. **The platform owns where its types are switched.** On Android the row opens the phone's
   app-notification settings screen; on the web it opens the app's list. The in-app list survives as
   the web's, and is linked from nowhere on Android (ADR 0050).
2. **The phone is read, not asked.** Each channel's live importance decides what the registry is
   told: none means switched off and left out, an id the phone doesn't list means the channel hasn't
   been created and counts as allowed. A type switched off costs no push, which is the only thing the
   app's old second switch was ever good for.
3. **Notifications off at the phone is an empty list, not a deleted device.** The registration stays
   with an empty list and the app's own switch stays as the user left it, so turning the phone's
   notifications back on resumes delivery with nothing else to do.
4. **The app's per-type preferences become a web-only fact.** Nothing deletes them from a phone; they
   are simply no longer consulted there.
5. **A title names the event.** No article, no pronoun, no sentence: two change — *Pull request ready
   to review* and *Brief or scope to review* — and the other fourteen already read that way.
6. **The feature prefix is the platform's, not the title's.** Android's flat list shows *Code: Pull
   request ready to review* because it has no headings; the web shows the bare title under the
   heading. Routines carries no prefix, its one type already naming it.
7. **Only what waits on the user peeks.** Importance 4 for the four categories that wait on the user,
   3 for every failure and every completion, 2 for a merged pull request. Run failed drops from 4 to
   3: a failure nobody saw coming should not take over the screen.
8. **Importance is a first word only.** Android hands the value to its user on the first edit and the
   app never writes it again — a channel's default is fixed the day a device makes its channel.
9. **A channel exists only if it can be reached.** Meetings' two are created only once that experiment
   is on; the rest are always created.
10. **The test push makes its channel when it is sent.** Nothing is created at launch for it, so a
    device that never sends one never lists it; the channel an earlier build created is deleted at
    launch.
11. **The row is called *Notification settings* on both, and always shows on Android.** The phone's
    screen is where a blocked permission is fixed, so the row is most needed exactly when
    notifications are off; the web keeps today's rule and hides it while they are off.
12. **A device updating is re-registered once.** The registry filters by the list a device last sent,
    so an install carrying an older subset is told the live one on its first resume — otherwise
    handing the switches to the phone would silently stop pushes that already exist.

## Where it lives

| Path | What it is |
| --- | --- |
| `app/src/lib/push-kinds.ts` | The sixteen titles, the feature prefix, the importance each is created with |
| `app/src/lib/push.ts` | Read the phone's channels, the registration list, which channels are created, the test push's channel, the legacy delete |
| `app/src/routes/settings.tsx` | The row's name, where it opens, when it shows, the web list's title |
| `app/src/lib/native.ts` | The bridge that opens the phone's notification settings |
| `app/android/app/src/main/java/app/memento/` | The native plugin for that screen, registered beside the two already there |
| `app/netlify/lib/fcm.ts` | The test push's channel |
| `app/scripts/test-*.mjs` | Unit rules: the name and importance, the registration list |
| `app/scripts/test-*.tsx` | The component test over the row |
| `docs/adr/0050-a-phone-is-switched-in-androids-settings-the-web-in-the-app.md` | The decision |
| `GLOSSARY.md` | **Push**, **Kind**, **Category**, **Channel**, **Notification settings** |
| `AGENTS.md` | The paragraph saying each category is a switch under Settings, corrected to say where each platform switches it |

## Edges

- **A channel switched off in Android's settings** — the next resume leaves it out of the
  registration, so its pushes stop being sent rather than being sent and dropped.
- **Coming back from the phone's screen** — returning to the app is a resume, so the choice takes
  effect with no restart.
- **The phone's notifications turned off entirely** — the registration carries an empty list, the
  device stays registered, the app's own switch keeps reading what the user set, and turning them back
  on resumes delivery on the next resume.
- **A channel the phone doesn't list** — not yet created, so it counts as allowed; a first launch
  therefore registers everything.
- **A channel the user edited** — its importance is theirs from then on; a later launch renames the
  channel but cannot change what it does.
- **A device that already had the old names** — the ids are unchanged, so the ten renamed channels
  update in place and no switch is lost.
- **A device that never sends a test** — no test channel exists on it, so Android's list holds only
  things that really happen.
- **Meetings turned off** — its two channels are not created; turned on later, they are created on the
  next launch, with their defaults, and Android lists them from then on.
- **An APK without Firebase** — no row, since there is nothing to configure and no channels exist.
- **A bot or a chat muted** — unchanged: the plugin holds the mute, and the push never leaves the
  host, whichever platform the device is.
- **390px and tablet widths** — the web's list and the renamed row hold at both, in light and dark;
  the Android screen is Android's own.

## Tests

Cheapest tier that would fail for the reason the change can fail (ADR 0019):

- **Unit** — the naming rule (title, prefix, importance) and the registration list (blocked left out,
  uncreated allowed, empty when off, complete otherwise, only a change sent again) are pure rules over
  plain inputs: the tier where they can be driven exhaustively, following the repo's existing
  pure-rule scripts.
- **Component** — the settings row rendered over a seeded device database with the host faked, for
  which screen it opens on each platform and whether it shows while notifications are off.
- **End to end** — nothing here is geometry, so no new flow. The flows that already touch Settings run
  by name, since the row, its name and its visibility are what they see.
- **The plugin and the registry** — the four-list parity test is what catches a name inserted in the
  wrong position, and the plugin's own suite covers the test push's channel.

## Gates

From `app/`: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and for the native half the
Android `lintDebug` check CI already runs. From the repo root: `python3 -m unittest discover -s
plugin/tests -t .`. The flows touching Settings run by name rather than through the nightly registry
(ADR 0029).

## Build order

1. #558 — feat(push): name every notification type for the event it reports. Edge: none.
2. #559 — feat(settings): send the phone to Android's notification settings. Edge: none.
3. #560 — feat(push): give a phone the channels it can actually reach. Edge: #558.
4. #561 — feat(push): register only the channels the phone still allows. Edge: #560.
5. #562 — test(push): prove the notification names and the phone's channel list. Edge: #558, #559,
   #560, #561.

## Risks

- **The registry silently filtering everything out.** The registry keeps the categories a device last
  sent and falls back to `chat_input` and `code_input` alone when it has none, so an install whose
  stored list is stale would keep dropping pushes. The re-registration on the first resume is the fix,
  and a review should see it in the same ticket that hands the switches to the phone.
- **A channel's default being written after a user edited it.** Android ignores an app's later change
  to a channel its user has touched, so importance is set at creation and never again — a ticket that
  writes importance on every launch is wrong even though nothing visibly breaks at first.
- **A read that runs before the channels exist.** The resume read must follow channel creation, or a
  first launch registers an empty list and the phone gets nothing until it is brought to the front
  again.
- **Two switch lists by accident.** The in-app list must stop being linked on Android in the same
  change that opens the phone's screen; leaving it reachable puts back the disagreement this ends.
- **Renaming dropping a switch.** Channel ids must not change with the titles, or every existing
  device starts with its types back at their defaults.
- **The test push landing in nothing.** Its channel is created on the tap; a send that outruns that
  creation would post into no channel and fail silently, so the tap creates before it sends.
