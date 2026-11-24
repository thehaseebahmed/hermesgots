/**
 * The Gots Charm on this phone: which one is paired, whether one of its bots lives there as a pet,
 * a sync of every bot to it over BLE, and the network it joins, its tailnet key and its firmware
 * (Android app only). The charm holds names and pictures; a passphrase, a key and an image address
 * pass through this phone on their way to it and are never kept here.
 */
import { BleClient, type BleDevice } from "@capacitor-community/bluetooth-le"
import { Capacitor, registerPlugin } from "@capacitor/core"
import { useCallback, useEffect, useState, useSyncExternalStore } from "react"

import { BOT_MOODS, DEFAULT_MOOD, botImage, type BotMood } from "@/components/bots"
import { findBot } from "@/components/bot"
import { labelOf } from "@/lib/bot-name"
import { hasServer, serverConfig } from "@/lib/connection"
import type { Profile } from "@/lib/db"
import type { PluginServer } from "@/lib/features"
import { getCharmFirmware, type CharmFirmware, type HermesConfig } from "@/lib/hermes"
import type { HostRoute } from "@/lib/host-record"
import { isNative } from "@/lib/platform"
import { quietly } from "@/lib/report"
import { registryId } from "@/lib/registry"

import { charmBotId, charmButtons } from "./charm-alert.ts"
import {
  type CharmRefusal,
  type FirmwareProgress,
  uploadFirmware,
  type UploadOptions,
} from "./charm-firmware.ts"
import { oneAtATime } from "./charm-queue.ts"
import { readFailed, refusalWords, type CharmRead } from "./charm-words.ts"
import {
  CHARM_CONTROL,
  CHARM_DATA,
  CHARM_SERVICE,
  CHARM_STATUS,
  CharmCode,
  batteryMessage,
  busyFill,
  charmKept,
  diagnoseMessage,
  firmwareMessage,
  forgetMessage,
  hexBytes,
  logMessage,
  logTailMessage,
  networkMessage,
  parseBattery,
  parseDiagnose,
  parseFirmware,
  parseLogPage,
  parseNetworkReport,
  parseStatus,
  parseTalkState,
  parseUpdateStatus,
  rgb565,
  tailnetMessage,
  talkStateMessage,
  updateMessage,
  updateStatusMessage,
  wifiMessage,
  wifiRecord,
  type CharmAlertAction,
  type CharmBattery,
  type CharmDiagnose,
  type CharmLogRow,
  type CharmBatterySeen,
  type CharmBot,
  type CharmNetworkReport,
  type CharmPetChoice,
  type CharmPose,
  type CharmStatus,
  type CharmUpdateStatus,
  type CharmWifiRecord,
} from "./charm-protocol.ts"
import { type CharmWake, wakeMessage } from "./charm-protocol.ts"
import {
  CharmRefused,
  sendClock,
  syncCharm,
  type CharmTransport,
  type SyncProgress,
  type SyncOptions,
} from "./charm-sync.ts"

export interface PairedCharm {
  deviceId: string
  name: string
  /** When the last sync finished, and how many bots it left on the charm. */
  syncedAt?: number
  syncedBots?: number
  /** Pet mode: which bot lives on the charm, and whether it does at all. Off until set. */
  pet?: CharmPetChoice
  /**
   * The Wi-Fi it was told to join: the name, and whether the charm keeps it. The passphrase is never
   * part of it — the charm holds it from the write on, and only the charm can read it back.
   */
  wifi?: CharmWifiRecord
  /** Whether the charm has a tailnet key. The key itself is the charm's, and is never kept here. */
  tailnet?: boolean
  /**
   * The address the charm was handed last, or `true` for a record written before this phone kept the
   * address: the hand-over happened, the address it wrote is unknown. The token is never here — only
   * the address, so a sync knows whether the charm already holds one and nothing is minted twice.
   */
  talk?: boolean | string
  /**
   * The bot the token now on the charm was minted for. A token is one bot's (`talk_tokens.mint`), so a
   * phone that switches bot owes the charm a new one even though the address is unchanged.
   */
  talkBot?: string
  /**
   * Which scheme the charm's turns are handed over with: https over the charm's own Wi-Fi, where a
   * certificate is checked against the firmware's roots, or plain http over the tailnet. Absent is
   * https — the route that needs no tailnet and no typed address.
   */
  voice?: CharmScheme
  /** The glass's own settings, as the reader last chose them here. */
  wake?: CharmWake
  /**
   * The last battery reading the charm gave, and when it gave it: a percentage with no age would be
   * read as the charge right now, and a read taken a day ago is not that.
   */
  battery?: CharmBatterySeen
}

