import { useSyncExternalStore } from "react"
import { liveQuery } from "dexie"

import { MISSING_ROUTE_MS } from "@/lib/freshness"
import { quietly } from "@/lib/report"
import { connectionKey } from "@/lib/connection"
import { cooldown } from "@/lib/cooldown"
import { db, getSettings, updateConversation, type Profile } from "@/lib/db"
import {
  followEvents,
  getPluginFeatures,
  getSessionTitle,
  HermesError,
  type HermesConfig,
} from "@/lib/hermes"
import { reconcileHistory } from "@/lib/history"
import { syncChatsOf, syncNow } from "@/lib/sync"

/**
 * Hears from each server's Memento plugin as things change, instead of asking every so often: one
 * stream per server while the app is on screen. Events only say what changed; the app then fetches
 * it the way it always has, so a missed event costs no more than the timer it replaces. Nothing
 * depends on this: a bot whose stream isn't open (an older plugin, a proxy that buffers it, a page
 * in the background) keeps the timers it always had, and a live one keeps them as a slow safety net.
 */

/** Backoff between reconnects. */
const RETRY_MS = [1000, 2000, 5000, 10_000, 30_000]
/** A `runs` event often comes with a status the server sets a moment later. */
const RUNS_SETTLE_MS = 300

export type Kind = "cron" | "runs" | "projects" | "research"
type Connection = Pick<HermesConfig, "baseUrl" | "apiKey">

export { connectionKey }

interface Stream {
  controller: AbortController
}

const streams = new Map<string, Stream>()
/** Where each stream got to, so a reconnect only hears what it missed. */
const cursors = new Map<string, number>()
/** Plugins without the stream. */
const unsupported = cooldown(MISSING_ROUTE_MS)
/** Connections whose stream is open. */
let live = new Set<string>()
/** Changes heard per connection and kind, for screens to refresh on. */
let ticks: Record<string, number> = {}
const listeners = new Set<() => void>()
const changeListeners = new Map<Kind, Set<(key: string) => void>>()
/** Chats on screen, which catch up as soon as their session moves. */
const openChats = new Set<string>()
let profiles: Profile[] = []

function notify() {
  listeners.forEach((listener) => listener())
}

