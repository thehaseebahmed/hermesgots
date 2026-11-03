/**
 * Records what this device's own requests cost: every call both chat screens make to a bot's host
 * passes the one wrapper here, and lands in the log behind Developer's Network log switch (ADR 0086).
 *
 * Nothing is measured while the switch is off — `netFetch` is then one boolean check in front of the
 * fetch it already made. While it is on, a row is written through a buffer, so a request never waits
 * on the store, and the log is trimmed to its newest few hundred on every flush.
 */
import { liveQuery } from "dexie"

import { db, getSettings, listProfiles, type NetRequest, type Profile } from "@/lib/db"
import { serverRoot } from "@/lib/host-url"
import { KEPT, routeOf } from "@/lib/net-log"
import { watchRequests } from "@/lib/net-watch"
import { quietly } from "@/lib/report"
import { randomId } from "@/lib/utils"

/** How often what has been measured so far reaches the store. */
const FLUSH_MS = 2000

/**
 * How long a stream's row waits for its first frame before the log settles it as it stands, so a
 * stream that opens and then says nothing still shows up rather than sitting in memory for ever.
 */
const HOLD_MS = 120_000

let on = false
/** Each bot's server, longest first, so the bot a request was for is read off its URL alone. */
let roots: { root: string; bots: string[] }[] = []
let buffer: NetRequest[] = []
let timer: number | undefined
let flushing: Promise<unknown> | undefined
/** Where each row's clock started, and the row a response is being watched for. */
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
  })).subscribe(({ settings, profiles }) => {
    on = Boolean(settings?.developer && settings.netLog)
    roots = rootsOf(profiles)
    install(on)
    if (!on) void flush()
  })
}

function rootsOf(profiles: Profile[]) {
  const byRoot = new Map<string, string[]>()
  for (const profile of profiles) {
    if (!profile.baseUrl?.trim()) continue
    const root = serverRoot(profile.baseUrl)
    byRoot.set(root, [...(byRoot.get(root) ?? []), profile.id])
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

function newRow(url: string, init: RequestInit | undefined, started: number): NetRequest {
  const row: NetRequest = {
    id: randomId(),
    at: Date.now(),
    bot: botsFor(url),
    route: routeOf(url, methodOf(init)),
    ms: 0,
    ending: "answered",
  }
  starts.set(row, started)
  return row
}

/**
 * The one wrapper a request to a bot's host goes through. With the log off it is the fetch itself;
 * with it on, the same fetch, watched from just before it is asked to just after it answers.
 */
export function netFetch(input: RequestInfo | URL, init?: RequestInit) {
  if (!on) return fetch(input, init)
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

function answer(url: string, init: RequestInit | undefined, started: number, response: Response) {
  const row = newRow(url, init, started)
  row.ms = Math.round(performance.now() - started)
  row.status = response.status
  row.ending = response.ok ? "answered" : "refused"
  if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) row.stream = true
  watching.set(response, row)
  queue(row)
}

function fail(url: string, init: RequestInit | undefined, started: number, error: unknown) {
  const row = newRow(url, init, started)
  row.ms = Math.round(performance.now() - started)
  const name = error instanceof DOMException ? error.name : ""
  row.ending = name === "AbortError" ? "stopped" : name === "TimeoutError" ? "timeout" : "network"
  queue(row)
}

/** One of a row's late numbers, whether it is still in the buffer or already written. */
function land(response: Response, field: "frame" | "words") {
  const row = watching.get(response)
  if (!row || row[field] !== undefined) return
  const value = Math.round(performance.now() - (starts.get(row) ?? performance.now()))
  row[field] = value
  if (buffer.includes(row)) {
    schedule()
    return
  }
  const patch = field === "frame" ? { frame: value } : { words: value }
  void db.netLog.update(row.id, patch).catch(quietly("Recording a network wait"))
}

/** A stream's first frame arrived: what the log reads as how long connecting took. */
export function netFrame(response: Response) {
  land(response, "frame")
}

/** The reply's first words arrived: the send's own wait, never a request's. */
export function netWords(response: Response) {
  land(response, "words")
}

/**
 * Plugs the recorder into the seam both transports ask through, or takes it out again when the
 * switch is turned off: with nothing registered, a request is the fetch it always was.
 */
function install(on: boolean) {
  watchRequests(on ? { ask: netFetch, frame: netFrame, words: netWords } : undefined)
}

function queue(row: NetRequest) {
  buffer.push(row)
  schedule()
}

function schedule() {
  if (timer !== undefined || !buffer.length) return
  timer = window.setTimeout(() => {
    timer = undefined
    void flush()
    schedule()
  }, FLUSH_MS)
}

/** Writes what has settled: everything but a stream still waiting for its first frame. */
function flush() {
  if (flushing) return flushing
  const now = Date.now()
  const ready = buffer.filter(
    (row) => row.frame !== undefined || !row.stream || now - row.at > HOLD_MS,
  )
  if (!ready.length) return Promise.resolve()
  buffer = buffer.filter((row) => !ready.includes(row))
  flushing = db.netLog
    .bulkPut(ready)
    .then(trim)
    .catch(quietly("Writing the network log"))
    .finally(() => {
      flushing = undefined
    })
  return flushing
}

/** The log keeps its newest requests and lets the oldest go, the way the media cache trims itself. */
async function trim() {
  const count = await db.netLog.count()
  if (count <= KEPT) return
  const oldest = await db.netLog
    .orderBy("at")
    .limit(count - KEPT)
    .toArray()
  if (oldest.length) await db.netLog.bulkDelete(oldest.map((row) => row.id))
}