const KEY = "gots.charm"

/** The native sender's registration name, as `MainActivity` registers it. */
const CHARM_PLUGIN = "Charm"

/**
 * The moments a charm draws, as `docs/PROTOCOL.md` names them and the plugin reads them: only the
 * ones that need an action from the reader. A finished run asks for nothing, so it draws no alert.
 */
export type CharmReason = "question" | "approval"

/** The two schemes a charm's turn can be handed over with: TLS over its own Wi-Fi, or the tailnet. */
export type CharmScheme = "http" | "https"

interface CharmBridge {
  save(options: { deviceId: string }): Promise<void>
  forget(): Promise<void>
  alert(options: {
    botId: string
    reason: CharmReason
    subject: string
    /** The words the notice carries: the same title and body the tray entry shows. */
    title: string
    body: string
    /** The buttons the notice draws, at most two: the same labels and ids the tray's own press has. */
    actions: CharmAlertAction[]
  }): Promise<void>
  clear(options: { subject: string }): Promise<void>
}

const Charm = registerPlugin<CharmBridge>(CHARM_PLUGIN)

/** Only the Android app carries the plugin: a browser has no radio and no sender behind it. */
const charmBridge = () => isNative() && Capacitor.isPluginAvailable(CHARM_PLUGIN)

/** The charm draws its picture in a box half the 466 px screen wide. */
export const CHARM_PICTURE_PX = 233
const JPEG_QUALITY = 0.85
const ACCENT = "#7b7d7b"
const ANSWER_MS = 10_000

let paired: PairedCharm | null = read()
const listeners = new Set<() => void>()

function read(): PairedCharm | null {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "null") as PairedCharm | null
    return value && typeof value.deviceId === "string" ? value : null
  } catch {
    return null
  }
}

function write(next: PairedCharm | null) {
  paired = next
  if (next) localStorage.setItem(KEY, JSON.stringify(next))
  else localStorage.removeItem(KEY)
  for (const listener of listeners) listener()
}

export function usePairedCharm(): PairedCharm | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => paired,
  )
}

/** The one ask this page makes about the charm's own links. */
export interface CharmReportApi {
  status(): Promise<CharmNetworkReport>
}

/** The radio the page reads the charm's links with, when nothing stands in for it. */
const REPORT_RADIO: CharmReportApi = { status: charmNetwork }

/**
 * The page's own read of the charm's links: one ask, drawn by the paired section's status row and by
 * the Network section's two lines, so the page cannot tell two stories about what the charm said.
 * `refresh` asks again — after a write, or after a sync — and a failed ask keeps what an earlier one
 * found, with its reason said in the console rather than everything reading as one silence. The radio
 * is the page's one constant, since the ask it opens with is keyed on it.
 */
export function useCharmReport(api: CharmReportApi = REPORT_RADIO) {
  const [read, setRead] = useState<CharmRead<CharmNetworkReport>>({ state: "reading" })
  const refresh = useCallback(
    () =>
      api.status().then(
        (value) => setRead({ state: "read", value }),
        (reason: unknown) => {
          quietly("reading the charm's links")(reason)
          setRead(readFailed)
        },
      ),
    [api],
  )
  // One ask when the section opens: what the phone learns by asking, it asks once.
  useEffect(() => void refresh(), [refresh])
  return { read, refresh }
}

/** Only the Android app has a radio to reach the charm with. */
export const charmAvailable = () => isNative()

let initialized = false
async function ready() {
  if (initialized) return
  // The charm is found by its service UUID; the scan is never used for location.
  await BleClient.initialize({ androidNeverForLocation: true })
  initialized = true
  if (!(await BleClient.isEnabled())) await BleClient.requestEnable()
}

/** Shows the system's device picker, filtered to charms, and keeps the one chosen. */
export async function pairCharm(): Promise<PairedCharm> {
  await ready()
  const device: BleDevice = await BleClient.requestDevice({
    services: [CHARM_SERVICE],
    optionalServices: [CHARM_SERVICE],
  })
  // Bonding asks for the passkey the charm shows; once bonded, later syncs need nothing.
  const link = await openTransport(device.deviceId)
  try {
    // A charm that has just been bonded is the one that has never held a clock, so it is told the
    // time before the reader goes looking for the Sync button.
    await sendClock(link).catch(() => {})
  } finally {
    await link.close()
  }
  const next = { deviceId: device.deviceId, name: device.name ?? "Gots Charm" }
  write(next)
  await keepCharm(next.deviceId)
  return next
}

