/**
 * The Gots Charm on this phone: which one is paired, whether one of its bots lives there as a pet,
 * and a sync of every bot to it over BLE (Android app only). The charm holds names and pictures,
 * never a key or a host address, so nothing here sends either.
 */
import { BleClient, type BleDevice } from "@capacitor-community/bluetooth-le"
import { useSyncExternalStore } from "react"

import { BOT_MOODS, DEFAULT_MOOD, botImage, type BotMood } from "@/components/bots"
import { findBot } from "@/components/bot"
import { labelOf } from "@/lib/bot-name"
import type { Profile } from "@/lib/db"
import { isNative } from "@/lib/platform"

import {
  CHARM_CONTROL,
  CHARM_DATA,
  CHARM_SERVICE,
  CHARM_STATUS,
  parseStatus,
  rgb565,
  type CharmBot,
  type CharmPetChoice,
  type CharmPose,
  type CharmStatus,
} from "./charm-protocol.ts"
import {
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
}

const KEY = "gots.charm"

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
  return next
}

export function forgetCharm() {
  write(null)
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
        id: profile.id,
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
  options: SyncOptions = {},
): Promise<SyncProgress> {
  const charm = paired
  if (!charm) throw new Error("No charm paired")
  await ready()
  const link = await openTransport(charm.deviceId)
  try {
    const result = await syncCharm(link, bots, onProgress, options)
    if (paired?.deviceId === charm.deviceId)
      write({ ...paired, syncedAt: Date.now(), syncedBots: result.total })
    return result
  } finally {
    await link.close()
  }
}
