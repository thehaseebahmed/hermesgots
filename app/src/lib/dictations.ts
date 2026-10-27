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
  postDictation,
  type HermesConfig,
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
  return { id: randomId(), connection, text, words: countWords(text), ms, at, posted: false }
}

function hostOf(row: DictationRecord): HostDictation {
  return { id: row.id, text: row.text, words: row.words, ms: row.ms, at: row.at }
}

/** Hands one take to its host and marks the mirror's row as one the host holds too. */
async function post(config: HermesConfig, row: DictationRecord) {
  await postDictation(config, hostOf(row), AbortSignal.timeout(WRITE_TIMEOUT_MS))
  await db.dictationLog.update(row.id, { posted: true })
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
  let before: number | undefined
  for (;;) {
    const page = await getDictations(
      config,
      before ?? null,
      PAGE,
      AbortSignal.timeout(READ_TIMEOUT_MS),
    )
    rows.push(...page)
    if (page.length < PAGE) return rows
    before = page[page.length - 1].at
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
  // A take whose host write never answered belongs to the mirror alone. Posting it here keeps the
  // host the durable copy the ADR promises, and one open settles both sides.
  if (mirror.some((row) => !row.posted)) {
    await Promise.all(
      mirror
        .filter((row) => !row.posted)
        .map((row) => post(config, row).catch(quietly("Writing a dictation to its host"))),
    )
    mirror = await db.dictationLog.where("connection").equals(key).toArray()
  }

  let host: HostAnswer
  try {
    host = await getDictationStats(config, AbortSignal.timeout(READ_TIMEOUT_MS))
  } catch (error) {
    if (!(await lacksRoute(config, error, DICTATIONS))) throw error
    missing.start(key)
    return
  }
  missing.clear(key)

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
    const page = await getDictations(config, null, PAGE, AbortSignal.timeout(READ_TIMEOUT_MS))
    const fresh = toUpsert(mirror, page).map((row) => ({ ...row, connection: key, posted: true }))
    if (fresh.length) await db.dictationLog.bulkPut(fresh)
  } else {
    const rows = await readAll(config)
    const have = new Set(rows.map((row) => row.id))
    const lost = synced.filter((row) => !have.has(row.id)).map((row) => row.id)
    if (lost.length) await db.dictationLog.bulkDelete(lost)
    const fresh = toUpsert(mirror, rows).map((row) => ({ ...row, connection: key, posted: true }))
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
  return useLiveQuery(() => db.dictationLog.orderBy("at").reverse().limit(shown).toArray(), [shown])
}

/** The bots' last reported totals, added up: the stats card and the Settings menu row. */
export function useDictationTotals() {
  const rows = useLiveQuery(() => db.dictationStats.toArray(), [])
  return { totals: sumTotals(rows ?? []), reported: Boolean(rows?.length) }
}