/**
 * The phone is told which charm to write to, so a push can reach it with the app closed: the page's
 * own store is a WebView's, and nothing native reads it. Every failure is quiet — a charm that is
 * paired and won't be written to is still a charm the reader paired.
 */
async function keepCharm(deviceId: string) {
  if (!charmBridge()) return
  await Charm.save({ deviceId }).catch(quietly("saving the charm on the phone"))
}

export function forgetCharm() {
  write(null)
  if (charmBridge()) void Charm.forget().catch(quietly("forgetting the charm on the phone"))
}

/**
 * The bot settled: the alert keyed by this session goes, and the charm goes back to its carousel.
 *
 * Asked where the reader answers a prompt, because the account's own clear fan-out skips the device
 * that answered (`plugin/push.py`). A page with no session, a phone with no charm paired and an app
 * with no plugin behind it all ask nothing — the charm is already where this would leave it.
 */
export function clearCharm(session: string | null | undefined) {
  const subject = session?.trim()
  if (!subject || !charmBridge()) return
  void Charm.clear({ subject }).catch(quietly("clearing the charm's alert"))
}

/** Turns pet mode on or off, or changes the bot that is the pet. The next sync carries it over. */
export function setCharmPet(pet: CharmPetChoice) {
  if (paired) write({ ...paired, pet })
}

/** A bot's charm picture: one pose on black, as a square JPEG for the round screen. */
export async function charmPicture(
  botId: string,
  mood: BotMood = DEFAULT_MOOD,
  px = CHARM_PICTURE_PX,
): Promise<Uint8Array> {
  const image = new Image()
  image.src = botImage(findBot(botId), mood)
  await image.decode()
  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = px
  const context = canvas.getContext("2d")
  if (!context) throw new Error("Couldn't draw the bot's picture")
  context.fillStyle = "#000"
  context.fillRect(0, 0, px, px)
  // Leave a margin so the round screen never clips the character.
  const inset = Math.round(px * 0.06)
  context.drawImage(image, inset, inset, px - 2 * inset, px - 2 * inset)
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY),
  )
  if (!blob) throw new Error("Couldn't make the bot's picture")
  return new Uint8Array(await blob.arrayBuffer())
}

// The pictures are the character's, so they never go stale and one set serves every sync.
const poseSets = new Map<string, Promise<CharmPose[]>>()

/**
 * The pet's pictures: one for each mood the app draws. A mood with no art of its own is left to the
 * charm's fallbacks, which is why hungry, sad and the rest are not sent.
 */
export function charmPoses(botId: string): Promise<CharmPose[]> {
  const known = poseSets.get(botId)
  if (known) return known
  const set = Promise.all(
    BOT_MOODS.map(async ({ id }) => ({ mood: id, image: await charmPicture(botId, id) })),
  )
  poseSets.set(botId, set)
  return set
}

/**
 * The id a bot's charm entry carries. The registry's when it answers — that is the id a push names
 * and an alert is matched against — and the bot's own when it doesn't, because a charm sync must
 * not fail because the registry is away: the bots still sync, under the id they had before.
 */
async function charmIdFor(bot: Profile): Promise<string> {
  const held = await registryId(bot).catch(() => undefined)
  return charmBotId(bot.id, held)
}

/** What the charm gets for this phone's bots: a name and two pictures each, in the order shown. */
export async function charmBots(
  profiles: Profile[],
  labels: Parameters<typeof labelOf>[0],
): Promise<CharmBot[]> {
  // Pictures are the bot character's, so two bots on one character share one picture — and each bot
  // announces two: the face the carousel draws and the one an alert draws, which is `curious`.
  const pictures = new Map<string, Promise<Uint8Array>>()
  const picture = (botId: string, mood: BotMood) => {
    const key = `${botId}\n${mood}`
    if (!pictures.has(key)) pictures.set(key, charmPicture(botId, mood))
    return pictures.get(key)!
  }
  return Promise.all(
    profiles
      .filter((profile) => !profile.disabled)
      .map(async (profile) => ({
        // The id a push names, so an alert for this bot matches the entry the charm holds.
        id: await charmIdFor(profile),
        name: labelOf(labels, profile),
        accent: rgb565(ACCENT),
        image: await picture(profile.botId, DEFAULT_MOOD),
        // `curious` is "Waiting on you" in the app's moods, which is the face an alert draws.
        waiting: await picture(profile.botId, "curious"),
      })),
  )
}

