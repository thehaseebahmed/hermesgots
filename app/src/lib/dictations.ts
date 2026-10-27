/**
 * The Dictation log as this device holds it: a mirror of every bot's dictations, and the totals each
 * bot's host last reported. The host is the durable copy and the device draws from the mirror, so a
 * screen never waits on a host and a host that is away costs nothing (ADR 0060).
 */
import { useLiveQuery } from "dexie-react-hooks"

import { connectionKey, serverConfig } from "@/lib/connection"
import { cooldown, lacksRoute } from "@/lib/cooldown"
import { db, type DictationRecord, type Profile } from "@/lib/db"
import {
  agrees,
  clearedAway,
  countWords,
  fingerprintOf,
  sumTotals,
  toUpsert,
} from "@/lib/dictation-log"
import { READ_TIMEOUT_MS, WRITE_TIMEOUT_MS } from "@/lib/freshness"
import {
  clearDictations,
  deleteDictation,
  getDictationStats,
  getDictations,
  HermesError,
  postDictation,
  type HermesConfig,
  type DictationWrite,
  type HostDictation,
} from "@/lib/hermes"
import { quietly } from "@/lib/report"
import { randomId } from "@/lib/utils"

/** The feature every route of the log hangs behind (`dictations.py`). */
export const DICTATIONS = "dictations"

/** One page a reconcile asks a host for: the bound on a read, not on the log. */
export const PAGE = 50

type Server = Pick<HermesConfig, "baseUrl" | "apiKey">
type HostAnswer = Awaited<ReturnType<typeof getDictationStats>>

/** Bots whose plugin has no log at all are left alone for a while, so an open costs them nothing. */
const missing = cooldown()

function entryOf(connection: string, text: string, ms: number, at = Date.now()): DictationRecord {
  return {
    id: randomId(),
    connection,
    text,
    words: countWords(text),
    ms,
    at,
    loggedAt: at,
    posted: false,
  }
}

function hostOf(row: DictationRecord): DictationWrite {
  return { id: row.id, text: row.text, words: row.words, ms: row.ms, at: row.at }
}

/** Refusals about the take itself: the same words would be refused on every open, so they are final. */
const REFUSED = new Set([400, 413])

/**
 * Hands one take to its host and marks the mirror's row as one the host holds too. Answers whether
 * the host took it, so a caller knows whether the host's own totals moved.
 */
async function post(config: HermesConfig, row: DictationRecord): Promise<boolean> {
  let answer: HostDictation | null
  try {
    answer = await postDictation(config, hostOf(row), AbortSignal.timeout(WRITE_TIMEOUT_MS))
  } catch (error) {
    // The host read the words and said no. Asking again on every open asks the same question of the
    // same bytes, so the row is marked and left to this device alone.
    if (error instanceof HermesError && error.status !== undefined && REFUSED.has(error.status)) {
      await db.dictationLog.update(row.id, { rejected: true })
      return false
    }
    throw error
  }
  // A host that takes the words and answers with nothing has not told us when it heard them; the row
  // stays unposted so the next open asks again, which the host's own idempotence makes harmless.
  if (!answer) return false
  // The host's answer is the row as it stored it: its clock heard the take, and its `at` is the one it
  // kept — a device clock in the future is clamped to that, so the sheet shows a time that can exist.
  await db.dictationLog.update(row.id, {
    posted: true,
    at: answer.at,
    seenAt: answer.seenAt,
    loggedAt: answer.seenAt,
  })
  return true
}

/** How many takes are handed over at once: an upgrade's backlog is a queue, not a burst. */
const POSTS_AT_ONCE = 4

/** Answers how many of them the host took, which is how many moved its totals. */
async function postAll(config: HermesConfig, rows: DictationRecord[]): Promise<number> {
  let taken = 0
  for (let index = 0; index < rows.length; index += POSTS_AT_ONCE) {
    const batch = rows.slice(index, index + POSTS_AT_ONCE)
    const answers = await Promise.all(
      batch.map(async (row) => {
        try {
          return await post(config, row)
        } catch (error) {
          quietly("Writing a dictation to its host")(error)
          return false
        }
      }),
    )
    taken += answers.filter(Boolean).length
  }
  return taken
}

/** Marks rows as ones their host holds, in one write, so the screens reading them wake once. */
async function markPosted(rows: DictationRecord[]) {
  await db.dictationLog.bulkPut(rows.map((row) => ({ ...row, posted: true })))
}

