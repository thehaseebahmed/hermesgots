import { useEffect, useState } from "react"
import { App } from "@capacitor/app"
import { liveQuery } from "dexie"
import { useLiveQuery } from "dexie-react-hooks"

import {
  db,
  getSettings,
  listEnabledProfiles,
  listProfiles,
  saveSettings,
  updateConversation,
  updateProfile,
  type Settings,
} from "@/lib/db"
import { registerPush, setPushMuted, unregisterPush } from "@/lib/hermes"
import { connectionKey, reconnectLive } from "@/lib/live"
import { isNative } from "@/lib/native"
import { callFunction, failure, functionUrl } from "@/lib/account"
import {
  PUSH_CATEGORIES,
  PUSH_FEATURES,
  categoryOn,
  channelName,
  pushPath,
  wantedCategories,
  type PushCategory,
  type PushFeature,
} from "@/lib/push-kinds"
import { fromBase64Url, toBase64Url } from "./base64url.ts"

/**
 * Web Push, so a session that needs the user reaches an installed PWA while it's closed. The
 * plugin sends it (see `plugin/push.py`); this device gives each bot its browser subscription and a
 * VAPID key made for it. One browser subscription is tied to one key, so the key is the device's,
 * not the bot's. The app is never needed to send: what the plugin pushes says only that a session
 * waits, and the service worker (`public/push-sw.js`) shows it.
 */

export type PushPermission = NotificationPermission | "unsupported"

/** Whether this device can get push: a browser with the Push API, or the Android app. */
export function pushAvailable() {
  return isNative ? nativeConfigured : webSupported()
}

/** The Android app's WebView has no Push API; it gets Firebase messaging (see below) instead. */
function webSupported() {
  return (
    !isNative &&
    typeof Notification !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window
  )
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
  if (!webSupported() || Notification.permission !== "granted") return
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
        categories: wantedCategories((await getSettings()).pushCategories),
      })
      given.add(id)
    } catch {
      // No plugin, or the server is away: asked again on the next change.
    }
  }
}

/** Asks for permission and subscribes. Call it from a click: iOS refuses to ask otherwise. */
async function enableWeb(): Promise<PushPermission> {
  if (!webSupported()) return "unsupported"
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

async function disableWeb() {
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
function useWebPush() {
  const settings = useLiveQuery(async () => (await getSettings()).push, [])
  const [permission, setPermission] = useState<PushPermission>(() =>
    webSupported() ? Notification.permission : "unsupported",
  )
  useEffect(() => {
    if (!webSupported()) return
    const refresh = () => setPermission(Notification.permission)
    window.addEventListener("focus", refresh)
    return () => window.removeEventListener("focus", refresh)
  }, [])
  return { permission, on: Boolean(settings?.on) && permission === "granted" }
}

/**
 * Clears what this app has shown in the device's notification tray: the Android app's, or the
 * service worker's on the web. Runs when the app comes to the front, so a push that arrived while
 * it was closed doesn't sit there after it's been opened. A session still waiting on the user stays
 * in Waiting for input. Nothing to clear (no registration, push never turned on) is a no-op.
 */
export async function clearNotifications() {
  try {
    if (isNative) {
      const { push } = await plugin()
      await push.removeAllDeliveredNotifications()
      return
    }
    const registration = await navigator.serviceWorker?.getRegistration()
    if (!registration) return
    for (const notification of await registration.getNotifications()) notification.close()
  } catch {
    // An older APK's plugin without the call, or a browser without the Notifications API.
  }
}

/** Keeps new bots and a restarted app in step with the subscription. */
function startWeb() {
  if (!webSupported()) return
  let timer: number | undefined
  const soon = () => {
    window.clearTimeout(timer)
    timer = window.setTimeout(() => void syncPush(), 1000)
  }
  liveQuery(() => db.profiles.toArray()).subscribe(soon)
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return
    soon()
    void clearNotifications()
  })
}