/** The BLE side of a sync: control writes answered by status notifications, in order. */
interface CharmLink extends CharmTransport {
  /** Writes one control message and answers the notification with the bytes the charm sent. */
  ask(message: Uint8Array): Promise<DataView>
  /** The charm's refusal of a data write just made, latched from its Busy notice and read once. */
  refusal(): CharmRefusal | null
  close(): Promise<void>
}

async function openTransport(deviceId: string): Promise<CharmLink> {
  let pending: { resolve: (answer: DataView) => void; reject: (e: Error) => void } | null = null
  let dropped = false
  let latched: CharmRefusal | null = null
  await BleClient.connect(deviceId, () => {
    dropped = true
    pending?.reject(new Error("The charm went out of reach"))
    pending = null
  })
  const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  try {
    // Already bonded resolves at once; a charm that lost its bond asks for the passkey again.
    await BleClient.createBond(deviceId, { timeout: 60_000 })
    await BleClient.startNotifications(deviceId, CHARM_SERVICE, CHARM_STATUS, (answer) => {
      // A `Busy` for op 0 is the charm refusing the data write just made, whether or not an ask
      // is waiting. The notice's extra, when it carries one, is the fill's offset — where the
      // charm is waiting for the image to resume — and a charm from before the fix sends the
      // four bytes alone, which reads as a fill of null.
      if (
        answer.byteLength >= 3 &&
        answer.getUint8(1) === CharmCode.Busy &&
        answer.getUint8(2) === 0
      )
        latched = { fill: busyFill(answer) }
      const waiting = pending
      pending = null
      waiting?.resolve(answer)
    })
  } catch (error) {
    await BleClient.disconnect(deviceId).catch(() => {})
    throw error
  }
  const mtu = await BleClient.getMtu(deviceId).catch(() => 23)
  const ask = (message: Uint8Array) => {
    if (dropped) return Promise.reject(new Error("The charm went out of reach"))
    return new Promise<DataView>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending = null
        reject(new Error("The charm stopped answering"))
      }, ANSWER_MS)
      pending = {
        resolve: (answer) => (clearTimeout(timer), resolve(answer)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      }
      BleClient.write(deviceId, CHARM_SERVICE, CHARM_CONTROL, view(message)).catch((error) => {
        pending = null
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      })
    })
  }
  return {
    mtu,
    // A sync's answers are a status and nothing more; a network ask's answer carries its own extra.
    control: async (message) => parseStatus(await ask(message)),
    ask,
    refusal() {
      const was = latched
      latched = null
      return was
    },
    data(chunk) {
      return BleClient.writeWithoutResponse(deviceId, CHARM_SERVICE, CHARM_DATA, view(chunk))
    },
    async close() {
      await BleClient.stopNotifications(deviceId, CHARM_SERVICE, CHARM_STATUS).catch(() => {})
      await BleClient.disconnect(deviceId).catch(() => {})
    },
  }
}

/** Sends every bot on this phone to the paired charm; the charm keeps them with the phone away. */
export async function syncToCharm(
  bots: CharmBot[],
  onProgress?: (progress: SyncProgress) => void,
  options: SyncOptions = {},
): Promise<SyncProgress> {
  const charm = paired
  if (!charm) throw new Error("No charm paired")
  return withCharm(async (link) => {
    const result = await syncCharm(link, bots, onProgress, options)
    if (paired?.deviceId === charm.deviceId) {
      write({ ...paired, syncedAt: Date.now(), syncedBots: result.total })
      // Said again after every sync: the page's store and the phone's can part ways (an app's data
      // cleared, a charm forgotten in Android's Bluetooth settings) and the next push must still
      // find the charm this sync just reached.
      await keepCharm(charm.deviceId)
    }
    return result
  })
}

/**
 * One control ask on a link of its own: pair-connect, write the one op, read its answer, close. The
 * network ops are each a single write, so each gets its own link rather than holding one open the
 * way a sync does.
 */
