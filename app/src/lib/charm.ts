/**
 * The Gots Charm on this phone: which one is paired, whether one of its bots lives there as a pet,
 * a sync of every bot to it over BLE, and the network it joins, its tailnet key and its firmware
 * (Android app only). The charm holds names and pictures; a passphrase, a key and an image address
 * pass through this phone on their way to it and are never kept here.
 */
import { BleClient, type BleDevice } from "@capacitor-community/bluetooth-le"
import { Capacitor, registerPlugin } from "@capacitor/core"
import { useSyncExternalStore } from "react"

import { BOT_MOODS, DEFAULT_MOOD, botImage, type BotMood } from "@/components/bots"
import { findBot } from "@/components/bot"
import { labelOf } from "@/lib/bot-name"
import type { Profile } from "@/lib/db"
import { isNative } from "@/lib/platform"
import { quietly } from "@/lib/report"
import { registryId } from "@/lib/registry"

import { charmBotId, charmButtons } from "./charm-alert.ts"
import {
  CHARM_CONTROL,
  CHARM_DATA,
  CHARM_SERVICE,
  CHARM_STATUS,
  CharmCode,
  charmKept,
  forgetMessage,
  hexBytes,
  networkMessage,
  parseNetworkReport,
  parseStatus,
  parseUpdateStatus,
  rgb565,
  tailnetMessage,
  updateMessage,
  updateStatusMessage,
  wifiMessage,
  wifiRecord,
  type CharmAlertAction,
  type CharmBot,
  type CharmNetworkReport,
  type CharmPetChoice,
  type CharmPose,
  type CharmStatus,
  type CharmUpdateStatus,
  type CharmWifiRecord,
} from "./charm-protocol.ts"
import {
  CharmRefused,
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
}

const KEY = "gots.charm"

/** The native sender's registration name, as `MainActivity` registers it. */
const CHARM_PLUGIN = "Charm"

/**
 * The moments a charm draws, as `docs/PROTOCOL.md` names them and the plugin reads them: only the
 * ones that need an action from the reader. A finished run asks for nothing, so it draws no alert.
 */
export type CharmReason = "question" | "approval"

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
  await BleClient.connect(device.deviceId)
  try {
    await BleClient.createBond(device.deviceId, { timeout: 60_000 })
  } finally {
    await BleClient.disconnect(device.deviceId).catch(() => {})
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
  close(): Promise<void>
}

async function openTransport(deviceId: string): Promise<CharmLink> {
  let pending: { resolve: (answer: DataView) => void; reject: (e: Error) => void } | null = null
  let dropped = false
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
  await ready()
  const link = await openTransport(charm.deviceId)
  try {
    const result = await syncCharm(link, bots, onProgress, options)
    if (paired?.deviceId === charm.deviceId) {
      write({ ...paired, syncedAt: Date.now(), syncedBots: result.total })
      // Said again after every sync: the page's store and the phone's can part ways (an app's data
      // cleared, a charm forgotten in Android's Bluetooth settings) and the next push must still
      // find the charm this sync just reached.
      await keepCharm(charm.deviceId)
    }
    return result
  } finally {
    await link.close()
  }
}

/**
 * One control ask on a link of its own: pair-connect, write the one op, read its answer, close. The
 * network ops are each a single write, so each gets its own link rather than holding one open the
 * way a sync does.
 */
async function askCharm(message: Uint8Array): Promise<{ status: CharmStatus; bytes: DataView }> {
  const charm = paired
  if (!charm) throw new Error("No charm paired")
  await ready()
  const link = await openTransport(charm.deviceId)
  try {
    const bytes = await link.ask(message)
    return { status: parseStatus(bytes), bytes }
  } finally {
    await link.close()
  }
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
  if (paired && status.code === CharmCode.Ok) write({ ...paired, wifi: undefined })
  return status.code
}

/** What the charm's Wi-Fi and its tunnel are doing right now. */
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
 * Asks the charm to fetch a firmware image from an https address and check it against the SHA-256
 * pasted here. The charm downloads it itself; this phone only says what to fetch.
 */
export async function updateCharm(url: string, sha256Hex: string): Promise<number> {
  const { status } = await askCharm(updateMessage(url, hexBytes(sha256Hex)))
  return status.code
}

/** Where the charm's firmware download has got to. */
export async function charmUpdateStatus(): Promise<CharmUpdateStatus> {
  const { status, bytes } = await askCharm(updateStatusMessage())
  if (status.code !== CharmCode.Ok) throw new CharmRefused(status.code)
  const update = parseUpdateStatus(bytes)
  if (!update) throw new Error("The charm's update answer was too short")
  return update
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
