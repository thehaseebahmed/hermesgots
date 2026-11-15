import { useEffect, useState } from "react"
import { App } from "@capacitor/app"
import type { Importance } from "@capacitor/push-notifications"
import { liveQuery } from "dexie"
import { useLiveQuery } from "dexie-react-hooks"

import {
  chatIdForSession,
  db,
  getSettings,
  listEnabledProfiles,
  listProfiles,
  saveSettings,
  updateConversation,
  updateProfile,
  type Profile,
  type Settings,
} from "@/lib/db"
import {
  getNtfy,
  registerNtfy,
  registerPush,
  setPushMuted,
  unregisterNtfy,
  unregisterPush,
} from "@/lib/hermes"
import { hasServer } from "@/lib/connection"
import { connectionKey, reconnectLive } from "@/lib/live"
import { isNative } from "@/lib/platform"
import { quietly } from "@/lib/report"
import { callFunction, failure, functionUrl } from "@/lib/account"
import {
  PUSH_CATEGORIES,
  PUSH_FEATURES,
  aboutSubject,
  allowedCategoryIds,
  changedList,
  channelPlan,
  categoryOn,
  chatSubject,
  linkedPush,
  pushPath,
  pushSubject,
  pushTarget,
  pushedSession,
  reachableCategories,
  wantedCategories,
  type PhoneChannel,
  type PushCategory,
  type PushFeature,
} from "@/lib/push-kinds"
import {
  PUSH_TRANSPORTS,
  activeTransport,
  ntfyMissing,
  ntfyPriorities,
  ntfyServer,
  transportsFor,
  type NtfyState,
  type PushEnv,
  type PushTransportId,
} from "@/lib/push-transport"
import { AppWords } from "@/lib/refusal"
import { fromBase64Url, toBase64Url } from "./base64url.ts"

/**
 * Web Push, so a session that needs the user reaches an installed PWA while it's closed. The
 * plugin sends it (see `plugin/push.py`); this device gives each bot its browser subscription and a
 * VAPID key made for it. One browser subscription is tied to one key, so the key is the device's,
 * not the bot's. The app is never needed to send: what the plugin pushes says only that a session
 * waits, and the service worker (`public/push-sw.js`) shows it.
 */

export type PushPermission = NotificationPermission | "unsupported"

/** What this build is, as the transports are chosen from it (`push-transport.ts`). */
function pushEnv(): PushEnv {
  return { native: isNative(), firebase: nativeConfigured, web: webSupported() }
}

/**
 * Whether this device can get push at all: a browser with the Push API, or the Android app — which
 * always can, since ntfy needs nothing built into the APK.
 */
export function pushAvailable() {
  return transportsFor(pushEnv()).length > 0
}

/** The transport this device's notifications go by: its pick where the build offers it. */
async function currentTransport() {
  return activeTransport(pushEnv(), (await getSettings()).pushTransport)
}

