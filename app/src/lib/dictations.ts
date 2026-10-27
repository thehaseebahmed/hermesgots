/**
 * The Dictation log as this device holds it: a mirror of every bot's dictations, and the totals each
 * bot's host last reported. The host is the durable copy and the device draws from the mirror, so a
 * screen never waits on a host and a host that is away costs nothing (ADR 0060).
 */
import { useLiveQuery } from "dexie-react-hooks"

import { connectionKey, serverConfig } from "@/lib/connection"
import { lacksRoute } from "@/lib/cooldown"
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

/** What one dictation is: the words a take landed, their count, and how long they took to say. */
export function entryOf(connection: string, text: string, ms: number, at = Date.now()) {
  return { id: randomId(), connection, text, words: countWords(text), ms, at }
}

function hostOf(row: DictationRecord): HostDictation {
  return { id: row.id, text: row.text, words: row.words, ms: row.ms, at: row.at }
}

/** The cached totals move with a write, so the menu row counts a dictation before a host answers. */
async function bumpCache(row: DictationRecord) {
  const cached = await db.dictationStats.get(row.connection)
  if (!cached) return
  await db.dictationStats.put({
    ...cached,
    words: cached.words + row.words,
    ms: cached.ms + row.ms,
    count: cached.count + 1,
    newest: cached.newest === null ? row.at : Math.max(cached.newest, row.at),
  })
}

/**
 * Writes one dictation at the moment a take's words land. The mirror takes it first; the host's copy
 * is fired and never awaited, so a host that is away — or too old to have the routes — costs the take
 * nothing.
 */
export async function writeDictation(config: HermesConfig, text: string, ms: number) {
  const words = text.trim()
  if (!words) return
  const row = entryOf(connectionKey(config), words, ms)
  await db.dictationLog.put(row)
  await bumpCache(row)
  void postDictation(
    config,
    { ...hostOf(row), device: deviceId() },
    AbortSignal.timeout(WRITE_TIMEOUT_MS),
  ).catch(quietly("Writing a dictation to its host"))
}

// One id per device, so a host's log says which device a dictation came from without naming anyone.
const DEVICE_KEY = "memento:dictation-device"

function deviceId() {
  try {
    const held = localStorage.getItem(DEVICE_KEY)
    if (held) return held
    const made = randomId()
    localStorage.setItem(DEVICE_KEY, made)
    return made
  } catch {
    return null
  }
}

/** Every page a host holds, newest first, walked back until one comes short. */
async function readAll(config: HermesConfig) {
  const rows: HostDictation[] = []
  let before: number | null = null
  for (;;) {
    const page = await getDictations(config, before, PAGE, AbortSignal.timeout(READ_TIMEOUT_MS))
    rows.push(...page)
    if (page.length < PAGE) return rows
    before = page.at(-1)?.at ?? null
    if (before === null) return rows
  }
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
  const host = await getDictationStats(config, AbortSignal.timeout(READ_TIMEOUT_MS))
  let mirror = await db.dictationLog.where("connection").equals(key).toArray()
  const cached = await db.dictationStats.get(key)
  const local = fingerprintOf(mirror, cached?.clearedAt ?? 0)
  if (agrees(local, host)) {
    await db.dictationStats.put({ id: key, ...host, at: Date.now() })
    return
  }

  // A clear needs no diff: everything this device holds from before the stamp is gone.
  const gone = clearedAway(mirror, host.clearedAt)
  if (gone.length) {
    await db.dictationLog.bulkDelete(gone.map((row) => row.id))
    const dropped = new Set(gone.map((row) => row.id))
    mirror = mirror.filter((row) => !dropped.has(row.id))
  }

  // Divergence is handled by its shape: an append is one page, anything else walks the log — a
  // fresh device has an empty mirror, so it walks it once rather than trusting one page.
  const after = fingerprintOf(mirror, host.clearedAt)
  const appended = mirror.length > 0 && host.count > after.count && host.oldest === after.oldest
  if (appended) {
    const page = await getDictations(config, null, PAGE, AbortSignal.timeout(READ_TIMEOUT_MS))
    const fresh = toUpsert(mirror, page).map((row) => ({ ...row, connection: key }))
    if (fresh.length) await db.dictationLog.bulkPut(fresh)
  } else {
    const rows = await readAll(config)
    const have = new Set(rows.map((row) => row.id))
    const lost = mirror.filter((row) => !have.has(row.id)).map((row) => row.id)
    if (lost.length) await db.dictationLog.bulkDelete(lost)
    await db.dictationLog.bulkPut(rows.map((row) => ({ ...row, connection: key })))
  }
  await db.dictationStats.put({ id: key, ...host, at: Date.now() })
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
  const key = connectionKey(config)
  const row = await db.dictationLog.get(id)
  try {
    await deleteDictation(config, id, AbortSignal.timeout(WRITE_TIMEOUT_MS))
  } catch (error) {
    // A host too old to have the routes keeps whatever it holds; this device still forgets the row.
    if (!(await lacksRoute(config, error, DICTATIONS))) throw error
  }
  await db.dictationLog.delete(id)
  if (!row) return
  const cached = await db.dictationStats.get(key)
  if (cached)
    await db.dictationStats.put({
      ...cached,
      words: Math.max(0, cached.words - row.words),
      ms: Math.max(0, cached.ms - row.ms),
      count: Math.max(0, cached.count - 1),
    })
}

/** Takes every bot's log away: each host its own, this device the mirror and the totals with it. */
export async function clearDictationLog(profiles: Profile[]) {
  const refused: string[] = []
  await Promise.all(
    profiles.map((profile) =>
      clearDictations(serverConfig(profile), AbortSignal.timeout(WRITE_TIMEOUT_MS)).catch(
        async (error: unknown) => {
          if (!(await lacksRoute(serverConfig(profile), error, DICTATIONS)))
            refused.push(profile.name)
        },
      ),
    ),
  )
  await db.transaction("rw", [db.dictationLog, db.dictationStats], async () => {
    await db.dictationLog.clear()
    await db.dictationStats.clear()
  })
  return refused
}

/** The mirror's newest `shown` dictations, every bot's, as the History tab draws them. */
export function useDictationRows(shown: number) {
  return useLiveQuery(() => db.dictationLog.orderBy("at").reverse().limit(shown).toArray(), [shown])
}

/** How many this device holds, so the list knows there is more to append. */
export function useDictationCount() {
  return useLiveQuery(() => db.dictationLog.count(), [])
}

/** The bots' last reported totals, added up: the stats card and the Settings menu row. */
export function useDictationTotals() {
  const rows = useLiveQuery(() => db.dictationStats.toArray(), [])
  return { totals: sumTotals(rows ?? []), reported: Boolean(rows?.length) }
}
