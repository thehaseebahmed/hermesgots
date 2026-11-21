/** What the charm's settings say about it: plain words, kept apart so they are tested alone. */
import {
  CharmLinkState,
  CharmUpdateReason,
  CharmUpdateState,
  CharmWifiReason,
  type CharmNetworkReport,
  type CharmUpdateStatus,
  type CharmWifiRecord,
} from "./charm-protocol.ts"
import { CharmCode, codeWords, type CharmBatterySeen } from "./charm-protocol.ts"
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

/** Under the paired charm's own name: just when it last took the bots. */
export function charmSynced(charm: CharmSeen, now = Date.now()) {
  return charm.syncedAt ? `Synced ${since(charm.syncedAt, now)}` : "Never synced"
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

/** What the phone remembers of a network the charm took, when the charm itself has not answered. */
function recordWords(record?: CharmWifiRecord) {
  if (!record) return "Not set"
  return record.saved ? `Saved ${record.ssid}` : `${record.ssid}, kept for this boot only`
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

/** Where the charm's firmware download has got to, in one line. */
export function updateWords(update: CharmUpdateStatus | null | undefined): string {
  if (!update || update.state === CharmUpdateState.Idle) return "No update running"
  if (update.state === CharmUpdateState.Downloading) return `Downloading… ${update.percent}%`
  if (update.state === CharmUpdateState.Ready) return "Ready: the charm is restarting"
  return `Update failed: ${updateReasonWords(update.reason)}`
}

/**
 * What the Firmware row has read: the build the charm runs and the one the package publishes.
 * `running` is null for a charm whose own firmware has no version op — a board to flash by cable
 * once, never a failure — and undefined while it has not answered. `answered` says whether the
 * host's read is over, so nothing published is a refusal to say rather than a wait.
 */
export interface CharmFirmwareSeen {
  running?: string | null
  published?: string
  answered: boolean
}

/**
 * The Firmware row's line: both versions when they can be compared, and otherwise the one fact worth
 * saying. Three answers are not a comparison — a charm too old to say its version, a charm ahead of
 * the package (a build the reader flashed themself, which is not an update waiting to happen), and a
 * host that could not say what it publishes.
 */
export function firmwareWords({ running, published, answered }: CharmFirmwareSeen): string {
  if (running === null)
    return "This charm can't say which version it runs — the first update is by cable"
  if (!answered) return running ? `Charm ${running}` : "Reading the versions…"
  if (!published)
    return running
      ? `Charm ${running} · couldn't check for a newer one`
      : "Couldn't check for a newer one"
  if (running === undefined) return `${published} published · the charm didn't say`
  const order = versionOrder(running, published)
  if (order === null) return `Charm ${running} · can't tell if ${published} is newer`
  if (order === 0) return `Charm ${running} · up to date`
  return order < 0
    ? `Charm ${running} · ${published} available`
    : `Charm ${running} · newer than ${published}`
}

/** Whether the row offers the published image: only ever a version ahead of the charm's own. */
export function firmwareOffers({ running, published, answered }: CharmFirmwareSeen): boolean {
  if (!answered || !published || typeof running !== "string") return false
  return versionOrder(running, published) === -1
}

/**
 * Two versions as they are ordered, or null for words that aren't three numbers: a build the reader
 * hand-flashed is nobody's promise, so nothing is offered on a comparison that can't be made.
 */
function versionOrder(one: string, other: string): number | null {
  const parts = (version: string) => {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim())
    return match ? match.slice(1).map(Number) : null
  }
  const mine = parts(one)
  const theirs = parts(other)
  if (!mine || !theirs) return null
  for (let i = 0; i < 3; i += 1) if (mine[i] !== theirs[i]) return mine[i] < theirs[i] ? -1 : 1
  return 0
}

/** The update as it runs, from the phone's own count of the bytes it has written. */
export function updateProgressWords(progress: { sent: number; total: number }): string {
  const percent = progress.total > 0 ? Math.round((progress.sent / progress.total) * 100) : 0
  return `Updating… ${percent}%`
}

/** A file a reader picked that cannot fit a slot, refused here rather than a minute into a stream. */
export const FILE_TOO_BIG = "That file is larger than a slot, so the charm could not hold it."

/**
 * Under the Firmware row, once: the image the package publishes is the encrypted build, and a board's
 * first boot of one spends an eFuse on a key nobody can read back.
 */
export const FIRMWARE_CAPTION =
  "The published image is the encrypted build. The first one a board boots burns its flash-encryption key for good: that board runs an encrypted image from then on."

/** The row's word that an image went, while the charm is still coming back. */
export const FIRMWARE_SENT = "Sent. The charm is restarting on it."

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
 */
export function batteryWords(battery: CharmBatterySeen | undefined, now = Date.now()) {
  if (!battery) return "Not read yet"
  if (battery.percent < 0) return "Unknown"
  const charge = battery.charging ? " · Charging" : ""
  return `${battery.percent}%${charge} · ${since(battery.at, now)}`
}

/**
 * A refusal in the row's own words. BadMessage on a settings or battery op is a charm that never
 * heard of it — its firmware is older than this app — and saying "the charm didn't understand the
 * sync" of a switch would send the reader looking at the wrong thing.
 */
export function refusalWords(code: number) {
  if (code === CharmCode.BadMessage) return "This charm's firmware is older than the app — update it"
  return codeWords(code)
}