function setLive(key: string, on: boolean) {
  if (live.has(key) === on) return
  live = new Set(live)
  if (on) live.add(key)
  else live.delete(key)
  notify()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const tickKey = (key: string, kind: Kind) => `${kind}\n${key}`

function bump(key: string, kind: Kind) {
  const id = tickKey(key, kind)
  ticks = { ...ticks, [id]: (ticks[id] ?? 0) + 1 }
  notify()
  changeListeners.get(kind)?.forEach((listener) => listener(key))
}

/** How a bot hears about changes: `push` is an open stream, `connecting` one not yet answering,
 * `unsupported` a plugin without it, `off` none wanted (hidden page, offline, disabled, no key). */
export type LiveStatus = "push" | "connecting" | "unsupported" | "off"

function statusOf(profile?: Connection | null): LiveStatus {
  if (!profile) return "off"
  const key = connectionKey(profile)
  if (live.has(key)) return "push"
  if (unsupported.cooling(key)) return "unsupported"
  return streams.has(key) ? "connecting" : "off"
}

export function useLiveStatus(profile?: Connection | null) {
  return useSyncExternalStore(subscribe, () => statusOf(profile))
}

/** Whether the bot's server is telling this device about changes right now. */
export function isLive(profile?: Connection | null) {
  return Boolean(profile && live.has(connectionKey(profile)))
}

export function useLive(profile?: Connection | null) {
  return useSyncExternalStore(subscribe, () => isLive(profile))
}

/** Whether every one of these bots' servers is telling this device about changes right now. */
export function useAllLive(profiles?: Connection[] | null) {
  return useSyncExternalStore(subscribe, () =>
    Boolean(profiles?.length && profiles.every((profile) => isLive(profile))),
  )
}

/** Counts the changes of a kind heard from any server. */
export function useAnyChange(kind: Kind) {
  return useSyncExternalStore(subscribe, () =>
    Object.entries(ticks).reduce(
      (sum, [id, count]) => (id.startsWith(`${kind}\n`) ? sum + count : sum),
      0,
    ),
  )
}

/** Counts the changes of a kind heard for the bot's server; a screen refreshes when it moves. */
export function useChanges(kind: Kind, profile?: Connection | null) {
  return useSyncExternalStore(subscribe, () =>
    profile ? (ticks[tickKey(connectionKey(profile), kind)] ?? 0) : 0,
  )
}

/** The same for code outside React; the listener gets the connection key that changed. */
export function onChanges(kind: Kind, listener: (key: string) => void) {
  const set = changeListeners.get(kind) ?? new Set()
  set.add(listener)
  changeListeners.set(kind, set)
  return () => {
    set.delete(listener)
  }
}

/** Marks a chat as on screen until the returned function is called. */
export function watchChat(conversationId: string) {
  openChats.add(conversationId)
  return () => {
    openChats.delete(conversationId)
  }
}

const catchingUp = new Set<string>()
const catchUpAgain = new Set<string>()

/** Catches a chat up, once more after the catch-up already running if it's asked again meanwhile. */
function catchUpChat(conversationId: string) {
  if (catchingUp.has(conversationId)) {
    catchUpAgain.add(conversationId)
    return
  }
  catchingUp.add(conversationId)
  // Called when the server says the session moved, which a mode or a plan does without a row.
  reconcileHistory(conversationId, { changed: true })
    .catch(quietly("Catching up a chat"))
    .finally(() => {
      catchingUp.delete(conversationId)
      if (catchUpAgain.delete(conversationId)) catchUpChat(conversationId)
    })
}

function botsOf(key: string) {
  return profiles.filter((profile) => connectionKey(profile) === key)
}

async function chatsFor(key: string, sessionId: unknown) {
  if (typeof sessionId !== "string" || !sessionId) return []
  const bots = new Set(botsOf(key).map((bot) => bot.id))
  return (await db.conversations.where("hermesSessionId").equals(sessionId).toArray()).filter((c) =>
    bots.has(c.profileId),
  )
}

/** After a gap in what this device heard: everything that may have changed meanwhile. */
function catchUpAll(key: string) {
  void syncNow()
  for (const id of openChats) {
    void db.conversations.get(id).then((chat) => {
      if (chat && botsOf(key).some((bot) => bot.id === chat.profileId)) catchUpChat(id)
    })
  }
  for (const kind of ["cron", "runs", "projects", "research"] as const) bump(key, kind)
}

async function applyTitle(key: string, sessionId: unknown) {
  for (const chat of await chatsFor(key, sessionId)) {
    if (chat.titleEdited) continue
    const bot = profiles.find((p) => p.id === chat.profileId)
    if (!bot) continue
    const title = await getSessionTitle(bot, chat.hermesSessionId)
    const current = await db.conversations.get(chat.id)
    if (title && current && !current.titleEdited && current.title !== title) {
      await updateConversation(chat.id, { title })
    }
  }
}

const settling = new Map<string, number>()

function bumpRunsSoon(key: string) {
  window.clearTimeout(settling.get(key))
  settling.set(
    key,
    window.setTimeout(() => {
      settling.delete(key)
      bump(key, "runs")
    }, RUNS_SETTLE_MS),
  )
}

function onEvent(key: string, event: string, data: Record<string, unknown>) {
  const cursor = typeof data.cursor === "number" ? data.cursor : undefined
  const resumed = cursors.has(key)
  if (cursor !== undefined) cursors.set(key, cursor)
  switch (event) {
    case "hello":
      setLive(key, true)
      // A first stream only starts listening now; whatever happened before was missed.
      if (!resumed) catchUpAll(key)
      break
    case "reset":
      catchUpAll(key)
      break
    case "session":
      void chatsFor(key, data.session_id).then((chats) =>
        chats.filter((c) => openChats.has(c.id)).forEach((c) => catchUpChat(c.id)),
      )
      break
    case "title":
      void applyTitle(key, data.session_id).catch(quietly("Reading a title"))
      break
    case "chats":
      void syncChatsOf(botsOf(key).map((bot) => bot.id))
      break
    case "runs":
      bumpRunsSoon(key)
      break
    case "cron":
    case "projects":
    case "research":
      bump(key, event)
      break
  }
}

function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = window.setTimeout(resolve, ms)
    signal.addEventListener("abort", () => {
      window.clearTimeout(timer)
      resolve()
    })
  })
}

