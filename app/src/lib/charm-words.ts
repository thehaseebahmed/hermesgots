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

/** Where the charm's firmware download has got to, in one line. */
export function updateWords(update: CharmUpdateStatus | null | undefined): string {
  if (!update || update.state === CharmUpdateState.Idle) return "No update running"
  if (update.state === CharmUpdateState.Downloading) return `Downloading… ${update.percent}%`
  if (update.state === CharmUpdateState.Ready) return "Ready: the charm is restarting"
  return `Update failed: ${updateReasonWords(update.reason)}`
}

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
