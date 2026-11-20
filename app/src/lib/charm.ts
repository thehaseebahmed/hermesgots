/**
 * The Gots Charm on this phone: which one is paired, and a sync of every bot to it over BLE
 * (Android app only). The charm holds names and pictures, never a key or a host address, so
 * nothing here sends either.
 */
import { BleClient, type BleDevice } from "@capacitor-community/bluetooth-le"
import { Capacitor, registerPlugin } from "@capacitor/core"
import { useSyncExternalStore } from "react"

import { botImage } from "@/components/bots"
import { findBot } from "@/components/bot"
import { labelOf } from "@/lib/bot-name"
import type { Profile } from "@/lib/db"
import { isNative } from "@/lib/platform"
import { quietly } from "@/lib/report"
import { registryId } from "@/lib/registry"

import { charmBotId } from "./charm-alert.ts"
import {
  CHARM_CONTROL,
  CHARM_DATA,
  CHARM_SERVICE,
  CHARM_STATUS,
  parseStatus,
  rgb565,
  type CharmBot,
  type CharmStatus,
} from "./charm-protocol.ts"
import { syncCharm, type CharmTransport, type SyncProgress } from "./charm-sync.ts"

export interface PairedCharm {
  deviceId: string
  name: string
  /** When the last sync finished, and how many bots it left on the charm. */
  syncedAt?: number
  syncedBots?: number
}

const KEY = "gots.charm"

/** The native sender's registration name, as `MainActivity` registers it. */
const CHARM_PLUGIN = "Charm"

/** The three moments a charm draws, as `docs/PROTOCOL.md` names them and the plugin reads them. */
export type CharmReason = "question" | "approval" | "finished"

interface CharmBridge {
  save(options: { deviceId: string }): Promise<void>
  forget(): Promise<void>
  alert(options: { botId: string; reason: CharmReason; subject: string }): Promise<void>
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

/** A bot's charm picture: its happy pose on black, as a square JPEG for the round screen. */
export async function charmPicture(botId: string, px = CHARM_PICTURE_PX): Promise<Uint8Array> {
  const image = new Image()
  image.src = botImage(findBot(botId))
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

/** What the charm gets for this phone's bots: a name and a picture each, in the order shown. */
export async function charmBots(
  profiles: Profile[],
  labels: Parameters<typeof labelOf>[0],
): Promise<CharmBot[]> {
  // Pictures are the bot character's, so two bots on one character share one picture.
  const pictures = new Map<string, Promise<Uint8Array>>()
  const picture = (botId: string) => {
    if (!pictures.has(botId)) pictures.set(botId, charmPicture(botId))
    return pictures.get(botId)!
  }
  return Promise.all(
    profiles
      .filter((profile) => !profile.disabled)
      .map(async (profile) => ({
        // The id a push names, so an alert for this bot matches the entry the charm holds.
        id: charmBotId(profile.id, await registryId(profile)),
        name: labelOf(labels, profile),
        accent: rgb565(ACCENT),
        image: await picture(profile.botId),
      })),
  )
}

/** The BLE side of a sync: control writes answered by status notifications, in order. */
async function openTransport(
  deviceId: string,
): Promise<CharmTransport & { close(): Promise<void> }> {
  let pending: { resolve: (s: CharmStatus) => void; reject: (e: Error) => void } | null = null
  let dropped = false
  await BleClient.connect(deviceId, () => {
    dropped = true
    pending?.reject(new Error("The charm went out of reach"))
    pending = null
  })
  try {
    // Already bonded resolves at once; a charm that lost its bond asks for the passkey again.
    await BleClient.createBond(deviceId, { timeout: 60_000 })
    await BleClient.startNotifications(deviceId, CHARM_SERVICE, CHARM_STATUS, (value) => {
      const waiting = pending
      pending = null
      waiting?.resolve(parseStatus(value))
    })
  } catch (error) {
    await BleClient.disconnect(deviceId).catch(() => {})
    throw error
  }
  const mtu = await BleClient.getMtu(deviceId).catch(() => 23)
  const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return {
    mtu,
    control(message) {
      if (dropped) return Promise.reject(new Error("The charm went out of reach"))
      return new Promise<CharmStatus>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending = null
          reject(new Error("The charm stopped answering"))
        }, ANSWER_MS)
        pending = {
          resolve: (s) => (clearTimeout(timer), resolve(s)),
          reject: (e) => (clearTimeout(timer), reject(e)),
        }
        BleClient.write(deviceId, CHARM_SERVICE, CHARM_CONTROL, view(message)).catch((error) => {
          pending = null
          clearTimeout(timer)
          reject(error instanceof Error ? error : new Error(String(error)))
        })
      })
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
): Promise<SyncProgress> {
  const charm = paired
  if (!charm) throw new Error("No charm paired")
  await ready()
  const link = await openTransport(charm.deviceId)
  try {
    const result = await syncCharm(link, bots, onProgress)
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

/** What a test alert is keyed by: no session's, so it clears only when the reader dismisses it. */
export const TEST_ALERT_SUBJECT = "test-alert"

/**
 * Settings → Charm's test row: an approval for the first bot the charm holds, through the same
 * plugin a push goes through. A phone with no charm, Bluetooth off or the grant gone writes nothing
 * and answers nothing — the row's own words are all it can promise.
 */
export async function sendTestAlert(bot: Profile) {
  if (!charmBridge()) throw new Error("A test alert needs the Android app")
  await Charm.alert({
    botId: charmBotId(bot.id, await registryId(bot)),
    reason: "approval",
    subject: TEST_ALERT_SUBJECT,
  })
}