async function askCharm(message: Uint8Array): Promise<{ status: CharmStatus; bytes: DataView }> {
  const bytes = await withCharm((link) => link.ask(message))
  return { status: parseStatus(bytes), bytes }
}

/**
 * Tells the charm which network to join, and keeps only the name and the charm's word about keeping
 * it. The passphrase is in the write and nowhere else: no store, no log, no record.
 */
export async function setCharmWifi(ssid: string, pass: string): Promise<number> {
  const { status } = await askCharm(wifiMessage(ssid, pass))
  if (paired && charmKept(status.code)) write({ ...paired, wifi: wifiRecord(ssid, status.code) })
  return status.code
}

/** Makes the charm forget its network. It drops off Wi-Fi, and the record forgets the name. */
export async function forgetCharmWifi(): Promise<number> {
  const { status } = await askCharm(forgetMessage())
  // The charm's own `Forget` sweeps the talk secret with the Wi-Fi keys and the tailnet's, so this
  // phone's record of the address goes with the network it was handed over on.
  if (paired && status.code === CharmCode.Ok) write({ ...paired, wifi: undefined, talk: undefined })
  return status.code
}

/** What the charm's Wi-Fi and its tunnel are doing right now. */
/** The last press's microphone exit, as the charm recorded it at the moment of the refusal. */
export async function charmDiagnose(): Promise<CharmDiagnose> {
  const { status, bytes } = await askCharm(diagnoseMessage())
  if (status.code !== CharmCode.Ok) throw new CharmRefused(status.code)
  const report = parseDiagnose(bytes)
  if (!report) throw new Error("The charm's microphone answer was too short")
  return report
}

/**
 * Arms or releases the charm's copy of its log, answering whether the charm is keeping one now. The
 * ask is the only thing that arms it: a window opens at this write and closes by itself a minute after
 * this phone leaves the link, so a page that closes does not have to be trusted to close it.
 */
export async function setCharmLog(on: boolean): Promise<boolean> {
  const { status, bytes } = await askCharm(logMessage(on))
  if (status.code !== CharmCode.Ok) throw new CharmRefused(status.code)
  return bytes.byteLength > 5 ? bytes.getUint8(5) === 1 : on
}

/**
 * The charm's log, oldest row first, as the ring wrapped it. A page carries six rows, so this asks
 * until the charm says the rows are exhausted — a log the charm is still writing runs to its size, not
 * to a page count.
 */
export async function charmLog(): Promise<CharmLogRow[]> {
  const rows: CharmLogRow[] = []
  let from = 0
  // A ring is two kilobytes of twenty-six-column rows: well under this bound, and a charm that keeps
  // answering past it is not a charm this page can show.
  for (let page = 0; page < 64; page++) {
    const { status, bytes } = await askCharm(logTailMessage(from))
    if (status.code !== CharmCode.Ok) throw new CharmRefused(status.code)
    const answered = parseLogPage(bytes)
    if (!answered) throw new Error("The charm's log answer was too short")
    rows.push(...answered.rows)
    from = answered.from + answered.rows.length
    if (answered.rows.length === 0 || from >= answered.total) break
  }
  return rows
}

export async function charmNetwork(): Promise<CharmNetworkReport> {
  const { status, bytes } = await askCharm(networkMessage())
  if (status.code !== CharmCode.Ok) throw new CharmRefused(status.code)
  const report = parseNetworkReport(bytes)
  if (!report) throw new Error("The charm's network answer was too short")
  return report
}

/**
 * Hands the charm a tailnet auth key, which it uses once to join the tailnet. The key is not kept:
 * only whether the charm said it had one.
 */
export async function setCharmTailnetKey(key: string): Promise<number> {
  const { status } = await askCharm(tailnetMessage(key))
  if (paired && charmKept(status.code)) write({ ...paired, tailnet: true })
  return status.code
}

/**
 * Keeps the address a sync's hand-over wrote, once the charm has answered that it kept it. The write
 * itself is the sync's own voice step; this is the phone's memory of it. The token is nowhere here —
 * it lives on the charm and nowhere else.
 *
 * The answer is handed in rather than assumed: a refusal is a sync that has to offer the address
 * again, so recording it there would leave a charm the record says is set up and the reader is told
 * the next sync will try again.
 */
