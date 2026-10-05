import { useSyncExternalStore } from "react"
import { liveQuery } from "dexie"

import { db, updateConversation, type Profile } from "@/lib/db"
import {
  checkHealth,
  followEvents,
  getPluginInfo,
  getSessionTitle,
  HermesError,
} from "@/lib/hermes"
import { reconcileHistory } from "@/lib/history"
import { syncNow } from "@/lib/sync"

/**
 * Hears from each bot's Memento plugin as things change on its server, instead of asking every so
 * often: one stream per bot while the app is on screen. Events only say what changed; the app then
 * fetches it the way it always has, so a missed event costs no more than the polling it replaces.
 * Bots without the plugin's stream (or without a key) aren't live, and screens keep polling them.
 */

/** Backoff between reconnects. */
const RETRY_MS = [1000, 2000, 5000, 10_000, 30_000]
/** The plugin pings every 20s; a stream quiet for longer has died without saying so. */
const SILENT_MS = 50_000
/** How long a plugin without the stream (an older one) is left alone before it's asked again. */
const UNSUPPORTED_MS = 5 * 60_000

const connectionKey = (profile: Profile) => `${profile.baseUrl.trim()}\n${profile.apiKey}`

const streams = new Map<string, { key: string; controller: AbortController }>()
/** By connection: where each stream got to, so a reconnect only hears what it missed. */
const cursors = new Map<string, number>()
const unsupported = new Map<string, number>()
/** Profile ids whose stream is open. */
let live = new Set<string>()
/** Changes to routines heard per profile, for screens to refresh on. */
let cronTicks: Record<string, number> = {}
const listeners = new Set<() => void>()
/** Chats on screen, which catch up as soon as their session moves. */
const openChats = new Set<string>()

function notify() {
  listeners.forEach((listener) => listener())
}

