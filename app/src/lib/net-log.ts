/**
 * The network log's rules, and nothing that touches a store: what a request is called, what the
 * numbers under a bot's name are, what the log keeps and what a copied log says (ADR 0086). They are
 * pure so `scripts/test-net-log.mjs` drives them with no DOM and no database; the recorder that
 * fills the log is `net-recorder.ts`, and the screen is `components/network-log.tsx`.
 */
import type { NetRequest } from "@/lib/db"

/** How many requests the log keeps: the newest, oldest dropped first. */
export const KEPT = 500

/** How many of them the screen draws at once, newest first. */
export const DRAWN = 200

/** What a request's wait was called off as, in the app's words rather than a status code's. */
const ENDING: Record<NetRequest["ending"], string> = {
  answered: "answered",
  refused: "refused",
  network: "never landed",
  timeout: "timed out",
  stopped: "stopped",
}

/** An id rather than a name: a session, a run, a queued message, a skill's name-keyed row. */
const ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d+|[0-9a-f]{16,})$/i

/** The plugin's own prefix, which says nothing about what was asked. */
const PLUGIN = "/api/plugins/memento"

/**
 * A request as the log names it: the method the app sent and the route it went to, with the origin,
 * the query and every id taken out — `GET sessions/:id/messages`, never a URL. Nothing a request
 * carried survives this, which is why the row it becomes is safe to copy.
 */
export function routeOf(input: string, method = "GET") {
  let path: string
  try {
    path = new URL(input, "http://device.invalid").pathname
  } catch {
    path = input
  }
  if (path.startsWith(PLUGIN)) {
    path = path.slice(PLUGIN.length)
    // A multiplexing gateway puts the profile inside the plugin's prefix; it names the server, not
    // the route.
    if (path.startsWith("/p/")) path = path.replace(/^\/p\/[^/]+/, "")
  } else if (path.startsWith("/api")) {
    path = path.slice("/api".length)
  } else if (path.startsWith("/v1")) {
    path = path.slice("/v1".length)
  } else if (path.startsWith("/p/")) {
    path = path.replace(/^\/p\/[^/]+/, "")
  }
  const route = path
    .split("/")
    .filter(Boolean)
    .map((part) => (ID.test(part) ? ":id" : part))
    .join("/")
  return `${method.toUpperCase()} ${route || "/"}`
}

/** The 95th percentile of a sorted list, by nearest rank: the slowest 5% read from the top. */
function percentile(sorted: number[], share: number) {
  if (!sorted.length) return null
  return sorted[Math.min(sorted.length - 1, Math.floor(share * (sorted.length - 1)))]
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
export function figuresOf(rows: NetRequest[]): NetFigures {
  const waits = rows
    .filter((row) => row.ending === "answered" || row.ending === "refused")
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
    failed: rows.filter((row) => row.ending !== "answered").length,
    average: waits.length
      ? Math.round(waits.reduce((sum, ms) => sum + ms, 0) / waits.length)
      : null,
    slowest: percentile(waits, 0.95),
    open: newest((row) => row.frame),
    words: newest((row) => row.words),
  }
}

/** The rows the log keeps: the newest `kept`, oldest dropped first. */
export function trimmed(rows: NetRequest[], kept = KEPT) {
  if (rows.length <= kept) return rows
  return [...rows].sort((a, b) => b.at - a.at).slice(0, kept)
}

/** What a row's status reads as: the code it answered with, or how it ended without one. */
export function endingLabel(row: NetRequest) {
  if (row.ending === "answered" || row.ending === "refused")
    return row.status === undefined ? ENDING[row.ending] : String(row.status)
  return ENDING[row.ending]
}

/** A wait as the log writes it: milliseconds under a second, seconds with one decimal above it. */
export function waitLabel(ms: number | null | undefined) {
  if (ms === null || ms === undefined) return "—"
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(1)} s`
}

/** A request's clock as the table reads it: the device's own time of day, to the second. */
export function clockLabel(at: number) {
  return new Date(at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
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
          bot: row.bot,
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