export function recordCharmTalk(
  voice: "sent" | "refused" | undefined,
  address: string,
  bot: string,
): void {
  if (voice !== "sent" || !paired) return
  write({ ...paired, talk: address, talkBot: bot })
}

/** The scheme the next sync hands over: the reader's pick, https unless they moved it. */
export function charmVoice(record: PairedCharm | null | undefined): CharmScheme {
  return record?.voice === "http" ? "http" : "https"
}

/**
 * What the charm itself says it holds: the address it kept, or null for a charm holding none. The
 * record beside it is what this phone wrote; this is what landed, and a page that draws both cannot
 * lie about a hand-over that failed.
 */
export async function readCharmTalk(): Promise<string | null> {
  const { status, bytes } = await askCharm(talkStateMessage())
  if (status.code !== CharmCode.Ok) throw new CharmRefused(status.code)
  const state = parseTalkState(bytes)
  if (!state) throw new Error("The charm's voice answer was too short")
  return state.address
}

/**
 * The switch beside Sync. It is this phone's decision and nothing else: no radio is opened and the
 * charm is told nothing until a sync, which is what hands the address the scheme picks over.
 */
export function setCharmVoice(scheme: CharmScheme): void {
  if (paired) write({ ...paired, voice: scheme })
}

/** Where the charm's firmware download has got to. */
export async function charmUpdateStatus(): Promise<CharmUpdateStatus> {
  const { status, bytes } = await askCharm(updateStatusMessage())
  if (status.code !== CharmCode.Ok) throw new CharmRefused(status.code)
  const update = parseUpdateStatus(bytes)
  if (!update) throw new Error("The charm's update answer was too short")
  return update
}

/**
 * Hands the charm the image to fetch itself: the host's tokened route, and the SHA-256 the bytes it
 * fetches must hash to — the charm checks the hash before it writes the slot, so the hash is the
 * trust anchor and the token is only the door. The door has been picked before this is called
 * (`firmwareDoor`): the address is https over the charm's own Wi-Fi, or http while its tunnel is
 * up, which are the only two the charm takes.
 */
export async function startCharmFirmwareFetch(url: string, sha256Hex: string): Promise<void> {
  // The hash is read here, so one that is not a hash is refused before a connection is opened.
  const { status } = await askCharm(updateMessage(url, hexBytes(sha256Hex)))
  if (status.code !== CharmCode.Ok) throw new CharmRefused(status.code)
}

/**
 * Which firmware the charm runs, like `0.1.0`, or null for a charm whose own firmware predates the
 * ask. Null is a charm to offer its first update by cable, not a failure to draw.
 */
export async function charmFirmwareVersion(): Promise<string | null> {
  const { bytes } = await askCharm(firmwareMessage())
  return parseFirmware(bytes)
}

/**
 * Sends the charm a whole firmware image over one link — the begin, every byte, the end — and
 * answers where it got to. One link for the lot, as a sync holds one for its duration: a megabyte
 * is minutes, and every answer rides on the same notification queue.
 */
export async function uploadCharmFirmware(
  image: Uint8Array,
  sha256Hex: string,
  onProgress?: (progress: FirmwareProgress) => void,
  options: UploadOptions = {},
): Promise<FirmwareProgress> {
  // Read here, so a hash that is not one is refused before a connection is opened.
  const sha256 = hexBytes(sha256Hex)
  return withCharm((link) => uploadFirmware(link, image, sha256, onProgress, options))
}

/**
 * What the host says about the firmware GitHub Packages publishes as `latest`: the package's own
 * answer, or the sentence it refused with. The charm cannot reach a registry that asks for a token,
 * so which image exists is a thing the phone asks the server it already talks to; a refusal — no
 * package yet, a token without `read:packages` — is that host's answer too, in its own words.
 */
export type PublishedFirmware =
  { state: "published"; firmware: CharmFirmware } | { state: "refused"; said: string }

/**
 * The published firmware as one of the host's own records: read when the row opens, kept for its
 * next open, and read again when a merge may have moved the tag. The plugin advertises the route as
 * `charm_firmware`, so a host older than it offers no published version at all.
 */
export const PUBLISHED_FIRMWARE: HostRoute<PublishedFirmware | undefined> = {
  feature: "charm_firmware",
  label: "the published charm firmware",
  read: async (server, signal) => {
    try {
      return { state: "published", firmware: await getCharmFirmware(server, signal) }
    } catch (error) {
      // A read that ran out of time never reached an answer: the record's own failed state says
      // that, rather than the row drawing a timeout as the host's refusal.
      if (error instanceof DOMException) throw error
      return { state: "refused", said: said(error) }
    }
  },
}