function setLive(profileId: string, on: boolean) {
  if (live.has(profileId) === on) return
  live = new Set(live)
  if (on) live.add(profileId)
  else live.delete(profileId)
  notify()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Whether the bot's server is telling this device about changes right now. */
export function isLive(profileId?: string) {
  return Boolean(profileId && live.has(profileId))
}

export function useLive(profileId?: string) {
  return useSyncExternalStore(subscribe, () => isLive(profileId))
}

/** Counts the routine changes heard for the bot; a screen refreshes when it moves. */
export function useCronTick(profileId: string) {
  return useSyncExternalStore(subscribe, () => cronTicks[profileId] ?? 0)
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
  reconcileHistory(conversationId)
    .catch(() => undefined)
    .finally(() => {
      catchingUp.delete(conversationId)
      if (catchUpAgain.delete(conversationId)) catchUpChat(conversationId)
    })
}

async function chatsFor(profile: Profile, sessionId: unknown) {
  if (typeof sessionId !== "string" || !sessionId) return []
  return db.conversations
    .where("[profileId+updatedAt]")
    .between([profile.id, -Infinity], [profile.id, Infinity])
    .filter((c) => c.hermesSessionId === sessionId)
    .toArray()
}

/** After a gap in what this device heard: everything that may have changed meanwhile. */
function catchUpAll(profile: Profile) {
  void syncNow()
  void db.conversations
    .where("[profileId+updatedAt]")
    .between([profile.id, -Infinity], [profile.id, Infinity])
    .primaryKeys()
    .then((ids) => ids.filter((id) => openChats.has(id)).forEach(catchUpChat))
  bumpCron(profile.id)
}

function bumpCron(profileId: string) {
  cronTicks = { ...cronTicks, [profileId]: (cronTicks[profileId] ?? 0) + 1 }
  notify()
}

async function applyTitle(profile: Profile, sessionId: unknown) {
  for (const chat of await chatsFor(profile, sessionId)) {
    if (chat.titleEdited) continue
    const title = await getSessionTitle(profile, chat.hermesSessionId)
    const current = await db.conversations.get(chat.id)
    if (title && current && !current.titleEdited && current.title !== title) {
      await updateConversation(chat.id, { title })
    }
  }
}

function onEvent(profile: Profile, key: string, event: string, data: Record<string, unknown>) {
  const cursor = typeof data.cursor === "number" ? data.cursor : undefined
  const resumed = cursors.has(key)
  if (cursor !== undefined) cursors.set(key, cursor)
  switch (event) {
    case "hello":
      setLive(profile.id, true)
      // A first stream only starts listening now; whatever happened before was missed.
      if (!resumed) catchUpAll(profile)
      break
    case "reset":
      catchUpAll(profile)
      break
    case "session":
      void chatsFor(profile, data.session_id).then((chats) =>
        chats.filter((c) => openChats.has(c.id)).forEach((c) => catchUpChat(c.id)),
      )
      break
    case "title":
      void applyTitle(profile, data.session_id).catch(() => undefined)
      break
    case "chats":
      void syncNow()
      break
    case "cron":
      bumpCron(profile.id)
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
async function lacksStream(profile: Profile, error: unknown) {
  // Hermes's 404 for an unknown route skips its CORS middleware, so it can arrive with no status.
  if (!(error instanceof HermesError) || (error.status && error.status !== 404)) return false
  try {
    return !(await getPluginInfo(profile)).features.includes("events")
  } catch {
    // No plugin at all, if the server itself answers.
    return checkHealth(profile).then(
      () => true,
      () => false,
    )
  }
}

async function follow(profile: Profile, key: string, signal: AbortSignal) {
  let failures = 0
  while (!signal.aborted) {
    const attempt = new AbortController()
    const stop = () => attempt.abort()
    signal.addEventListener("abort", stop)
    let watchdog = 0
    const heard = () => {
      failures = 0
      window.clearTimeout(watchdog)
      watchdog = window.setTimeout(stop, SILENT_MS)
    }
    try {
      await followEvents(
        profile,
        { since: cursors.get(key), signal: attempt.signal, onRead: heard },
        (event, data) => onEvent(profile, key, event, data),
      )
    } catch (error) {
      if (!signal.aborted && !attempt.signal.aborted && (await lacksStream(profile, error))) {
        unsupported.set(key, Date.now())
        window.setTimeout(reconcileStreams, UNSUPPORTED_MS)
        break
      }
    } finally {
      window.clearTimeout(watchdog)
      signal.removeEventListener("abort", stop)
    }
    setLive(profile.id, false)
    await wait(RETRY_MS[Math.min(failures++, RETRY_MS.length - 1)], signal)
  }
  setLive(profile.id, false)
  if (streams.get(profile.id)?.controller.signal === signal) streams.delete(profile.id)
}

let profiles: Profile[] = []

/** Opens a stream for each bot that should have one, and closes the rest. */
function reconcileStreams() {
  const active = document.visibilityState === "visible" && navigator.onLine
  const wanted = new Map<string, Profile>()
  if (active) {
    for (const profile of profiles) {
      const key = connectionKey(profile)
      if (!profile.pluginChats || !profile.apiKey || !profile.baseUrl.trim()) continue
      if (Date.now() - (unsupported.get(key) ?? -Infinity) < UNSUPPORTED_MS) continue
      wanted.set(profile.id, profile)
    }
  }
  for (const [profileId, stream] of streams) {
    const profile = wanted.get(profileId)
    if (profile && connectionKey(profile) === stream.key) continue
    stream.controller.abort()
    streams.delete(profileId)
    setLive(profileId, false)
  }
  for (const [profileId, profile] of wanted) {
    if (streams.has(profileId)) continue
    const key = connectionKey(profile)
    const controller = new AbortController()
    streams.set(profileId, { key, controller })
    void follow(profile, key, controller.signal)
  }
}

let started = false

/** Keeps a stream open to each plugin bot's server while the app is on screen and online. */
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