/**
 * The Android app: no Push API in its WebView, so Firebase. The OS keeps the token; this device
 * hands it to the registry (`push` in `netlify/lib/registry.ts`), and a plugin asks the registry to
 * send, because the service account key can't live on every Hermes host. Android shows the
 * notification itself while the app is closed.
 */

type Push = typeof import("@capacitor/push-notifications").PushNotifications

/**
 * Whether this APK was built with a google-services.json. Without one Firebase never starts, and
 * the plugin's `register()` throws on the native side, which ends the app.
 */
const nativeConfigured = import.meta.env.VITE_FIREBASE === "1"

/** `fcm.trying` is set across a native `register()`: if the app died in it, it is not tried again. */
async function guarded<T>(device: string, run: () => Promise<T>): Promise<T> {
  await saveSettings({ fcm: { device, on: false, trying: true } })
  try {
    return await run()
  } finally {
    // Only a native crash leaves the flag behind; an error in JS comes back here.
    await saveSettings({ fcm: { device, on: true } })
  }
}

let nativeListening = false
let registeredToken: string | undefined
let pendingToken: { resolve: (token: string) => void; reject: (error: Error) => void } | undefined

/**
 * Capacitor's plugin object answers every property with a method, `then` included, so returning
 * it (or resolving a promise with it) from an async function calls a native `then` that never
 * answers. It travels in a plain object instead.
 */
async function plugin(): Promise<{ push: Push }> {
  return { push: (await import("@capacitor/push-notifications")).PushNotifications }
}

/** A native call that never answers (or fails) becomes an error that names the step, for a toast. */
function step<T>(what: string, promise: Promise<T>, ms = 15_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} didn't answer`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        const reason = error instanceof Error ? error.message : String(error ?? "")
        reject(new Error(reason ? `${what}: ${reason}` : `${what} failed`))
      },
    )
  })
}

async function sendToken(device: string, token: string) {
  const categories = wantedCategories((await getSettings()).pushCategories)
  const response = await callFunction(
    "POST",
    functionUrl("registry", { route: "devices", id: device }),
    { token, categories },
  )
  if (!response.ok) throw await failure(response)
  registeredToken = token
  sentCategories = categories.join()
}

/** The categories the registry last heard for this device, so only a change is sent again. */
let sentCategories: string | undefined

/** Tells the registry which categories this phone wants. An older app's registration has none. */
async function syncCategories() {
  const { fcm, pushCategories } = await getSettings()
  if (!fcm?.on || !registeredToken) return
  const categories = wantedCategories(pushCategories)
  if (categories.join() === sentCategories) return
  const response = await callFunction(
    "PATCH",
    functionUrl("registry", { route: "devices", id: fcm.device }),
    { categories },
  )
  if (!response.ok) throw await failure(response)
  sentCategories = categories.join()
}

const openers = new Set<(path: string) => void>()
let pendingOpen: string | undefined

/** Calls back with where a tapped notification goes, now if one was tapped while the app was starting. */
export function onOpenPush(callback: (path: string) => void) {
  openers.add(callback)
  if (pendingOpen) {
    callback(pendingOpen)
    pendingOpen = undefined
  }
  return () => {
    openers.delete(callback)
  }
}

async function listen(push: Push) {
  if (nativeListening) return
  nativeListening = true
  await push.addListener("registration", ({ value }) => {
    // Turning the switch on waits for this and sends the token itself, so a failure reaches a toast.
    if (pendingToken) return pendingToken.resolve(value)
    void getSettings().then(({ fcm }) => {
      if (fcm?.on && value !== registeredToken) void sendToken(fcm.device, value).catch(() => {})
    })
  })
  await push.addListener("registrationError", ({ error }) => {
    pendingToken?.reject(new Error(`Firebase: ${error || "registration failed"}`))
  })
  await push.addListener("pushNotificationActionPerformed", ({ notification }) => {
    const path = pushPath(notification.data?.kind, notification.data?.session_id)
    if (!path) return
    if (openers.size) openers.forEach((open) => open(path))
    else pendingOpen = path
  })
  // One channel per category: Android lets the user turn each off in its own settings too. The
  // test notification has the one the app made before there were categories.
  await push
    .createChannel({ id: "sessions", name: "Test notification", importance: 4 })
    .catch(() => {})
  for (const category of PUSH_CATEGORIES) {
    await push
      .createChannel({
        id: category.id,
        name: channelName(category),
        importance: category.importance,
      })
      .catch(() => {})
  }
}