/** A host's sentence about a read it refused, or the one line that stands in for a bare throw. */
const said = (error: unknown) =>
  error instanceof Error && error.message ? error.message : "The host couldn't be read."

/**
 * The host a charm's firmware is read from: the row's own bot, since a charm's firmware is one
 * host's answer — the one that holds the registry token.
 */
export function hostForActiveBot(profile: PluginServer): HermesConfig {
  if (!hasServer(profile))
    throw new Error("Add a bot first: the charm's firmware is published on its host.")
  return serverConfig(profile)
}

/** What a test alert is keyed by: no session's, so it clears only when the reader dismisses it. */
export const TEST_ALERT_SUBJECT = "test-alert"

/** The two moments a charm can be made to draw, as its card's own words. */
export type TestAlertReason = "approval" | "question"

/**
 * Settings → Charm's test row, and Developer's Charm tests: one of the two moments, for the first
 * bot the charm holds, written the way a push writes it.
 *
 * The words are the ones a real notice carries — an approval's title, body and its pair of buttons
 * (`LABELS` in `plugin/answers.py`), and a question's, which carries none — so what the charm draws
 * for a test is what it draws for a push.
 */
export async function sendTestAlert(bot: Profile, reason: TestAlertReason = "approval") {
  if (!charmBridge()) throw new Error("A test alert needs the Android app")
  const approval = reason === "approval"
  await Charm.alert({
    botId: await charmIdFor(bot),
    reason,
    subject: `${TEST_ALERT_SUBJECT}-${reason}`,
    title: approval ? "Test alert" : "Nova has a question",
    body: approval
      ? "Waiting for your approval"
      : "Which region should the migration run in, eu-west or us-east?",
    // An approval's notice carries the pair the tray draws, so the charm draws and answers through
    // the buttons a real push draws; a question's carries none, so the card draws only the handoff.
    actions: approval
      ? charmButtons([{ label: "Allow once" }, { label: "Deny" }])
      : charmButtons([]),
  })
}

/**
 * The glass's own settings, sent at once in a connection of their own rather than saved up for a
 * sync — a switch that waited for the next sync would look broken until the reader synced. The
 * phone's copy is written first so the switch stays where the reader put it; the send's failure is
 * the row's to say, and a second tap on the switch tries again.
 */
export async function setCharmWake(wake: CharmWake): Promise<void> {
  if (paired) write({ ...paired, wake })
  const { status } = await askCharm(wakeMessage(wake)).catch(rethrowOlderFirmware)
  if (status.code !== CharmCode.Ok) throw new Error(refusalWords(status.code))
}

/** Asks the charm what its battery is, and keeps the answer with its age. */
export async function readCharmBattery(): Promise<CharmBattery | undefined> {
  const { status, bytes } = await askCharm(batteryMessage()).catch(rethrowOlderFirmware)
  if (status.code !== CharmCode.Ok) throw new Error(refusalWords(status.code))
  const reading = parseBattery(bytes)
  if (reading && paired) write({ ...paired, battery: { ...reading, at: Date.now() } })
  return reading ?? undefined
}

/** A charm that does not know the op is a charm whose firmware is older than this app. */
function rethrowOlderFirmware(error: unknown): never {
  if (error instanceof CharmRefused) throw new Error(refusalWords(error.code))
  throw error
}

/** One short connection: connect, one op, one answer, disconnect — one caller at a time. */
async function withCharm<T>(run: (link: CharmLink) => Promise<T>): Promise<T> {
  const charm = paired
  if (!charm) throw new Error("No charm paired")
  // A second caller waits for this link to close rather than connecting over it: the charm holds
  // one, and its `close()` disconnects the device whoever opened it.
  return oneAtATime(async () => {
    await ready()
    const link = await openTransport(charm.deviceId)
    try {
      // The clock first, whatever the charm answers: a charm that has lost its RTC's backup refuses
      // an https turn with "No clock" before the microphone opens, and this is the one moment the
      // phone is close enough to tell it the time. An extra a charm may not know — or a write that
      // fails — costs this link a round trip, not the op the reader opened it for.
      await sendClock(link).catch(() => {})
      return await run(link)
    } finally {
      await link.close()
    }
  })
}