/** The Android app's WebView has no Push API; it gets Firebase messaging (see below) instead. */
function webSupported() {
  return (
    !isNative() &&
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
  const subject = location.origin.startsWith("https:") ? location.origin : "https://gots.invalid"
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
 * A screen answers only its own pushes: one about a thread the user has not opened is still news
 * (ADR 0132). A push whose id no screen opens is answered by its tap alone.
 */
async function dismiss(subject: string) {
  if (!subject) return
  try {
    if (isNative()) {
      const { push } = await plugin()
      const { notifications } = await push.getDeliveredNotifications()
      const answered = notifications.filter((entry) => aboutSubject(entry, subject))
      if (answered.length) await push.removeDeliveredNotifications({ notifications: answered })
      return
    }
    const registration = await navigator.serviceWorker?.getRegistration()
    if (!registration) return
    for (const notification of await registration.getNotifications())
      if (aboutSubject(notification, subject)) notification.close()
  } catch {
    // An older APK's plugin without the read, or a browser without the Notifications API.
  }
}

/**
 * The screen on display answers the pushes about it, so they leave the tray — and nothing else does.
 * Answers again when the app comes back to the same screen, since a push may have arrived while it
 * was away. A screen in a tab nobody is looking at answers nothing.
 */
export function useDismissPushes(subject: string | undefined) {
  useEffect(() => {
    if (!subject) return
    const answer = () => {
      if (document.visibilityState === "visible") void dismiss(subject)
    }
    answer()
    document.addEventListener("visibilitychange", answer)
    return () => document.removeEventListener("visibilitychange", answer)
  }, [subject])
}

/**
 * The row is followed rather than read once, so a session written after the screen opened is
 * answered too.
 */
export function useDismissChatPushes(chatId: string | undefined) {
  const subject = useLiveQuery(async () => {
    const chat = chatId ? await db.conversations.get(chatId) : undefined
    return chat ? chatSubject(chat) : undefined
  }, [chatId])
  useDismissPushes(subject)
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

/** One pass's read of the phone: whether it lets this app notify, and the channels it lists. */
interface PhoneRead {
  allowed: boolean
  channels: PhoneChannel[]
}

/** The phone read once a pass, so a token's POST and a resume's list compare against one answer. */
async function readPhone(push: Push): Promise<PhoneRead> {
  const allowed = (await push.checkPermissions()).receive === "granted"
  if (!allowed) return { allowed, channels: [] }
  try {
    return { allowed, channels: (await push.listChannels()).channels }
  } catch {
    // A failed read is not an off switch: a channel the phone didn't mention counts as allowed.
    return { allowed, channels: [] }
  }
}

/** What the registry hears for this read: the phone's answer, held to what this device can reach. */
async function categoriesToRegister(read: PhoneRead) {
  const { meetings } = await getSettings()
  return allowedCategoryIds(read, meetings)
}

/** The categories the registry last heard for this device, so only a change is sent again. */
let sentCategories: string | undefined

/**
 * A call about this device's categories, remembering the list the registry now holds. What was sent
 * is kept only once the call answers, so one that failed is asked again on the next pass.
 */
async function tellRegistry(method: "POST" | "PATCH", device: string, body: unknown, wire: string) {
  const response = await callFunction(
    method,
    functionUrl("registry", { route: "devices", id: device }),
    body,
  )
  if (!response.ok) throw await failure(response)
  sentCategories = wire
}

/** Registers a token, with the categories the phone allows: the pass's read where there is one. */
async function sendToken(device: string, token: string, read?: PhoneRead) {
  const categories = await categoriesToRegister(read ?? (await readPhone((await plugin()).push)))
  await tellRegistry("POST", device, { token, categories }, categories.join())
  registeredToken = token
}

/** The PATCH under way, so a pass landing inside one waits rather than sending the same list twice. */
let patching: Promise<void> | undefined

/** The newest read that landed inside the PATCH under way: told once it settles, never dropped. */
let parked: PhoneRead | undefined

/**
 * Tells the registry which categories this phone still allows. A PATCH needs only the device id:
 * with the phone's notifications off no token arrives, and the empty list must still reach the
 * registry. Only a change is sent, so a device carrying an older list is told the live one exactly
 * once and then leaves it alone. A pass that lands inside a call is parked rather than dropped: when
 * the call settles its read is compared against what was sent, and one more PATCH follows if the
 * phone changed again meanwhile, so a list a later read has already left behind is never sent.
 */
function syncCategories(device: string, read?: PhoneRead): Promise<void> {
  parked = read ?? parked
  if (patching) return patching
  const call = (async () => {
    while (parked) {
      const next = parked
      parked = undefined
      const categories = await categoriesToRegister(next)
      const wire = changedList(sentCategories, categories)
      // A read that landed while this call was out is the next turn's: it is compared then.
      if (wire !== undefined) await tellRegistry("PATCH", device, { categories }, wire)
    }
  })().finally(() => {
    patching = undefined
    // A read that landed as the last call settled starts the drain it was waiting for.
    if (parked) void syncCategories(device).catch(() => {})
  })
  patching = call
  return call
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

/**
 * Opens a tapped notification. A session's chat is read from this device first, so a tap on one it
 * already holds lands on that chat at once; only a chat the device doesn't have falls through to the
 * session route, which is the one that syncs for it.
 */
async function openPush(path: string) {
  const session = pushedSession(path)
  const chat = session
    ? await chatIdForSession(session).catch(quietly("Reading a tapped session's chat"))
    : undefined
  const target = pushTarget(session, chat) ?? path
  if (openers.size) openers.forEach((open) => open(target))
  else pendingOpen = target
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
    // A tap answers its own push, even where the screen it opens answers nothing.
    const subject = pushSubject(notification)
    if (subject) void dismiss(subject)
    if (path) void openPush(path)
  })
}

/** The channels written this launch, and the Meetings flag they were written for. */
let provisioned: Promise<void> | undefined
let provisionedFor: boolean | undefined

/** The `sessions` channel an earlier build made for every device, deleted once a launch. */
let legacyDeleted = false

/**
 * Makes the channel of every category this phone can reach, once a launch and again when the
 * Meetings experiment flips: its two are reachable only while it is on, so turning it on mid-session
 * gives them the channels they never got. Android lets the user switch each one in its own settings.
 * A channel made again with its own id is renamed in place, at the importance the phone reported.
 */
function provisionChannels(push: Push, held: PhoneChannel[], meetings = false) {
  if (provisionedFor === meetings) return provisioned
  provisionedFor = meetings
  provisioned = Promise.all(
    channelPlan(reachableCategories(meetings), held).map((channel) =>
      push
        .createChannel({ ...channel, importance: channel.importance as Importance })
        .catch(() => {}),
    ),
  ).then(async () => {
    if (legacyDeleted) return
    legacyDeleted = true
    // The test notification's channel is made on the tap that sends one, so the one an earlier
    // build made for every device is deleted rather than left to sit in the phone's settings.
    await push.deleteChannel({ id: "sessions" }).catch(() => {})
  })
  return provisioned
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
    // The switch's own pass: the channels first, then the token, so a push never names a channel the
    // phone has not been given.
    const read = await readPhone(push)
    await provisionChannels(push, read.channels, settings.meetings)
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
      read,
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

/** The re-registration waiting on the pass, one per app: the newest pass's read replaces it. */
let categoriesTimer: number | undefined

/**
 * Registers the list once the registration event has had time to land: that event carries a fresh
 * token and posts the list itself, so this only covers the resume where the token didn't move. What
 * is handed over is the read, not its answer: the phone is read when the timer fires, so a channel
 * switched off in those three seconds travels with the list, and a list the event's own POST has
 * just sent is not overwritten with the one this pass began with.
 */
function soonCategories(device: string, read: () => Promise<PhoneRead>) {
  window.clearTimeout(categoriesTimer)
  categoriesTimer = window.setTimeout(() => {
    void read()
      .then((phone) => syncCategories(device, phone))
      .catch(() => {})
  }, 3000)
}

/** One pass: the phone is read once, its channels made for this launch's features, its list registered. */
async function syncNative() {
  const { fcm, meetings } = await getSettings()
  if (fcm?.trying) {
    // The last attempt to register ended the app; stay off until the user turns it on again.
    await saveSettings({ fcm: { device: fcm.device, on: false } })
    return
  }
  if (!fcm?.on || !nativeConfigured || (await currentTransport()) !== "firebase") return
  const { push } = await plugin()
  await listen(push)
  const read = await readPhone(push)
  // A phone that cannot notify has no channel to make and no token to collect; its empty list still
  // reaches the registry below. The channels come before the registration, so the token the event
  // brings is posted with a read that saw them.
  if (read.allowed) {
    await provisionChannels(push, read.channels, meetings)
    await guarded(fcm.device, () => push.register())
  }
  soonCategories(fcm.device, () => readPhone(push))
}

/** On launch and whenever the app returns, a rotated token or a new sign-in is told to the registry. */
function startNative() {
  const pass = () => {
    void syncNative().catch(() => {})
    void syncNtfy().catch(() => {})
  }
  pass()
  void App.addListener("resume", pass)
  // A bot linked or turned off after ntfy was switched on is handed the topic, or told to forget it.
  let timer: number | undefined
  liveQuery(() => db.profiles.toArray()).subscribe(() => {
    window.clearTimeout(timer)
    timer = window.setTimeout(() => void syncNtfy().catch(() => {}), 1000)
  })
  // An ntfy notification is the ntfy app's, so its tap arrives as a link rather than as an action.
  const linked = (url: string | undefined) => {
    const path = url ? linkedPush(url) : null
    if (path) void openPush(path)
  }
  void App.addListener("appUrlOpen", ({ url }) => linked(url))
  void App.getLaunchUrl()
    .then((launch) => linked(launch?.url))
    .catch(() => {})
}

/** Asks the registry to push to this phone now, with the app open or not. */
export async function sendTestPush() {
  const { fcm } = await getSettings()
  if (!isNative() || !fcm?.on || (await currentTransport()) !== "firebase")
    throw new Error("Notifications are off")
  // Its channel is made here, on the tap that sends one, so a device that never sends a test never
  // lists it. Before the POST: a push must never arrive ahead of the channel it names.
  const { push } = await plugin()
  await push
    .createChannel({ id: "test_notification", name: "Test notification", importance: 4 })
    .catch(() => {})
  const response = await callFunction(
    "POST",
    functionUrl("registry", { route: "push-test", id: fcm.device }),
  )
  if (!response.ok) throw await failure(response)
}

/**
 * Turns some categories of push on or off where the app's own list is the switch: Web Push and
 * ntfy, whose senders enforce it since neither has a channel per category.
 */
async function setCategories(ids: PushCategory[], on: boolean) {
  const transport = await currentTransport()
  // Firebase's switches are the phone's channels, which it reads back instead: a list stored for it
  // would have no reader (ADR 0050).
  if (!transport || PUSH_TRANSPORTS[transport].categories !== "app") return
  const { pushCategories } = await getSettings()
  await saveSettings({
    pushCategories: { ...pushCategories, ...Object.fromEntries(ids.map((id) => [id, on])) },
  })
  // Every bot's plugin keeps what this device asked for, with its subscription or its topic.
  if (transport === "ntfy") {
    const { taken, refused } = await syncNtfy()
    if (!taken && refused) throw refused
    return
  }
  given.clear()
  await syncPush()
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
  const settings = useLiveQuery(async () => {
    const { pushCategories, meetings } = await getSettings()
    return { pushCategories, meetings }
  }, [])
  const prefs = settings?.pushCategories
  return PUSH_FEATURES.filter((feature) => feature.id !== "meetings" || settings?.meetings).map(
    (feature) => {
      const categories = PUSH_CATEGORIES.filter((c) => c.feature === feature.id).map(
        (category) => ({
          ...category,
          checked: categoryOn(category, prefs),
        }),
      )
      return { ...feature, categories, on: categories.filter((c) => c.checked).length }
    },
  )
}

function useNativePermission(): PushPermission {
  const [permission, setPermission] = useState<PushPermission>("default")
  useEffect(() => {
    if (!isNative()) return
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

const ENABLE: Record<PushTransportId, () => Promise<PushPermission>> = {
  webpush: enableWeb,
  firebase: enableNative,
  ntfy: enableNtfy,
}

const DISABLE: Record<PushTransportId, () => Promise<void>> = {
  webpush: disableWeb,
  firebase: disableNative,
  ntfy: disableNtfy,
}

export async function enablePush(): Promise<PushPermission> {
  const transport = await currentTransport()
  return transport ? ENABLE[transport]() : "unsupported"
}

export async function disablePush() {
  const transport = await currentTransport()
  if (transport) await DISABLE[transport]()
}

/**
 * ntfy, for the Android app: each bot's own target — a server, a topic and an access token — held by
 * that bot's host, which publishes there itself (`plugin/ntfy.py`). The target follows the bot to
 * every phone, so this device keeps only whether it is one of the phones to publish to. The ntfy app
 * shows the notification, so there is no token of the phone's to collect and no permission of this
 * app's to ask for.
 */

/** This phone's id, the one its stream carries: Firebase's where it has one, else minted here. */
async function nativeDevice() {
  const { fcm } = await getSettings()
  if (fcm?.device) return fcm.device
  const device = crypto.randomUUID()
  await saveSettings({ fcm: { device, on: false } })
  return device
}

/** What each bot was last told about this phone, by its address and key, so a sync posts only a change. */
const toldNtfy = new Map<string, string>()

/** Screens showing a bot's target, told when a write or a switch has changed what hosts hold. */
const ntfyListeners = new Set<() => void>()
const ntfyChanged = () => ntfyListeners.forEach((listen) => listen())

/**
 * Joins this phone to every bot whose host holds a target, with the categories the app's own list has
 * on and each one's importance. Answers how many bots hold a target, how many took this phone and the
 * first refusal, so turning the switch on can say why nothing will arrive; a sync in passing ignores
 * all three.
 */
async function syncNtfy() {
  const { ntfyOn, pushCategories, meetings } = await getSettings()
  let taken = 0
  let configured = 0
  let refused: unknown
  if (!ntfyOn || (await currentTransport()) !== "ntfy") return { taken, configured, refused }
  const device = await nativeDevice()
  const categories = wantedCategories(pushCategories).filter((id) =>
    reachableCategories(meetings).some((category) => category.id === id),
  )
  const priorities = ntfyPriorities(PUSH_CATEGORIES)
  await Promise.all(
    (await listProfiles()).filter(hasServer).map(async (bot) => {
      const id = connectionKey(bot)
      try {
        if (bot.disabled) {
          // A bot turned off stops asking for this device's attention too.
          if (toldNtfy.delete(id)) await unregisterNtfy(bot, device)
          return
        }
        const held = await getNtfy(bot, device)
        if (!held.configured || !held.server || !held.topic) return
        configured++
        const wire = JSON.stringify([held.server, held.topic, categories])
        if (held.joined && toldNtfy.get(id) === wire) return void taken++
        // The host keeps the token: it is only ever sent where it was typed.
        await registerNtfy(bot, {
          server: held.server,
          topic: held.topic,
          device,
          categories,
          priorities,
        })
        toldNtfy.set(id, wire)
        taken++
      } catch (error) {
        // An older plugin, or a host that is away: asked again on a change.
        refused ??= error
      }
    }),
  )
  return { taken, configured, refused }
}

async function enableNtfy(): Promise<PushPermission> {
  const settings = await getSettings()
  // One device, one transport: a token Firebase still holds for this phone is taken back first.
  if (settings.fcm?.on) await disableNative()
  await saveSettings({ ntfyOn: true })
  toldNtfy.clear()
  const { taken, configured, refused } = await syncNtfy()
  if (!taken) {
    // Otherwise the switch would read on while no bot publishes to this phone.
    await saveSettings({ ntfyOn: false })
    if (refused) throw refused
    throw new AppWords(
      configured
        ? "No bot's host took this phone"
        : "Set up ntfy for a bot first: add its server, topic and token",
    )
  }
  ntfyChanged()
  // The plugin holds a publish back while the app is open, which it learns from the stream.
  reconnectLive()
  return "granted"
}

async function disableNtfy() {
  const { fcm } = await getSettings()
  await saveSettings({ ntfyOn: false })
  toldNtfy.clear()
  if (fcm?.device)
    await Promise.all(
      (await listEnabledProfiles())
        .filter(hasServer)
        .map((bot) => unregisterNtfy(bot, fcm.device).catch(() => undefined)),
    )
  ntfyChanged()
}

/**
 * Writes a bot's ntfy target to its host: the target is the bot's, so every phone reads it from
 * there. The token is required, but a host that already holds one for this server and topic keeps it,
 * so a form may leave it empty to change nothing. A phone that is on stays on the topic it is moved to.
 */
export async function saveNtfyTarget(
  bot: Profile,
  input: { server: string; topic: string; token: string },
) {
  const server = ntfyServer(input.server)
  if (!server) throw new AppWords("That isn't a web address")
  const topic = input.topic.trim()
  const held = await getNtfy(bot).catch(() => undefined)
  const same = Boolean(held?.configured && held.server === server && held.topic === topic)
  const missing = ntfyMissing({ server, topic, token: input.token }, same && held?.token_set)
  if (missing) throw new AppWords(missing)
  const { ntfyOn, pushCategories, meetings } = await getSettings()
  await registerNtfy(bot, {
    server,
    topic,
    token: input.token || undefined,
    ...(ntfyOn
      ? {
          device: await nativeDevice(),
          categories: wantedCategories(pushCategories).filter((id) =>
            reachableCategories(meetings).some((category) => category.id === id),
          ),
          priorities: ntfyPriorities(PUSH_CATEGORIES),
        }
      : {}),
  })
  toldNtfy.delete(connectionKey(bot))
  ntfyChanged()
}

/** Takes a bot's ntfy target off its host, which stops it publishing to every phone. */
export async function clearNtfyTarget(bot: Profile) {
  await unregisterNtfy(bot)
  toldNtfy.delete(connectionKey(bot))
  ntfyChanged()
}

/**
 * Picks how this phone is notified. The transport left behind is turned off first — its token or
 * its place on the topic taken back — so one event is never told twice; the one picked starts off,
 * since ntfy has a target to set up and Firebase a permission to ask for.
 */
export async function setPushTransport(id: PushTransportId) {
  const from = await currentTransport()
  if (from === id || !transportsFor(pushEnv()).includes(id)) return
  if (from) await DISABLE[from]()
  if (id === "webpush") return
  await saveSettings({ pushTransport: id })
}

/** The transports this build offers and the one in use. */
export function usePushTransport() {
  const settings = useLiveQuery(async () => (await getSettings()).pushTransport, [], null)
  const env = pushEnv()
  const id = activeTransport(env, settings ?? undefined)
  return {
    id,
    info: id ? PUSH_TRANSPORTS[id] : undefined,
    offered: transportsFor(env).map((offered) => PUSH_TRANSPORTS[offered]),
    /** False until this device's settings have been read: the screen draws nothing it would undo. */
    ready: settings !== null,
  }
}

/**
 * Each enabled bot with what its host says about its ntfy target: nothing yet while that read is
 * out, null where the host couldn't say (an older plugin, or away). Read again when a write here
 * changes it, and when the bots do.
 */
export function useNtfyTargets() {
  const bots = useLiveQuery(listEnabledProfiles, [])
  const [tick, setTick] = useState(0)
  const [states, setStates] = useState<Record<string, NtfyState | null>>({})
  useEffect(() => {
    const again = () => setTick((count) => count + 1)
    ntfyListeners.add(again)
    return () => void ntfyListeners.delete(again)
  }, [])
  const reachable = (bots ?? []).filter(hasServer)
  const key = reachable.map((bot) => `${bot.id}:${connectionKey(bot)}`).join()
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const device = (await getSettings()).fcm?.device
      for (const bot of reachable) {
        const settle = (state: NtfyState | null) =>
          !cancelled && setStates((held) => ({ ...held, [bot.id]: state }))
        getNtfy(bot, device).then(settle, () => settle(null))
      }
    })()
    return () => {
      cancelled = true
    }
    // The bots are read through their keys: a live query hands back new objects on every write.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick])
  return reachable.map((bot) => ({ bot, state: states[bot.id] }))
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
  if (isNative()) startNative()
  else startWeb()
}

/** The toggle's state: whether push is available, allowed by the OS or browser and turned on here. */
export function usePush() {
  const web = useWebPush()
  const nativePermission = useNativePermission()
  const held = useLiveQuery(async () => {
    const { fcm, ntfyOn, pushTransport } = await getSettings()
    return { fcm, ntfyOn, pushTransport }
  }, [])
  if (!isNative()) return web
  // ntfy's notification is the ntfy app's to show, so this app's own permission says nothing of it.
  if (activeTransport(pushEnv(), held?.pushTransport) === "ntfy")
    return { permission: "granted" as PushPermission, on: Boolean(held?.ntfyOn) }
  return {
    permission: nativePermission,
    on: Boolean(held?.fcm?.on) && nativePermission !== "denied",
  }
}