async function enableNative(): Promise<PushPermission> {
  const { push } = await step("Loading notifications", plugin())
  let status = await step("Checking the permission", push.checkPermissions())
  if (status.receive === "prompt" || status.receive === "prompt-with-rationale") {
    status = await step("The permission dialog", push.requestPermissions(), 60_000)
  }
  if (status.receive !== "granted") return "denied"
  const settings = await getSettings()
  const device = settings.fcm?.device ?? crypto.randomUUID()
  if (!nativeConfigured) throw new Error("This build has no Firebase configuration")
  try {
    await listen(push)
    const token = new Promise<string>((resolve, reject) => {
      pendingToken = { resolve, reject }
    })
    // Rejected later by a timeout or a failed register(), and read below only when it gets there.
    token.catch(() => {})
    await guarded(device, () => step("Registering with Firebase", push.register()))
    await saveSettings({ fcm: { device, on: true } })
    await sendToken(
      device,
      await step("Firebase's token", token).finally(() => {
        pendingToken = undefined
      }),
    )
  } catch (error) {
    pendingToken = undefined
    // Otherwise the switch would read on while nothing can arrive.
    await saveSettings({ fcm: { device, on: false } })
    throw error
  }
  // The plugin skips a device that has the app open, which it learns from the stream.
  reconnectLive()
  return "granted"
}

async function disableNative() {
  const { fcm } = await getSettings()
  if (!fcm) return
  await saveSettings({ fcm: { ...fcm, on: false } })
  registeredToken = undefined
  sentCategories = undefined
  try {
    await callFunction("DELETE", functionUrl("registry", { route: "devices", id: fcm.device }))
    await (await plugin()).push.unregister()
  } catch {
    // Offline: the token is dropped when Firebase reports it gone.
  }
}

/** On launch and whenever the app returns, a rotated token or a new sign-in is told to the registry. */
function startNative() {
  const sync = async () => {
    const { fcm } = await getSettings()
    if (fcm?.trying) {
      // The last attempt to register ended the app; stay off until the user turns it on again.
      await saveSettings({ fcm: { device: fcm.device, on: false } })
      return
    }
    if (!fcm?.on || !nativeConfigured) return
    const { push } = await plugin()
    if ((await push.checkPermissions()).receive !== "granted") return
    await listen(push)
    await guarded(fcm.device, () => push.register())
    // The registration event brings the token; an install from before categories says them now.
    setTimeout(() => void syncCategories().catch(() => {}), 3000)
  }
  void sync().catch(() => {})
  void App.addListener("resume", () => {
    void sync().catch(() => {})
    void clearNotifications()
  })
}

/** Asks the registry to push to this phone now, with the app open or not. */
export async function sendTestPush() {
  const { fcm } = await getSettings()
  if (!isNative || !fcm?.on) throw new Error("Notifications are off")
  const response = await callFunction(
    "POST",
    functionUrl("registry", { route: "push-test", id: fcm.device }),
  )
  if (!response.ok) throw await failure(response)
}

/** Turns some categories of push on or off on this device, and tells whoever sends them. */
async function setCategories(ids: PushCategory[], on: boolean) {
  const { pushCategories } = await getSettings()
  await saveSettings({
    pushCategories: { ...pushCategories, ...Object.fromEntries(ids.map((id) => [id, on])) },
  })
  if (isNative) await syncCategories()
  else {
    // Every bot's plugin keeps what this device asked for with its subscription.
    given.clear()
    await syncPush()
  }
}

