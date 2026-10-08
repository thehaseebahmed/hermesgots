import { useEffect, useState } from "react"
import { liveQuery } from "dexie"
import { useLiveQuery } from "dexie-react-hooks"

import {
  db,
  getSettings,
  listEnabledProfiles,
  listProfiles,
  saveSettings,
  type Settings,
} from "@/lib/db"
import { registerPush, unregisterPush } from "@/lib/hermes"
import { connectionKey, reconnectLive } from "@/lib/live"
import { isNative } from "@/lib/native"

/**
 * Web Push, so a session that needs the user reaches an installed PWA while it's closed. The
 * plugin sends it (see `plugin/push.py`); this device gives each bot its browser subscription and a
 * VAPID key made for it. One browser subscription is tied to one key, so the key is the device's,
 * not the bot's. The app is never needed to send: what the plugin pushes says only that a session
 * waits, and the service worker (`public/push-sw.js`) shows it.
 */

export type PushPermission = NotificationPermission | "unsupported"

/** The Android app's WebView has no Push API; it will get Firebase messaging instead. */
export function pushSupported() {
  return (
    !isNative &&
    typeof Notification !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window
  )
}

function toBase64Url(bytes: ArrayBuffer | Uint8Array) {
  const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}

function fromBase64Url(text: string) {
  const padded = text
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(text.length / 4) * 4, "=")
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0))
}

async function newIdentity(): Promise<NonNullable<Settings["push"]>> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
  ])
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey)
  return {
    device: crypto.randomUUID(),
    vapidKey: jwk.d!,
    vapidPublic: toBase64Url(await crypto.subtle.exportKey("raw", pair.publicKey)),
    on: false,
  }
}

function sameKey(buffer: ArrayBuffer | null | undefined, key: string) {
  return Boolean(buffer) && toBase64Url(buffer!) === key
}

/** A subscription made with this device's key, replacing one made with another. */
async function subscription(identity: NonNullable<Settings["push"]>, create: boolean) {
  const registration = await navigator.serviceWorker.ready
  const existing = await registration.pushManager.getSubscription()
  if (existing && sameKey(existing.options.applicationServerKey, identity.vapidPublic)) {
    return existing
  }
  if (!create) return null
  await existing?.unsubscribe()
  return registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: fromBase64Url(identity.vapidPublic) as BufferSource,
  })
}

/** Which bot has been given which subscription, so a sync only posts what's new. */
const given = new Set<string>()
/** Bots turned off that were told to forget the subscription. */
const dropped = new Set<string>()

/** Gives every bot this device's subscription. Quiet when push is off or a bot has no plugin. */
export async function syncPush() {
  if (!pushSupported() || Notification.permission !== "granted") return
  const identity = (await getSettings()).push
  if (!identity?.on) return
  let sub: PushSubscription | null
  try {
    // Chrome re-subscribes without a gesture; where it can't, the toggle shows off until tapped.
    sub = await subscription(identity, true)
  } catch {
    return
  }
  const json = sub?.toJSON()
  if (!json?.endpoint) return
  const subject = location.origin.startsWith("https:") ? location.origin : "https://memento.invalid"
  for (const bot of await listProfiles()) {
    if (!bot.apiKey || !bot.baseUrl.trim()) continue
    const id = `${connectionKey(bot)}\n${json.endpoint}`
    if (bot.disabled) {
      // A bot turned off stops asking for this device's attention too.
      if (!dropped.has(id)) {
        dropped.add(id)
        await unregisterPush(bot, json.endpoint).catch(() => undefined)
      }
      given.delete(id)
      continue
    }
    if (given.has(id)) continue
    dropped.delete(id)
    try {
      await registerPush(bot, {
        device: identity.device,
        subscription: json,
        vapid_key: identity.vapidKey,
        subject,
      })
      given.add(id)
    } catch {
      // No plugin, or the server is away: asked again on the next change.
    }
  }
}

/** Asks for permission and subscribes. Call it from a click: iOS refuses to ask otherwise. */
export async function enablePush(): Promise<PushPermission> {
  if (!pushSupported()) return "unsupported"
  const permission = await Notification.requestPermission()
  if (permission !== "granted") return permission
  const settings = await getSettings()
  const identity = { ...(settings.push ?? (await newIdentity())), on: true }
  await subscription(identity, true)
  await saveSettings({ push: identity })
  await syncPush()
  // The plugin skips a device that has the app open, which it learns from the stream.
  reconnectLive()
  return permission
}

export async function disablePush() {
  const settings = await getSettings()
  if (!settings.push) return
  await saveSettings({ push: { ...settings.push, on: false } })
  try {
    const sub = await subscription(settings.push, false)
    if (sub) {
      await Promise.all(
        (await listEnabledProfiles()).map((bot) =>
          unregisterPush(bot, sub.endpoint).catch(() => undefined),
        ),
      )
      await sub.unsubscribe()
    }
  } catch {
    // The browser had already dropped it.
  }
  given.clear()
}

/** The toggle's state: whether push is available, allowed by the browser and turned on here. */
export function usePush() {
  const settings = useLiveQuery(async () => (await getSettings()).push, [])
  const [permission, setPermission] = useState<PushPermission>(() =>
    pushSupported() ? Notification.permission : "unsupported",
  )
  useEffect(() => {
    if (!pushSupported()) return
    const refresh = () => setPermission(Notification.permission)
    window.addEventListener("focus", refresh)
    return () => window.removeEventListener("focus", refresh)
  }, [])
  return { permission, on: Boolean(settings?.on) && permission === "granted" }
}

/** Keeps new bots and a restarted app in step with the subscription. */
export function startPush() {
  if (!pushSupported()) return
  let timer: number | undefined
  const soon = () => {
    window.clearTimeout(timer)
    timer = window.setTimeout(() => void syncPush(), 1000)
  }
  liveQuery(() => db.profiles.toArray()).subscribe(soon)
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") soon()
  })
}