/**
 * A host's totals, or nothing where its plugin has no log at all — which cools that bot off for a
 * while. A host that is merely away throws, and its mirror is left exactly as it is.
 */
async function askStats(config: HermesConfig, key: string): Promise<HostAnswer | null> {
  try {
    const host = await getDictationStats(config, AbortSignal.timeout(READ_TIMEOUT_MS))
    missing.clear(key)
    return host
  } catch (error) {
    if (!(await lacksRoute(config, error, DICTATIONS))) throw error
    missing.start(key)
    return null
  }
}

/**
 * Writes one dictation at the moment a take's words land. The mirror takes it first and the host's
 * copy is fired without being awaited, so a host that is away — or too old to have the routes —
 * costs the take nothing, and a take the host never confirmed is posted again at the next reconcile.
 */
export async function writeDictation(config: HermesConfig, text: string, ms: number) {
  const trimmed = text.trim()
  if (!trimmed) return
  const row = entryOf(connectionKey(config), trimmed, ms)
  await db.dictationLog.put(row).catch(quietly("Logging a dictation on this device"))
  void post(config, row).catch(quietly("Writing a dictation to its host"))
}

/** Every page a host holds, newest first, walked back until one comes short. */
async function readAll(config: HermesConfig) {
  const rows: HostDictation[] = []
  let before: number | null = null
  let beforeId: string | null = null
  for (;;) {
    const page = await getDictations(
      config,
      before,
      beforeId,
       PAGE,
      AbortSignal.timeout(READ_TIMEOUT_MS),
    )
    rows.push(...page)
    if (page.length < PAGE) return rows
    const last = page[page.length - 1]
    // A host that ignores the cursor — one too old to have it — hands back the same page for ever, so
    // a walk that is making no progress stops rather than reading the log again and again.
    if (last.id === beforeId) return rows
    before = last.seenAt
    beforeId = last.id
  }
}

/** Caches a host's totals, and only when they moved: a write wakes every screen that reads them. */
async function cacheStats(key: string, host: HostAnswer) {
  const cached = await db.dictationStats.get(key)
  if (
    cached &&
    cached.words === host.words &&
    cached.ms === host.ms &&
    cached.count === host.count &&
    cached.clearedAt === host.clearedAt
  ) {
    return
  }
  await db.dictationStats.put({
    id: key,
    words: host.words,
    ms: host.ms,
    count: host.count,
    clearedAt: host.clearedAt,
  })
}

/**
 * Brings one bot's mirror up to what its host says, and caches the answer for the stats.
 *
 * The fingerprint is the gate: a device that already agrees does nothing. Divergence is then handled
 * by its shape, so a month of history is never walked for one entry: a clear is one clock compare, an
 * append is a page, and only a real disagreement about the middle of the log reads it whole.
 */