export function setPushCategory(category: PushCategory, on: boolean) {
  return setCategories([category], on)
}

/** A whole feature at once: every category of Chats, of Code or of Routines. */
export function setPushFeature(feature: PushFeature, on: boolean) {
  return setCategories(
    PUSH_CATEGORIES.filter((category) => category.feature === feature).map((c) => c.id),
    on,
  )
}

/** Each feature's categories with their switch state on this device. */
export function usePushFeatures() {
  const prefs = useLiveQuery(async () => (await getSettings()).pushCategories, [])
  return PUSH_FEATURES.map((feature) => {
    const categories = PUSH_CATEGORIES.filter((c) => c.feature === feature.id).map((category) => ({
      ...category,
      checked: categoryOn(category, prefs),
    }))
    return { ...feature, categories, on: categories.filter((c) => c.checked).length }
  })
}

function useNativePermission(): PushPermission {
  const [permission, setPermission] = useState<PushPermission>("default")
  useEffect(() => {
    if (!isNative) return
    let cancelled = false
    const check = async () => {
      const { receive } = await (await plugin()).push.checkPermissions()
      if (!cancelled)
        setPermission(
          receive === "granted" ? "granted" : receive === "denied" ? "denied" : "default",
        )
    }
    void check().catch(() => {})
    const handle = App.addListener("resume", () => void check().catch(() => {}))
    return () => {
      cancelled = true
      void handle.then((h) => h.remove())
    }
  }, [])
  return permission
}

export function enablePush() {
  return isNative ? enableNative() : enableWeb()
}

export function disablePush() {
  return isNative ? disableNative() : disableWeb()
}

/**
 * Muting a bot or a chat is for every device, so the plugin that sends the pushes holds it: a chat's
 * `muted` travels with its chat list, a bot's is told to its plugin here, with the bot's character so
 * its pushes show its picture.
 */

/** What each server was last told, by its address and key. */
const toldMuted = new Map<string, string>()

async function syncMutes() {
  for (const bot of await listEnabledProfiles()) {
    if (!bot.apiKey || !bot.baseUrl.trim()) continue
    const id = connectionKey(bot)
    const muted = Boolean(bot.muted)
    const told = `${muted}:${bot.botId}`
    if (toldMuted.get(id) === told) continue
    try {
      await setPushMuted(bot, muted, bot.botId)
      toldMuted.set(id, told)
    } catch {
      // No plugin, or the server is away: asked again on the next change.
    }
  }
}

function startMutes() {
  let timer: number | undefined
  const soon = () => {
    window.clearTimeout(timer)
    timer = window.setTimeout(() => void syncMutes(), 1000)
  }
  liveQuery(async () =>
    (await listProfiles()).map((bot) => `${bot.id}:${bot.muted}:${bot.botId}`).join(),
  ).subscribe(soon)
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") soon()
  })
}

export function setBotMuted(profileId: string, muted: boolean) {
  return updateProfile(profileId, { muted: muted || undefined })
}

export function setThreadMuted(conversationId: string, muted: boolean) {
  return updateConversation(conversationId, { muted: muted || undefined })
}

export function startPush() {
  startMutes()
  if (isNative) startNative()
  else startWeb()
  // Launch: the app is already in front, so whatever is in the tray has been seen.
  void clearNotifications()
}

/** The toggle's state: whether push is available, allowed by the OS or browser and turned on here. */
export function usePush() {
  const web = useWebPush()
  const nativePermission = useNativePermission()
  const fcm = useLiveQuery(async () => (await getSettings()).fcm, [])
  if (!isNative) return web
  return { permission: nativePermission, on: Boolean(fcm?.on) && nativePermission !== "denied" }
}
