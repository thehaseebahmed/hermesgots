# An update is offered, from the row of the device it belongs to, and only a tap sends it

Status: built on the branch, in the ten steps the plan records. Design: [ADR 0175](../adr/0175-an-update-is-offered-before-it-runs.md), which records why an update is a state the reader enters rather than a walk that starts when the screen opens. The change map, the flows and the ten build steps with their checks are in the plan this spec writes down; every test named below is a case that exists in the suites, quoted as it is spelled there.

## Goal

The charm's firmware is the charm's, not the network's, and an update is something a reader asks for. Settings → Charm now reads device first: **Device** (the charm with its links and its charge — the level in the status row's line, with its age — then the firmware row), **Bots** (sync, pet mode and the pet), **Waking**, **Wi-Fi**, **Tailnet**, **Forget this charm** — and ends on the way out, with no voice rows and no closing caption: which scheme a sync hands the charm is read off the record rather than set from a row. The reader looks for what the device *is* before what it *does*, and a build is the first of those; the row was filed under **Network** because the image travels over a link, which is where a reader would never look for it. The Firmware group's two captions left with it: the everyday-build caveat went into the offer's What's-new sheet, where a reader is about to install, and the section's own line went for good because the row now says the one thing that caption said.

The Firmware row is a settings row like any other: **Firmware** over the versions line — *Charm 0.1.0 · 0.2.0 available*, *up to date*, *couldn't check for a newer one*, *this charm can't say which version it runs*, *newer than* — tagged **Update** only when the host publishes a build ahead of the charm's, its value replaced by the download's own line while a download runs, followed to its end rather than read once. A host that refused its read says so in its own sentence under the group; a tap opens `/settings/charm-firmware`. A page busy with another write opens no screen, since the row is disabled with the rest of the page.

Opening that screen draws an offer, and nothing leaves the phone until a tap. The offer carries two facts — the charm's **Battery** (its level, and **Charging** when it is) and its **Link** (*Wi-Fi up*, or a Wi-Fi that is joining or down) — and one tap: `Install 0.2.0`, naming the build it will send. The one instruction the link needs, **Keep the phone near the charm**, is the screen's foot, a caption under every group rather than a row in the offer, since a door is pressed on screens the offer is not on. `Choose a file…` sits beside the tap for a package the phone already holds, and a screen opened at `?file=1` draws that door alone, with no `Install`, because there is no build to name. The screen asks the charm for its charge and its links as the offer draws, and asks the charge once more as a door is pressed: the offer's reading is what the row says, and the tap's is what decides. No image is read, no fetch token minted and nothing written to the charm before that second answer. A reader who leaves mid-walk and returns joins the walk in flight and is not offered it again: the offer is drawn only where nothing is running, nothing has ended, and this visit has not already begun a walk for the published build.

## What this is not

- **Not an update that starts itself, or a schedule.** Nothing watches for a release, nothing installs one unattended, and no badge was added to the Settings menu row.
- **Not a change to the wire.** The update's frames, the fetch door, the mint and the SHA-256 check are the ones the charm's own protocol names, untouched by the offer.
- **Not a release history.** The What's-new sheet is the one published release's own words; there is no screen of past ones.
- **Not a cable-flashing guide.** The app says what the cable path is and points at the firmware repository, which owns the flasher, its port and its steps.
- **Not a change to what a sync sends.** The revisit `Done` asks for is the page's existing sync, run once; nothing in it is new.

## The gate

SwitchBot's own rule, in `chargeBlocks` (`app/src/lib/charm-words.ts`): a charm **under 20% and not charging** shuts both doors, and one line under the group says what opens them — *Charge the charm above 20% before updating.* **Charging passes at any level.** A charm that answers a percent below zero could not read its own charge, and an ask that failed is no fact at all, so neither ever blocks: an update is offered on what the charm said, never on what it did not.

**The charge is read when the offer draws and again at the tap.** The offer's own ask is what its Battery row says; the tap's ask is a confirmation of that row rather than a replacement of it, and it is the one that decides. A charm that has fallen under 20% since the screen opened — or one that was still unread when the offer drew — is refused where the door is pressed: no step is drawn, no walk begins, nothing is marked as begun, and the offer stays on screen with the line under it. Every tap that starts a send asks the same way, so the rule reaches the file door, a screen opened for a file alone under a host with nothing published, and the failure's `Try again`.

## The walk outlives the screen

The send is driven by its own promise rather than by the screen, in `charm-update-walk.ts`, so stepping back leaves the update running and the charm's page follows it: the Firmware row draws the download's own line and polls it until it stops. While a walk runs, one line under the title says exactly that — *You can leave this screen — the charm keeps going, and the Firmware row on the charm's page follows it.* — drawn once, and on neither the offer nor an end, because an offer has nothing in flight and an end has already stopped. The steps appear in the order they walk (Downloading, Transferring, Restarting), each with its bar at the bytes or the percent its own end reported, and a returning visit joins the walk rather than starting a second.