/** Whether a failed stream means the plugin doesn't serve it (rather than the server being away). */
async function lacksStream(config: HermesConfig, error: unknown) {
  // Hermes's 404 for an unknown route skips its CORS middleware, so it can arrive with no status.
  if (!(error instanceof HermesError) || (error.status && error.status !== 404)) return false
  try {
    return !(await getPluginFeatures(config)).includes("events")
  } catch {
    // The plugin is mandatory, so this is the server being away, not a plugin without the stream.
    return false
  }
}

async function follow(config: HermesConfig, key: string, signal: AbortSignal) {
  let failures = 0
  while (!signal.aborted) {
    try {
      const settings = await getSettings()
      const device = (settings.push ?? settings.fcm)?.device
      await followEvents(config, { since: cursors.get(key), device, signal }, (event, data) => {
        failures = 0
        onEvent(key, event, data)
      })
    } catch (error) {
      if (!signal.aborted && (await lacksStream(config, error))) {
        unsupported.start(key)
        notify()
        window.setTimeout(reconcileStreams, MISSING_ROUTE_MS)
        break
      }
    }
    setLive(key, false)
    await wait(RETRY_MS[Math.min(failures++, RETRY_MS.length - 1)], signal)
  }
  setLive(key, false)
  if (streams.get(key)?.controller.signal === signal) streams.delete(key)
  notify()
}

/** Opens a stream for each server that should have one, and closes the rest. */
function reconcileStreams() {
  const active = document.visibilityState === "visible" && navigator.onLine
  const wanted = new Map<string, Profile>()
  if (active) {
    for (const profile of profiles) {
      if (profile.disabled || !profile.apiKey || !profile.baseUrl.trim()) continue
      const key = connectionKey(profile)
      if (unsupported.cooling(key)) continue
      if (!wanted.has(key)) wanted.set(key, profile)
    }
  }
  for (const [key, stream] of streams) {
    if (wanted.has(key)) continue
    stream.controller.abort()
    streams.delete(key)
    setLive(key, false)
    notify()
  }
  for (const [key, profile] of wanted) {
    if (streams.has(key)) continue
    const controller = new AbortController()
    streams.set(key, { controller })
    notify()
    void follow({ baseUrl: profile.baseUrl, apiKey: profile.apiKey }, key, controller.signal)
  }
}

/** Opens every stream again, say after this device starts to receive push, which the plugin skips
 * for a device whose stream says it's looking at the app. */
export function reconnectLive() {
  for (const [key, stream] of streams) {
    stream.controller.abort()
    streams.delete(key)
    setLive(key, false)
  }
  reconcileStreams()
}

let started = false

/** Keeps a stream open to each server while the app is on screen and online. */
export function startLive() {
  if (started) return
  started = true
  liveQuery(() => db.profiles.toArray()).subscribe((value) => {
    profiles = value
    reconcileStreams()
  })
  document.addEventListener("visibilitychange", reconcileStreams)
  window.addEventListener("online", reconcileStreams)
  window.addEventListener("offline", reconcileStreams)
}
