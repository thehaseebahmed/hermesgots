/**
 * The network log's rules, and nothing that touches a store: what a request is called, what the
 * numbers under a bot's name are, and what a copied log says (ADR 0086). They are pure so
 * `scripts/test-net-log.mjs` drives them with no DOM and no database; the recorder that fills the log
 * is `net-recorder.ts`, and the screen is `components/network-log.tsx`.
 */
import type { NetRequest } from "@/lib/db"
// Relative and with its extension, so the unit tier loads this module with no bundler: `host-url.ts`
// is import-free for exactly that reason.
import { PLUGIN_ROOT } from "./host-url.ts"

/** How many requests the log keeps, newest first. */
export const KEPT = 500

/** How many the screen draws at once. */
export const DRAWN = 200

/**
 * Each way a request can end, and the three rules read off it: its words, whether its wait counts in
 * the average, and whether it failed. One table, so a sixth ending is a line rather than four
 * comparisons scattered across the app.
 */
const ENDING: Record<NetRequest["ending"], { label: string; timed: boolean; failed: boolean }> = {
  answered: { label: "answered", timed: true, failed: false },
  refused: { label: "refused", timed: true, failed: true },
  network: { label: "never landed", timed: false, failed: true },
  timeout: { label: "timed out", timed: false, failed: true },
  stopped: { label: "stopped", timed: false, failed: true },
}

/** Whether a request did not end in an answer: what the strip and Developer's row both count. */
export const failed = (row: NetRequest) => ENDING[row.ending].failed

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** A name a host minted with a number in it — `gots-1a2b`, `e2e-netlog-dmk73b` — is an id too. */
const MINTED = /^(?=.*\d)[A-Za-z0-9_-]{8,}$/

const isId = (part: string) => UUID.test(part) || /^\d+$/.test(part) || MINTED.test(part)

/** The prefixes a bot's host answers under, longest first, which say nothing about what was asked. */
const PREFIXES = [PLUGIN_ROOT, "/api", "/v1"]

/**
 * A path with the prefix a host answers under taken off, and a multiplexing gateway's `/p/<name>`
 * with it: that segment names the server that answered, not what was asked. Run twice, so a profile
 * standing before the prefix is stripped as well as one standing after it.
 */
function strip(path: string) {
  const prefix = PREFIXES.find((one) => path.startsWith(one))
  return (prefix ? path.slice(prefix.length) : path).replace(/^\/p\/[^/]+/, "")
}

/**
 * A request as the log names it: the method the app sent and the route it went to, with the origin,
 * a multiplexed profile, the query and every id taken out — `GET sessions/:id/messages`, never a
 * URL. Nothing a request carried survives this, which is why the row it becomes is safe to copy.
 */
export function routeOf(input: string, method = "GET") {
  const route = strip(strip(new URL(input, "http://device.invalid").pathname))
    .split("/")
    .filter(Boolean)
    .map((part) => (isId(part) ? ":id" : part))
    .join("/")
  return `${method.toUpperCase()} ${route || "/"}`
}

/** The 95th percentile by nearest rank: on a short log that is its slowest request, not its fourth. */
function slowest(sorted: number[]) {
  if (!sorted.length) return null
  return sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)]
}

export interface NetFigures {
  /** How many requests the selection holds. */
  count: number
  /** How many of them did not end in an answer. */
  failed: number
  /** The mean wait of the requests that were answered or refused, to the nearest millisecond. */
  average: number | null
  /** The slowest 5% of those waits. */
  slowest: number | null
  /** The newest stream's open time, once its first frame arrived. */
  open: number | null
  /** The newest sent message's wait for the reply's first words. */
  words: number | null
}

/**
 * The numbers under a bot's name, read off the requests the log still holds. A wait that ended in a
 * timeout is counted as a failure and kept out of the average, because a minute of waiting for
 * nothing would read as the connection's own speed.
 */
/** The newest request that opened a stream, and how long that one took to open if it has. */
function newestStream(rows: NetRequest[]) {
  let at = -1
  let open: number | null = null
  for (const row of rows) {
    if (!row.stream || row.at <= at) continue
    at = row.at
    open = row.frame ?? null
  }
  return open
}

export function figuresOf(rows: NetRequest[]): NetFigures {
  const waited = rows
    .filter((row) => ENDING[row.ending].timed)
    .map((row) => row.ms)
    .sort((a, b) => a - b)
  const newest = (pick: (row: NetRequest) => number | undefined) => {
    let at = -1
    let value: number | null = null
    for (const row of rows) {
      const found = pick(row)
      if (found !== undefined && row.at > at) {
        at = row.at
        value = found
      }
    }
    return value
  }
  return {
    count: rows.length,
    failed: rows.filter(failed).length,
    average: waited.length
      ? Math.round(waited.reduce((sum, ms) => sum + ms, 0) / waited.length)
      : null,
    slowest: slowest(waited),
    // The newest stream's own open, never an older one's: a stream still opening has no figure yet.
    open: newestStream(rows),
    words: newest((row) => row.words),
  }
}

/** A wait as the log writes it: milliseconds under a second, seconds with one decimal above. */
export function waitText(ms: number | null | undefined) {
  if (ms === null || ms === undefined) return "—"
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(1)} s`
}

/** One formatter for every clock the table prints, made once: a row's own is a formatter per render. */
const CLOCK = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
})

/** A time of day on this device's clock, to the second. */
export const clockText = (at: number) => CLOCK.format(at)

/** What a row's status reads as: the code it answered with, or how it ended without one. */
export function endingLabel(row: NetRequest) {
  return row.status === undefined ? ENDING[row.ending].label : String(row.status)
}

/**
 * The whole log as one block a bug report can carry: the rows picked field by field, so a copy
 * cannot take anything the row does not already hold.
 */
export function formatNetLog(rows: NetRequest[]) {
  return JSON.stringify(
    {
      at: new Date().toISOString(),
      kept: rows.length,
      requests: [...rows]
        .sort((a, b) => b.at - a.at)
        .map((row) => ({
          at: new Date(row.at).toISOString(),
          bots: row.bots,
          route: row.route,
          ms: row.ms,
          status: row.status ?? null,
          ending: row.ending,
          stream: row.stream ?? false,
          frame: row.frame ?? null,
          words: row.words ?? null,
        })),
    },
    null,
    2,
  )
}
