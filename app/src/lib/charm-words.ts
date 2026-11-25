/** What the charm's settings say about it — its words and the marks its links wear — kept apart so they are tested alone. */
import { BluetoothIcon, WifiIcon, WaypointsIcon, type LucideIcon } from "lucide-react"
import {
  CharmLinkState,
  CharmUpdateReason,
  CharmUpdateState,
  CharmWifiReason,
  type CharmNetworkReport,
  type CharmUpdateStatus,
  type CharmWifiRecord,
} from "./charm-protocol.ts"
import {
  CHARM_MAX_URL_BYTES,
  CharmCode,
  codeWords,
  type CharmBattery,
} from "./charm-protocol.ts"
import { compareVersions } from "./version-compare.ts"
import { formatBytes } from "./attachment-caps.ts"
export interface CharmSeen {
  name: string
  syncedAt?: number
}

export const CHARM = "Charm"

/** The row's line under the title: whether one is paired, and when it last took the bots. */
export function charmSubtitle(charm: CharmSeen | null, now = Date.now()) {
  if (!charm) return "Not paired"
  if (!charm.syncedAt) return `${charm.name} · Never synced`
  return `${charm.name} · Synced ${since(charm.syncedAt, now)}`
}

function since(at: number, now: number) {
  const minutes = Math.round((now - at) / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return new Date(at).toLocaleDateString()
}

/**
 * Under the pet mode switch. The row beneath names the pet, so this line says what the switch does
 * rather than repeating the name it sits above.
 */
export function petSubtitle(
  choice: { enabled: boolean; botId?: string } | undefined,
  petName?: string,
) {
  if (!choice?.enabled) return "Your bots only, as they are now"
  return petName ? "Lives on the charm" : "Choose the bot that lives there"
}

/**
 * The Network section's Wi-Fi line: what the charm says its link is doing, and — before it has
 * answered, or while it is out of reach — what this phone last told it.
 */
export function wifiWords(
  wifi: CharmNetworkReport["wifi"] | undefined,
  record?: CharmWifiRecord,
): string {
  if (!wifi) return recordWords(record)
  if (wifi.state === CharmLinkState.Off) return recordWords(record)
  if (wifi.state === CharmLinkState.Joining) return "Joining…"
  if (wifi.state === CharmLinkState.Online)
    return wifi.ssid ? `Connected to ${wifi.ssid}` : "Connected"
  return wifiReasonWords(wifi.reason)
}

/** Why the charm is not on Wi-Fi, in the words a failure means to a reader. */
export function wifiReasonWords(reason: number): string {
  switch (reason) {
    case CharmWifiReason.NoCredentials:
      return "No network saved"
    case CharmWifiReason.NotFound:
      return "Not in range"
    case CharmWifiReason.BadCredentials:
      return "Wrong passphrase"
    case CharmWifiReason.Unreachable:
      return "No address from the network"
    case CharmWifiReason.Lost:
      return "Dropped off the network"
    default:
      return "Couldn't join the network"
  }
}

/**
 * What the phone remembers of a network the charm took, when the charm itself has not answered. A
 * record is written only for a yes, so `saved` means kept; whether the secret can be read off the
 * chip is the code's business, and its words are the warning, not this line.
 */
function recordWords(record?: CharmWifiRecord) {
  if (!record) return "Not set"
  return record.saved ? `Saved ${record.ssid}` : `${record.ssid}, not saved`
}

/** The tailnet line: whether the charm is on it, and its own name for it. */
export function tailnetWords(
  tailnet: CharmNetworkReport["tailnet"] | undefined,
  saved?: boolean,
): string {
  if (tailnet?.state === CharmLinkState.Joining) return "Joining…"
  if (tailnet?.state === CharmLinkState.Online)
    return tailnet.ip ? `On your tailnet at ${tailnet.ip}` : "On your tailnet"
  if (tailnet?.state === CharmLinkState.Failed) return "Couldn't reach the tailnet"
  return saved ? "Key saved; not joined" : "Not set"
}

/**
 * One fact the page has read from the charm: an ask that is still out, an ask that finished without an
 * answer, and what an answer said. `last` is what an earlier read found — still true of the charm
 * while the phone cannot reach it, so a level or a link it named once is not lost the moment a later
 * ask goes unanswered: away is not amnesia.
 */
export type CharmRead<T> =
  { state: "reading" } | { state: "failed"; last?: T } | { state: "read"; value: T }

/** What a read holds: the answer, or the one an earlier read found before this one failed. */
export function readValue<T>(read: CharmRead<T>): T | undefined {
  if (read.state === "read") return read.value
  return read.state === "failed" ? read.last : undefined
}

/** A read that finished without an answer, keeping what an earlier one found. */
export function readFailed<T>(read: CharmRead<T>): CharmRead<T> {
  const last = readValue(read)
  return last === undefined ? { state: "failed" } : { state: "failed", last }
}

/**
 * The three links the band marks, in the order it marks them. The type, the words and the marks all
 * read off this one list, so a link cannot be added in one place and missed in another — and the rule
 * that lists the links that are down takes its order from here rather than writing it again.
 */
export const LINKS = ["bluetooth", "wifi", "tailnet"] as const

/** One of the links the band marks. */
export type CharmLink = (typeof LINKS)[number]

/**
 * What each mark says to a reader who cannot see it, kept here beside the charm's other words rather
 * than in the row: the names the marks carry are read by the same test as the rule that draws them.
 */
export const LINK_DOWN_WORDS: Record<CharmLink, string> = {
  bluetooth: "Bluetooth is down",
  wifi: "Wi-Fi is down",
  tailnet: "Tailnet is down",
}

/**
 * The mark each link wears: Lucide's own shapes, the ones the charm traces by hand. One mark per
 * link rather than one per state, so a section's header wears the same glyph as the status row's
 * mark for that link; only a link that is down is drawn at all, and its words say which.
 */
export const LINK_MARKS: Record<CharmLink, LucideIcon> = {
  bluetooth: BluetoothIcon,
  wifi: WifiIcon,
  tailnet: WaypointsIcon,
}

/**
 * Which links are down, from the page's own read of the charm and the last report it sent. The
 * Bluetooth mark is the phone's own ask not opening — the one fact here the phone learns by asking
 * rather than by being told; the other two are the charm's, and a link it named as anything but
 * connected is down, as the glass marks it. A fact nobody has read is in neither list: a mark drawn
 * from it would be a guess, and "not read yet" draws nothing on the glass too.
 */
export function linksDown(read: CharmRead<CharmNetworkReport>): CharmLink[] {
  const report = readValue(read)
  return LINKS.filter((link) => {
    // The phone's own ask not opening is the one link here it learns by asking.
    if (link === "bluetooth") return read.state === "failed"
    if (!report) return false
    return (link === "wifi" ? report.wifi : report.tailnet).state !== CharmLinkState.Online
  })
}

/** Where the charm's firmware download has got to, in one line. */
export function updateWords(update: CharmUpdateStatus | null | undefined): string {
  if (!update || update.state === CharmUpdateState.Idle) return "No update running"
  if (update.state === CharmUpdateState.Downloading) return `Downloading… ${update.percent}%`
  if (update.state === CharmUpdateState.Ready) return "Ready: the charm is restarting"
  return `Update failed: ${updateReasonWords(update.reason)}`
}

/**
 * What the charm's own version read has said. Its firmware may predate the ask — a board to flash by
 * cable once, never a failure — and a link that never opened is another fact again.
 */
export type CharmRunning =
  /** The ask is out; nothing has answered it yet. */
  | { state: "reading" }
  /** The link did not open: not the charm having nothing to say. */
  | { state: "unreachable" }
  /** Its firmware predates the version ask: the first update is by cable. */
  | { state: "too-old" }
  | { state: "says"; version: string }

/**
 * What the Firmware row has read: the build the charm runs and the one the package publishes.
 * `answered` says whether the host's read is over, so nothing published is a refusal to say rather
 * than a wait.
 */
export interface CharmFirmwareSeen {
  running: CharmRunning
  published?: string
  answered: boolean
}

/**
 * The row's line: both versions when they can be compared, otherwise the one fact worth saying.
 */
export function firmwareWords({ running, published, answered }: CharmFirmwareSeen): string {
  if (running.state === "unreachable")
    return published
      ? `${published} published · couldn't reach the charm`
      : "Couldn't reach the charm"
  if (running.state === "too-old")
    return "This charm can't say which version it runs — the first update is by cable"
  if (!answered)
    return running.state === "says" ? `Charm ${running.version}` : "Reading the versions…"
  if (!published)
    return running.state === "says"
      ? `Charm ${running.version} · couldn't check for a newer one`
      : "Couldn't check for a newer one"
  if (running.state === "reading") return `${published} published · the charm didn't say`
  const order = compareVersions(running.version, published)
  if (order === null) return `Charm ${running.version} · can't tell if ${published} is newer`
  if (order === 0) return `Charm ${running.version} · up to date`
  return order < 0
    ? `Charm ${running.version} · ${published} available`
    : `Charm ${running.version} · newer than ${published}`
}

/** Whether the row offers the published image: only ever a version ahead of the charm's own. */
export function firmwareOffers({ running, published, answered }: CharmFirmwareSeen): boolean {
  if (!answered || !published || running.state !== "says") return false
  return compareVersions(running.version, published) === -1
}

/** A file a reader picked that cannot fit a slot, refused here rather than a minute into a stream. */
export const FILE_TOO_BIG = "That file is larger than a slot, so the charm could not hold it."

/** The bytes the host served are not the ones the version it named describes. */
export const PUBLISHED_CHANGED =
  "The published image isn't the one the version names — it may have been replaced. Try again."

/**
 * Under the Firmware row, once: the image published there is the ordinary, unsealed build, so it is
 * safe over the air; a sealed charm is the one that refuses it, and the charm's own reason is what
 * the row draws when it does.
 */
export const FIRMWARE_CAPTION =
  "The published image is the everyday build, not a sealed one: it installs over the air on any charm whose flash isn't sealed. A sealed charm refuses it, and says so in its own words."

/** The row's word that an image went, while the charm is still coming back. */
export const FIRMWARE_SENT = "Sent. The charm is restarting on it."

/** The row's word when the charm never answered on the build it was sent. */
export const FIRMWARE_NOT_BACK = "The charm didn't come back on the new build."

/**
 * Under the walk's title while it runs. The send is driven by its own promise rather than by the
 * screen, so stepping back leaves the update going — and the Firmware row is where a reader who
 * left reads the rest of it. Said before the steps, while there is still time to use it.
 */
export const FIRMWARE_LEAVE =
  "You can leave this screen — the charm keeps going, and the Firmware row on the charm's page follows it."

/**
 * Under every failure the update screen draws, the sure path: a cable. The over-the-air hop is the
 * one this app made sound, but a charm that keeps cancelling — the builds already in the field,
 * whose refusals name no position — can always be flashed by cable, and a reader who has met the
 * same failure twice should not meet it a third time. The row opens the sheet whose sentences are
 * below, rather than printing one sentence that promises a way it never names.
 */
export const CABLE_TITLE = "Flash it by cable"

/**
 * The cable path, in three sentences a reader can act on: what the charm's own cancel means, what
 * the path needs of them, and where the flasher and its steps are. Each stands on its own — the
 * sheet's third sentence hands the reader to the repository row under it.
 */
export const CABLE_WORDS = [
  "When the charm cancels, it stopped the write itself: the new image never reached the slot, so the charm still runs the build it came on.",
  "This way needs neither Bluetooth nor this app — a cable and a computer are all it takes.",
  "The flasher, the port it listens on and the steps live in the charm firmware's repository, which the row below opens.",
]

/** The sheet's own row: the firmware's repository, opened outside the app. */
export const REPO_ROW = "Open the firmware repository"

/**
 * The firmware's repository root, not a path inside it: a path rots as the tree moves, and a
 * repository does not. Where the flasher, its port and its steps are is that repository's business.
 */
export const FIRMWARE_REPO = "https://github.com/thehaseebahmed/hermesgots-charm"

/** The line under the step the walk stopped at, so a reader sees which of the three failed. */
export const STEP_STOPPED = "The update stopped here."

/**
 * The failure card's way into the charm's log. The route behind it is drawn only while this
 * device's Developer switch is on, so the row is drawn on the same condition — a row without it
 * would bounce the reader straight back to the menu.
 */
export const CHARM_LOG = "Read the charm's log"

/** The Downloading step's line: the bytes that have landed, of the whole the length named. */
export function downloadWords(progress: { received: number; total: number }): string {
  if (progress.total <= 0) return formatBytes(progress.received)
  const percent = Math.round((progress.received / progress.total) * 100)
  return `${percent}% of ${formatBytes(progress.total)}`
}

/**
 * The update screen's end: the build the charm came back on, as its own answer read it — and, when
 * the walk started on another build, the one it came from. A re-flash of the build the charm
 * already runs names one build, since there is no change to read.
 */
export function firmwareDoneWords(was: string | null, version: string): string {
  return was !== null && was !== version
    ? `Updated to ${version} from ${was}.`
    : `The charm runs ${version}.`
}

/**
 * The Downloading step's line when the charm fetches the image itself: which door it walks, said
 * so the reader knows why this phone is only watching. https is the host's own address over the
 * charm's Wi-Fi; http is its tailnet address, called by the same name the voice rows call it.
 */
export function fetchWords(scheme: "http" | "https"): string {
  return scheme === "http"
    ? "The charm is fetching it itself over your tailnet"
    : "The charm is fetching it itself over Wi-Fi"
}

/**
 * The fetch walk's line for a charm that says it is downloading forever: the walk is bounded by the
 * fetch token's own short life, past which the door is shut whatever the charm says — a walk that
 * outlives its door is over, in the walk's own words.
 */
export const FIRMWARE_NOT_ENDED = "The charm didn't finish the fetch it started."

/**
 * The upload's line for a charm that never says it holds the whole image it was sent: the last
 * byte went out with no answer of its own, so the charm's own count is the only yes there is — and
 * a charm wedged but alive would otherwise be waited on without an end.
 */
export const FIRMWARE_NOT_HELD = "The charm didn't say it had the whole image."

/** The update screen's line when the host's read names no image to send. */
export const FIRMWARE_NOT_PUBLISHED =
  "This host isn't offering a firmware image. A file can still be sent."

/** Why a download failed, as the charm's code means it. */
export function updateReasonWords(reason: number): string {
  switch (reason) {
    case CharmUpdateReason.Offline:
      return "the charm isn't on Wi-Fi"
    case CharmUpdateReason.BadUrl:
      return "that address isn't https"
    case CharmUpdateReason.BadHash:
      return "the image didn't match its SHA-256"
    case CharmUpdateReason.TooBig:
      return "the image is too big"
    case CharmUpdateReason.WriteFailed:
      return "the charm couldn't write it"
    case CharmUpdateReason.Cancelled:
      return "it was cancelled"
    case CharmUpdateReason.WrongScheme:
      // The charm refuses an image built for the other kind of board, and one that states no kind
      // at all: the phone says which, because "the charm didn't say why" would read as a fault.
      return "that image was built for a different kind of charm"
    default:
      return "the charm didn't say why"
  }
}

/** Under the double-tap switch: what two taps do, and what is left when they do nothing. */
export function doubleTapSubtitle(on: boolean) {
  return on ? "Two taps on the glass wake it" : "Only the buttons wake it"
}

/** The quiet row's value, in the charm's own words: the window the reader chose. */
export const quietWords = (seconds: number) => `${seconds} seconds`

/** The title of the row a reader reads before they change it. */
export const QUIET_TITLE = "Stays lit for"

/**
 * The battery row: the level, the charger and how old the reading is. "Not read yet" is a reading
 * nobody has asked for; "Unknown" is a charm that could not read its own charge, which is not 0%.
 * A reading with no age — the update offer's own, asked as the screen opens — says the level and
 * the charger alone.
 */
export function batteryWords(battery: CharmBattery | undefined, now = Date.now()) {
  if (!battery) return "Not read yet"
  if (battery.percent < 0) return "Unknown"
  const charge = `${battery.percent}%${battery.charging ? " · Charging" : ""}`
  // The settings page's reading carries its age; the offer's ask answers the level alone.
  const seen = battery as { at?: number }
  return typeof seen.at === "number" ? `${charge} · ${since(seen.at, now)}` : charge
}

/**
 * The update offer's link line: whether the charm is on Wi-Fi, which is what decides whether it can
 * fetch the image itself. A link that is down is no dead end — the phone sends the bytes over its
 * own link — so the line says what to do instead of what failed.
 */
export function offerLinkWords(report: CharmNetworkReport | undefined): string {
  if (!report) return "Not read yet"
  if (report.wifi.state === CharmLinkState.Online) return "Wi-Fi up"
  if (report.wifi.state === CharmLinkState.Joining)
    return "Wi-Fi joining — keep the phone near the charm"
  return "Wi-Fi down — keep the phone near the charm"
}

/** The offer's instruction row: the link the image goes over works at a hand's length. */
export const KEEP_CLOSE = "Keep the phone near the charm"

/** Under the offer's doors while the gate is shut: the one thing to do before it opens. */
export const CHARGE_FIRST = "Charge the charm above 20% before updating."

/**
 * Whether the charm's charge keeps the offer's doors shut: below 20% and not charging, SwitchBot's
 * own rule. A percent of -1 is a charm that could not read its own charge, and a missing answer is
 * no fact at all, so neither ever blocks — an update is offered on what the charm said, never on
 * what it did not.
 */
export function chargeBlocks(battery: CharmBattery | undefined): boolean {
  if (!battery || battery.percent < 0) return false
  return battery.percent < 20 && !battery.charging
}

/**
 * Under the battery row's title. The level itself is the status row's line, so this row says what a
 * tap does, and a failure is the only thing it says over that.
 */
export const BATTERY_ASK = "Tap to ask the charm"

/**
 * A refusal in the row's own words. BadMessage on a settings or battery op is a charm that never
 * heard of it — its firmware is older than this app — and saying "the charm didn't understand the
 * sync" of a switch would send the reader looking at the wrong thing. `tail` is the row's own next
 * step once the firmware is updated, for the row that has one to add.
 */
export function refusalWords(code: number, tail = "") {
  if (code === CharmCode.BadMessage)
    return `This charm's firmware is older than the app — update it${tail}`
  return codeWords(code)
}

/**
 * Voice: the row a charm's own voice is set up from. Its words live here with every other sentence a
 * charm's settings read; `talk.ts` holds the rules that read an address and build the frame.
 */

/**
 * The switch beside Sync: what each of its positions needs of the reader's host and charm.
 */
export const VOICE_HTTPS =
  "Your charm calls your host at the address your phone uses, with the certificate checked against the charm's own roots. It needs the charm's clock, which the app sets whenever it reaches the charm."

export const VOICE_HTTP =
  "Your charm calls your host on your tailnet in plain http. It needs your host to know its tailnet address, and the charm to be on the tailnet."

/** The row under the switch: the charm's own answer about what it holds, never this phone's guess. */
export const VOICE_HELD_TITLE = "Your charm holds"
export const VOICE_HELD_PURPOSE = "What the charm says it was handed"
export const VOICE_HELD_NONE = "Nothing yet — the next sync hands it over"
export const VOICE_HELD_UNKNOWN = "This charm's firmware can't say"
export const VOICE_HELD_ASKING = "Asking…"

/**
 * Under the row: a charm keeps the token in its flash, and a flash that isn't sealed gives it away to
 * anyone holding the charm. The token's own caveat, said once for the row rather than as a second
 * sentence of code 11's — that one is the charm's, and names no token.
 */
export const VOICE_KEPT =
  "A charm whose flash isn't sealed lets anyone holding it read the token off the chip."

/** Nothing was typed: the charm would have nowhere to send a turn. */
export const TALK_NEEDS_ADDRESS = "Your charm needs the address it can reach."

/** The firmware's own bound on the address it keeps, built from the constant the frame enforces. */
export const TALK_TOO_LONG = `That address is longer than the charm holds (${CHARM_MAX_URL_BYTES} bytes at most).`

export const TALK_SENT = "Sent to your charm."

export const VOICE_NO_TAILNET =
  "Your bots synced. This host didn't say its tailnet address, so voice stayed as it was — use https, or let your host join a tailnet."

/** The Voice row's own end to a refusal: the firmware first, then the sync that offers it again. */
export const VOICE_TAIL = ", then sync again"

/**
 * The doors a press's microphone can refuse at, as the firmware's own `talk::MicExit` numbers them:
 * the band says "No mic" for all of them, which is one word where there are ten, and the Debug Charm
 * page is where the number becomes a sentence. Kept in step with `docs/PROTOCOL.md`'s table.
 */
const MIC_EXIT_WORDS: Record<number, string> = {
  1: "The last turn was busy",
  2: "No island in PSRAM",
  3: "No codec memory",
  4: "No encoder",
  5: "No decoder",
  6: "No capture buffer",
  7: "No queue",
  8: "No playback buffer",
  9: "The microphone refused",
  10: "No capture task",
}

/** The door a press's microphone refused at, in the reader's words. */
export function micExitWords(exit: number) {
  return MIC_EXIT_WORDS[exit] ?? "A door this app does not know"
}