## Done, and one sync

Done names the build it came from and the one it runs: `Updated to 0.2.1 from 0.1.0.` A charm that answered after the reboot with no start read for it still changed something, so it says `Updated to 0.2.2.` — no `from` clause it never read — and only a walk that provably landed on the build it began on says one build, `The charm runs 0.2.1.`, since only that walk has no change to read. A re-flash of the same package is the fix-a-sick-charm move, not a failure: the end asks whether the build the charm answered is the one it was sent, so the published image lands on a charm already running it, over the phone's link and over the charm's own fetch alike, exactly as a reader's file does. Under it, `Sync your bots` lands on `/settings/charm?sync=1`; the page reads the parameter once it has a paired charm and its bots, clears it — that parameter alone, leaving the rest of the address as it arrived, with a `replace` *before* the sync runs — and runs the sync through a ref, so a redraw finds nothing to read and the radio is reached exactly once. A build usually wants the bots, the pet and the voice hand-over again, which is the whole of what that one sync is for.

## A failure, and the cable

A failure draws the charm's own reason in words, `Try again`, and `Flash it by cable`. The step it stopped at is marked — one row, `data-stopped`, its title in the destructive tone, the line it was already saying kept, and *The update stopped here.* after it — and the steps after it are not drawn, since they never began. Each step is drawn as it starts rather than with its first byte, so a host that refuses the image outright still leaves the step the walk was in on screen, marked, rather than a failure card with no row saying where it stopped. The cable row opens a sheet of three sentences: what the charm's own cancel means (the image never reached the slot, so the charm still runs the build it came on), what the path needs of the reader (a cable and a computer, no Bluetooth and no app), and where the flasher, its port and its steps live. Under them is one row, `Open the firmware repository`, which calls `openExternal` on `https://github.com/thehaseebahmed/hermesgots-charm` — the repository's root, not a deep path, because a path rots and a repository does not. The sheet carries no flashing steps of its own: that repository owns them, and a copy here would be a second, staler set.

A `Read the charm's log` row into `/settings/debug-charm` is drawn on a failure only while **Developer** is on, because the route behind it is `DeveloperOnly` and a row drawn without the switch would bounce the reader back to the menu.

## The notes, annotation to sheet

A release's own words travel annotation → plugin → app record → sheet, and each hop does one thing:

1. **The release writes `dev.gots.charm.notes` and `org.opencontainers.image.created`** onto the tag's manifest, beside the three required annotations. Both are optional, because every release published today names neither.
2. **`firmware.describe`** (`plugin/firmware.py`) answers `{ version, size, sha256, slot?, notes?, notesRefusal?, built? }`. Notes over `NOTES_CAP` (2,000 characters) are refused as the sentence `notesRefusal` carries — *The published charm firmware's notes are longer than the 2,000 characters this app draws, so they aren't shown.* — and the cap counts what the release wrote rather than what survives its whitespace: a 2,001-character note ending in a newline is over the cap, not at it. The refusal is **scoped to the notes alone**: `describe` still answers the version, the size and the SHA-256, so a chatty release is still offered and still installs. That scoping is what keeps a courtesy from taking the record down, since `latest()` and `image()` give back whatever `describe` raises.
3. **The build date is optional and left off when it does not parse**, not refused: a date nobody can read installs nothing, and a required one would stop every release in the field from being offered.
4. **The firmware route spreads the reader's record** (`plugin/__init__.py`), so the extra keys reach the app without a second read.
5. **`CharmFirmware`** (`app/src/lib/hermes.ts`) carries the record the screen needs, and the offer draws a **What's new** row where the record has notes or a `notesRefusal`, and no row at all where it has neither.
6. **The sheet** holds the notes as they arrived (or the host's sentence, where it refused them), the image's own size in the app's bytes (*Size 1.5 MB*), the build date as `Built 3 Mar 2026` where the release named one, and the two sentences the Firmware row's captions used to carry: the published image is the ordinary, unsealed build, and a sealed charm refuses it in its own words; and the charm checks the image against the SHA-256 it was given before it writes the slot.

## Where it lives

| Path | What it is |
| --- | --- |
| `app/src/components/settings/charm.tsx` | The page's shell (gate, live queries, handlers) and the pure `CharmSections` it draws: Device, Bots, Waking, Wi-Fi, Tailnet, Forget; `FirmwareRow` |
| `app/src/components/charm-update.tsx` | The update screen: the offer and its gate, the steps, the failure card, the cable sheet, the log row, Done and its sync, the What's-new sheet |
| `app/src/lib/charm-update-walk.ts` | The walk that outlives the screen: `started`, `running`, `again`, the reset a fresh load takes |
| `app/src/lib/charm-words.ts` | Every sentence: `firmwareWords`, `firmwareOffers`, `chargeBlocks`, `CHARGE_FIRST`, `KEEP_CLOSE`, `FIRMWARE_LEAVE`, `firmwareDoneWords`, `FETCH_FALLBACK`, `CABLE_WORDS`, `REPO_ROW`, `NOTES_TITLE`, `builtWords`, `FIRMWARE_CAPTION`, `FIRMWARE_CHECKED` |
| `app/src/lib/hermes.ts` | `CharmFirmware`, the record the route answers |
| `app/src/lib/charm.ts` | The page's own reads beside `useCharmReport`: `CharmFirmwareFacts`, `useCharmFirmware` (the build and the download asked on one link as `charmFirmwareSnapshot`, one poll, the facts handed to the row) and `useReturnSync`. `charmFirmwareVersion` and `charmUpdateStatus` stay for every other caller; `readCharmBattery` already answered the battery ask and is untouched |
| `app/src/components/developer-only.tsx` | `useDeveloper`, the one read of Developer's switch (`undefined` while the settings are unread), and the `DeveloperOnly` gate the routes share with the update screen's log row |
| `app/src/lib/native.ts` | `openExternal`, the one way out to the repository |
| `plugin/firmware.py` | The annotations, `NOTES_CAP`, `describe` |
| `plugin/__init__.py` | The firmware route, which spreads `describe`'s record |
| `app/scripts/test-charm-update.tsx` | The screen: offer, gate, leaving, steps, failure, cable, log, Done, notes, both widths |
| `app/scripts/test-charm-settings.tsx` | The page: the order, the Firmware row, the return sync, both widths |
| `plugin/tests/test_firmware.py` | The annotations, the cap and its scoping, the optional date, the route |
| `docs/adr/0175-an-update-is-offered-before-it-runs.md` | The decision: why an offer rather than a walk on mount |
| `GLOSSARY.md` | **Update offer**, the state between published and sent |
| `AGENTS.md` | The Charm section: the page's order, the row, the update screen |

## Tests

Cheapest tier that fails for the reason the change can fail (ADR 0019), and the case names as the suites spell them.

**The page** (`app/scripts/test-charm-settings.tsx`):

- *"the sections run Device, Bots, Waking, Wi-Fi, Tailnet, Forget"* — six cards in that order, and the device's rows in their own order.
- *"the network section draws no Firmware group and neither caption"* — the row and both captions are gone from the network section, which keeps only its two links.
- *"the firmware row offers the published one when the charm is older"*, *"the firmware row says the charm is up to date when the versions match"*, *"a charm ahead of the package is said, and never offered a downgrade"*, *"a charm too old to say its version is not compared with the package"*, *"a host that can't answer says it couldn't check, in its own words"* — the versions line and the **Update** tag, one case each way.
- *"a download running is the row's own line, over the versions"* — the live download line, which is why the poll had to move with the row.
- *"the firmware's facts are asked once on one link, and a row handed them asks nothing"* — one ask carrying the build and the download, no separate version or download ask on mount, and a row handed the facts asking nothing.
- *"a busy page opens no screen from the firmware row"* — the row is disabled with the rest of the page.
- *"Sync your bots lands on /settings/charm?sync=1, syncs once, and leaves the URL without the parameter"* — the return sync, one call, the parameter cleared, and the rest of the address left as it arrived.
- *"the sync row's spinner stops for a reader who asked for less motion"* — the one mark that moves is drawn `motion-safe`, as every spinner in the app is.
- *"the sections draw at 390 and at 768, in light and in dark"* — structure at all four combinations.

**The screen** (`app/scripts/test-charm-update.tsx`):

- *"the screen opens on the offer, asks the battery as it draws, and sends nothing until Install"* — the two facts, the keep-close line at the screen's foot and not in the offer's group, the version on the door, zero image reads, zero mints, zero uploads before the tap, the offer's ask, and then the tap's own ask as the one send.
- *"the 20% gate shuts the published offer's doors, and only under 20% off the charger"* and *"the 20% gate shuts the file door the same way, and the file door offers no Install"* — 12% not charging shuts, 12% charging passes, −1 passes, a refused ask passes; both doors, and the line under the group.
- *"a charge that lands under 20% after the offer draws shuts the tap, and no walk begins"*, *"a file picked after the offer is held to the charge the tap reads"* and *"a failure's Try again is held by the charge the tap reads"* — the charge 80% as the offer draws and 12% at the tap: zero uploads, no walk begun, no step drawn, the door still on screen with the line.
- *"a charge that still passes the rule at the tap sends, on both doors"* — 12% charging, −1 and a refused ask each send on Install and on the picker, with no line drawn.
- *"a returning visit joins the running walk and draws no offer"* and *"stepping back mid-walk and returning joins the walk already running"* — no second offer, no second battery ask, no second send.
- *"the leaving line is drawn once the walk runs, and on neither the offer nor an end"* — the sentence, its one place, and its two absences.
- *"Done reads the build it came from and the one it runs"* — `Updated to 0.2.1 from 0.1.0.`, `Sync your bots` landing on `/settings/charm?sync=1`, and a re-flash saying one build.
- *"a re-flash of the published build ends Done, over the phone's link and the charm's own fetch"* — the same build on both published doors, landed and said as one build, never as the failure it is not.
- *"a walk that could not name its start still says the build changed"* — `Updated to 0.2.2.` with no `from`, and never the re-flash sentence.
- *"the transfer step is marked when it fails"* — one marked row, the step it stopped at, the restart not drawn — and *"a failure before a byte still draws and marks the step the walk was in"*, for a host that refuses the image itself.
- *"the file door left after a walk is held by the tap, and says what shuts it"* — the door the picker is left with after a failure, shut at the pick with the line saying what opens it.
- *"the cable sheet says what the cable path is, and opens the firmware repository"* — the three sentences, the row, and `openExternal` called with the repository's URL and nothing else.
- *"the log row is absent with Developer off and present with it"* — the row and its words, both ways.
- *"the sheet draws the notes, the size and the date, and no row without notes"* — the notes, *Size 1.5 MB*, the built line, the unsealed-build caveat, the sentence about the SHA-256 the charm checks, an undated release with no date line, a refused release with the host's sentence, and a release naming none with no row and no sheet.
- *"the offer and the walk's steps draw at 390 and at 768, in light and in dark"* — the offer's rows, the keep-close line at the foot, and the three steps, at all four combinations.
- *"a screen that opens with nothing published says so, and takes a file"* — the host's sentence and the picker as the way through, with nothing to retry.

**The words** (`app/scripts/test-charm-words.mjs`):

- *"the end reads the change it made, and a walk whose start went unread still made one"* — `Updated to 0.2.1 from 0.1.0.`, `Updated to 0.2.2.` and `The charm runs 0.2.1.`, one case each.
- *"the battery's age is said where the reading has one, and only then"* — the page's reading carries when the charm gave it, the offer's ask does not, and an unreadable charge is neither.

**The plugin** (`plugin/tests/test_firmware.py`):

- *"the notes and the build date ride the answer"*, *"the route carries the notes and the build date"* — the two new annotations, read and answered.
- *"notes at the cap are drawn and one character over is not"* and *"the cap counts what the release wrote whatever whitespace it ends in"* — 2,000 characters is drawable, 2,001 is not, and a 2,001st newline is over the cap rather than trimmed away.
- *"notes over the cap are refused in a sentence naming it and the record answers"* and *"a release over the notes cap answers the record rather than a refusal"* — `notesRefusal` names the cap and never the notes, and the version, size and SHA-256 still answer, at the reader and at the route.
- *"a missing build date leaves the key off"* and *"a date that isn't a date is left off rather than refused"* — the date is optional and never a fault.
- *"a release that names no notes is answered without them"* — no `notes`, no `notesRefusal`; the row is drawn from what the release says.

## The two limits this build cannot lift

- **The gate is read at the tap, and not during the walk.** A charm that falls below 20% after the send has begun is not stopped mid-transfer: nothing re-reads the charge between the tap's answer and the end, and the charm's own cancel is what ends a walk that must not go on.
- **Colour is judged in the screenshots, not in jsdom.** The component tests read structure — which rows, which words, which widths, which theme class — because a DOM lays nothing out and paints nothing. Contrast, the accent on the **Update** tag and both screens' look at 390 and 768 are the screenshots under `assets/screenshots/ui-charm-*`, taken from the two stories (`settings/charm-sections.stories.tsx`, `charm-update.stories.tsx`) at both widths in both themes, and a device's to judge; no case here can stand in for that.

## Risks

- **The download poll must stay with the row.** It is read in `CharmSettings` and handed down, so the row's position costs nothing; putting it back beside a section would have two polls asking the charm at once.
- **Until the other repository writes the notes annotation**, every published release takes the no-notes path, and only the plugin's tests prove the branch with notes in it. The offer's path is proven against a faked record, which is why the fixture spells the release's words rather than reading them off `charm-words`.

## Gates

From `app/`: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build-storybook`. From the repo root: `python3 -m unittest discover -s plugin/tests -t .`. The change is code, docs and the plugin, so every gate is read against it: the two component suites, the words suite, the plugin's tests and the storybook build all have to be green, and each behaviour above names the case that proves it.