export async function reconcileDictations(server: Server) {
  const config = serverConfig(server)
  const key = connectionKey(config)
  if (missing.cooling(key)) return

  let mirror = await db.dictationLog.where("connection").equals(key).toArray()
  // A take whose host write never answered belongs to the mirror alone, and a take its host refused
  // is one this device keeps on its own, so neither is handed over again.
  const unconfirmed = mirror.filter((row) => !row.posted && !row.rejected)

  let host: HostAnswer | null = null
  if (unconfirmed.length) {
    host = await askStats(config, key)
    if (!host) return
    // The first open after an upgrade asks before it posts: a mirror that already says what its host
    // says owes it nothing, so a whole log settles in one write instead of a POST per take the host
    // already holds. Rows the previous build wrote carry no answer either way, which is why they are
    // the ones this can settle; a row this build wrote and never confirmed is posted.
    const legacy = unconfirmed.every((row) => row.posted === undefined)
    if (legacy && agrees(fingerprintOf(mirror, host.clearedAt), host)) {
      await markPosted(unconfirmed)
      await cacheStats(key, host)
      return
    }
    // A host that never answered keeps the take here, and the next open asks again.
    const taken = await postAll(config, unconfirmed)
    mirror = await db.dictationLog.where("connection").equals(key).toArray()
    if (taken) {
      // The totals the host gave before the takes it just took are stale by exactly that many, so
      // they are asked for again rather than cached as a count its own log no longer matches.
      host = (await askStats(config, key)) ?? host
    }
  }

  if (!host) {
    host = await askStats(config, key)
    if (!host) return
  }

  // A clear needs no diff: everything this device holds from before the stamp is gone.
  const gone = clearedAway(mirror, host.clearedAt)
  if (gone.length) {
    await db.dictationLog.bulkDelete(gone.map((row) => row.id))
    const dropped = new Set(gone.map((row) => row.id))
    mirror = mirror.filter((row) => !dropped.has(row.id))
  }

  // Only rows the host holds are compared with it: a take it never confirmed would otherwise hold
  // the fingerprint apart and walk the whole log on every open.
  const synced = mirror.filter((row) => row.posted)
  if (agrees(fingerprintOf(synced, host.clearedAt), host)) {
    await cacheStats(key, host)
    return
  }

  // Divergence is handled by its shape: an append that fits one page is one read, anything else
  // walks the log. A fresh device has an empty mirror, so it walks once rather than trusting a page;
  // a gap wider than a page would never close from the newest page alone.
  const gap = host.count - synced.length
  const appended =
    synced.length > 0 && gap > 0 && gap <= PAGE && host.oldest === fingerprintOf(synced).oldest
  if (appended) {
    const page = await getDictations(
      config,
      null,
      null,
      PAGE,
      AbortSignal.timeout(READ_TIMEOUT_MS),
    )
    const fresh = toUpsert(mirror, page).map((row) => ({
      ...row,
      connection: key,
      loggedAt: row.seenAt,
      posted: true,
    }))
    if (fresh.length) await db.dictationLog.bulkPut(fresh)
  } else {
    const rows = await readAll(config)
    const have = new Set(rows.map((row) => row.id))
    // A host whose own count disagrees with the pages it served is not one a row can be taken away
    // on: a proxy in front of it can answer the totals before it answers every page, and a delete
    // read off that would lose a take both sides still hold.
    const lost =
      rows.length === host.count ? synced.filter((row) => !have.has(row.id)).map((row) => row.id) : []
    if (lost.length) await db.dictationLog.bulkDelete(lost)
    const fresh = toUpsert(mirror, rows).map((row) => ({
      ...row,
      connection: key,
      loggedAt: row.seenAt,
      posted: true,
    }))
    if (fresh.length) await db.dictationLog.bulkPut(fresh)
  }
  await cacheStats(key, host)
}

/** Reconciles every bot at once; a bot whose host refuses is noted and never blocks another. */
export async function reconcileAll(profiles: Profile[]) {
  await Promise.all(
    profiles.map((profile) =>
      reconcileDictations(profile).catch(quietly("Reconciling this bot's dictations")),
    ),
  )
}

/** Deletes one dictation: its bot's copy first, then this device's. */
export async function removeDictation(profile: Profile, id: string) {
  const config = serverConfig(profile)
  try {
    await deleteDictation(config, id, AbortSignal.timeout(WRITE_TIMEOUT_MS))
  } catch (error) {
    // A host too old to have the routes keeps whatever it holds; this device still forgets the row.
    if (!(await lacksRoute(config, error, DICTATIONS))) throw error
  }
  await db.dictationLog.delete(id)
}

/**
 * Takes every bot's log away: each host its own, this device the mirror and the totals with it. A
 * bot whose host refused keeps what this device holds, so a half-done clear cannot undo itself on
 * the next open.
 */
export async function clearDictationLog(profiles: Profile[]) {
  const refused: string[] = []
  const cleared: string[] = []
  await Promise.all(
    profiles.map(async (profile) => {
      const config = serverConfig(profile)
      try {
        await clearDictations(config, AbortSignal.timeout(WRITE_TIMEOUT_MS))
        cleared.push(connectionKey(config))
      } catch (error) {
        // An older plugin has no log, so there is nothing left on that host to keep.
        if (await lacksRoute(config, error, DICTATIONS)) cleared.push(connectionKey(config))
        else refused.push(profile.name)
      }
    }),
  )
  await db.transaction("rw", [db.dictationLog, db.dictationStats], async () => {
    for (const key of cleared) {
      await db.dictationLog.where("connection").equals(key).delete()
      await db.dictationStats.delete(key)
    }
  })
  return refused
}

/** The mirror's newest `shown` dictations, every bot's, as the History tab draws them. */
export function useDictationRows(shown: number) {
  return useLiveQuery(
    () => db.dictationLog.orderBy("loggedAt").reverse().limit(shown).toArray(),
    [shown],
  )
}

/** The bots' last reported totals, added up: the stats card and the Settings menu row. */
export function useDictationTotals() {
  const rows = useLiveQuery(() => db.dictationStats.toArray(), [])
  return { totals: sumTotals(rows ?? []), reported: Boolean(rows?.length) }
}
