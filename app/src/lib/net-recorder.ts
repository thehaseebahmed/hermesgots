/**
 * Records what this device's own requests cost: every call both chat screens make to a bot's host
 * passes the one watcher here, and lands in the log behind Developer's Network log switch (ADR 0086).
 *
 * Nothing is measured while the switch is off: the seam holds no watcher and a request is the fetch it
 * always was. On, a row reaches the store through a buffer, so a request never waits on it.
 */
import { liveQuery } from "dexie"

import { db, getSettings, listProfiles, type NetRequest, type Profile } from "@/lib/db"
import { pluginRoot, serverRoot } from "@/lib/host-url"
import { KEPT, routeOf } from "@/lib/net-log"
import { watchRequests, type Watching } from "@/lib/net-watch"
import { noteFailure } from "@/lib/report"
import { randomId } from "@/lib/utils"

const FLUSH_MS = 2000

let recording = false
/** Each bot's roots, longest first, so the bots a request was for are read off its URL alone. */
let roots: { root: string; bots: string[] }[] = []
let buffer: NetRequest[] = []
let timer: number | undefined
let flushing: Promise<unknown> | undefined
/** When the log was last emptied: a stream from before it must not put its row back. */
let clearedAt = 0
/** Where each row's clock started, and the row a response is still expected to send more of. */
const starts = new WeakMap<NetRequest, number>()
const watching = new WeakMap<Response, NetRequest>()

/**
 * Follows the switch and the bots for as long as the app runs. Turning the switch off stops the
 * measuring but still lands what was already measured, because the evidence is what it was on for.
 */
export function startNetLog() {
  liveQuery(async () => ({
    settings: await getSettings(),
    profiles: await listProfiles(),
  })).subscribe(
    ({ settings, profiles }) => {
      recording = Boolean(settings?.developer && settings.netLog)
      roots = rootsOf(profiles)
      watchRequests(recording ? watcher : undefined)
      if (!recording) void flush()
    },
    (error) => noteFailure("Watching the network log's switch", error),
  )
  // A page being put away must not take the last seconds of evidence with it, nor a reload the
  // request it was made to investigate.
  window.addEventListener("pagehide", () => void flush())
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void flush()
  })
}

/**
 * Each bot's server and its plugin, which a multiplexed host serves under a different prefix, so a
 * plugin call is attributed to its bot as the server's own calls are.
 */
function rootsOf(profiles: Profile[]) {
  const byRoot = new Map<string, string[]>()
  const add = (root: string, id: string) => {
    const bots = byRoot.get(root)
    if (bots) bots.push(id)
    else byRoot.set(root, [id])
  }
  for (const profile of profiles) {
    if (!profile.baseUrl?.trim()) continue
    add(serverRoot(profile.baseUrl), profile.id)
    add(pluginRoot(profile.baseUrl), profile.id)
  }
  return [...byRoot.entries()]
    .map(([root, bots]) => ({ root, bots }))
    .sort((a, b) => b.root.length - a.root.length)
}

/** The bots whose server a URL belongs to: a twin bot on one server answers for both. */
function botsFor(url: string) {
  return roots.find((entry) => url.startsWith(`${entry.root}/`))?.bots ?? []
}

const methodOf = (init?: RequestInit) => (init?.method ?? "GET").toUpperCase()

function settle(
  url: string,
  init: RequestInit | undefined,
  started: number,
  ending: NetRequest["ending"],
  status?: number,
): NetRequest {
  const row: NetRequest = {
    id: randomId(),
    at: Date.now(),
    bots: botsFor(url),
    route: routeOf(url, methodOf(init)),
    ms: Math.round(performance.now() - started),
    ending,
  }
  if (status !== undefined) row.status = status
  starts.set(row, started)
  return row
}

function netFetch(input: RequestInfo | URL, init?: RequestInit) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  const started = performance.now()
  return fetch(input, init).then(
    (response) => {
      answer(url, init, started, response)
      return response
    },
    (error: unknown) => {
      fail(url, init, started, error)
      throw error
    },
  )
}

const watcher: Watching = {
  ask: netFetch,
  frame: landFrame,
  words: landWords,
}

function answer(url: string, init: RequestInit | undefined, started: number, response: Response) {
  const row = settle(url, init, started, response.ok ? "answered" : "refused", response.status)
  // Only a stream sends anything after its headers, so only a stream is watched for more.
  if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) {
    row.stream = true
    watching.set(response, row)
  }
  queue(row)
}

function fail(url: string, init: RequestInit | undefined, started: number, error: unknown) {
  const name = error instanceof DOMException ? error.name : ""
  const ending = name === "AbortError" ? "stopped" : name === "TimeoutError" ? "timeout" : "network"
  queue(settle(url, init, started, ending))
}

/**
 * One of a stream's late numbers. The row is put again rather than patched, so a number arriving
 * while that row's own write is in flight still lands: `bulkPut` upserts on the same id and instant.
 */
function land(row: NetRequest, field: "frame" | "words", start: number | undefined) {
  if (row[field] !== undefined || start === undefined || row.at <= clearedAt) return
  row[field] = Math.round(performance.now() - start)
  if (!buffer.includes(row)) buffer.push(row)
  schedule()
}

/** How long this stream took to open, which is this request's own wait. */
function landFrame(response: Response) {
  const row = watching.get(response)
  if (row) land(row, "frame", starts.get(row))
}

/** How long the send waited for words: this request's own wait unless another request was the send. */
function landWords(response: Response, from?: number) {
  const row = watching.get(response)
  if (row) land(row, "words", from ?? starts.get(row))
}

/** Empties the log at the module that owns it, so rows still buffered cannot come back after it. */
export async function clearNetLog() {
  buffer = []
  window.clearTimeout(timer)
  timer = undefined
  clearedAt = Date.now()
  await db.netLog.clear()
}

function queue(row: NetRequest) {
  buffer.push(row)
  schedule()
}

function schedule() {
  if (timer !== undefined || !buffer.length) return
  timer = window.setTimeout(() => {
    timer = undefined
    void flush().finally(schedule)
  }, FLUSH_MS)
}

/** Writes everything buffered, putting the rows back when the store refuses them. */
function flush() {
  if (flushing) return flushing
  if (!buffer.length) return Promise.resolve()
  const ready = buffer
  buffer = []
  flushing = (async () => {
    await db.netLog.bulkPut(ready)
    // Counted rather than tallied: a row put again with a late frame is one row, and a tally says two.
    if ((await db.netLog.count()) > KEPT) await trimNetLog()
  })()
    .catch((error) => {
      // A refused write keeps its rows for the next pass: the log is the evidence, not a cache.
      noteFailure("Writing the network log", error)
      buffer = [...ready, ...buffer].slice(-KEPT)
    })
    .finally(() => {
      flushing = undefined
    })
  return flushing
}

/** The log keeps its newest requests and lets the oldest go, as the media cache trims itself. */
export async function trimNetLog() {
  const total = await db.netLog.count()
  if (total <= KEPT) return
  const oldest = await db.netLog
    .orderBy("at")
    .limit(total - KEPT)
    .toArray()
  if (oldest.length) await db.netLog.bulkDelete(oldest.map((row) => row.id))
}
