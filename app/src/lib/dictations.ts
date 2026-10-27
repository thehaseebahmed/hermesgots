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
  orderOf,
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
  type HostDictationStats,
} from "@/lib/hermes"
import { quietly } from "@/lib/report"
import { randomId } from "@/lib/utils"

/** The feature every route of the log hangs behind (`dictations.py`). */
export const DICTATIONS = "dictations"

/** One page a reconcile asks a host for: the bound on a read, not on the log. */
export const PAGE = 50

/**
 * A page the walk asks for. A repair reads the whole log, so it takes the most a host will answer with
 * rather than the one page an append fits in.
 */
const WALK_PAGE = 200

type Server = Pick<HermesConfig, "baseUrl" | "apiKey">
type HostAnswer = Awaited<ReturnType<typeof getDictationStats>>

/** Bots whose plugin has no log at all are left alone for a while, so an open costs them nothing. */
const missing = cooldown()

/** Everything a mirror row is but the instant it is placed by, which is this module's to compute. */
type RowFields = Omit<DictationRecord, "loggedAt">

/**
 * A row as the mirror holds it: its `loggedAt` is the instant `orderOf` reads off the row, so the order
 * the screen draws by and the one its fingerprint is compared on can't come apart.
 */
function stored(row: RowFields): DictationRecord {
  return { ...row, loggedAt: orderOf(row) }
}

function entryOf(connection: string, text: string, ms: number, heard?: string): DictationRecord {
  const asHeard = heard?.trim()
  return stored({
    id: randomId(),
    connection,
    text,
    ...(asHeard ? { heard: asHeard } : {}),
    words: countWords(text),
    ms,
    at: Date.now(),
    posted: false,
  })
}

function hostOf(row: DictationRecord): DictationWrite {
  return {
    id: row.id,
    text: row.text,
    ...(row.heard ? { heard: row.heard } : {}),
    words: row.words,
    ms: row.ms,
    at: row.at,
  }
}

/** Refusals about the take itself: the same words would be refused on every open, so they are final. */
const REFUSED = new Set([400, 413])

/** What one hand-over came to: the host's answer, a refusal of the words, or a host with neither. */
type Posting = { row: DictationRecord; answer: HostDictation | null; refused: boolean }

/**
 * Hands one take to its host, and writes nothing: a batch of these lands as one write, so the screens
 * reading the mirror wake once rather than once per take an upgrade left owed.
 */
async function post(config: HermesConfig, row: DictationRecord): Promise<Posting> {
  try {
    const answer = await postDictation(config, hostOf(row), AbortSignal.timeout(WRITE_TIMEOUT_MS))
    return { row, answer: answer ?? null, refused: false }
  } catch (error) {
    if (error instanceof HermesError && error.status !== undefined && REFUSED.has(error.status))
      return { row, answer: null, refused: true }
    throw error
  }
}

/** The row a hand-over leaves behind, or nothing where the host has yet to answer for it. */
function settledBy({ row, answer, refused }: Posting): DictationRecord | null {
  if (refused) return stored({ ...row, rejected: true })
  // A host that takes the words and answers with nothing has not told us when it heard them; the row
  // stays unposted so the next open asks again, which the host's own idempotence makes harmless.
  if (!answer) return null
  // Its answer is the row as it stored it: its clock heard the take, and its `at` is the one it kept —
  // a device clock in the future is clamped to that, so the sheet shows a time that can exist. Its
  // words as heard are the host's to keep too: one it answered without is one it dropped, so the
  // mirror heals to that rather than holding a text its host has nowhere (ADR 0062).
  const settled = stored({ ...row, posted: true, at: answer.at, seenAt: answer.seenAt })
  if (answer.heard === undefined) delete settled.heard
  else settled.heard = answer.heard
  return settled
}

/** Writes what a batch of hand-overs came to in one write, and answers what each row became. */
async function applyPostings(postings: Posting[]) {
  const changed = postings.map(settledBy).filter((row): row is DictationRecord => row !== null)
  if (changed.length) await db.dictationLog.bulkPut(changed)
  return new Map(changed.map((row) => [row.id, row]))
}

/** How many takes are handed over at once: an upgrade's backlog is a queue, not a burst. */
const POSTS_AT_ONCE = 4

/** Answers what each take came to, a batch at a time. */
async function postAll(config: HermesConfig, rows: DictationRecord[]): Promise<Posting[]> {
  const postings: Posting[] = []
  for (let index = 0; index < rows.length; index += POSTS_AT_ONCE) {
    const batch = rows.slice(index, index + POSTS_AT_ONCE)
    postings.push(
      ...(await Promise.all(
        batch.map(async (row) => {
          try {
            return await post(config, row)
          } catch (error) {
            quietly("Writing a dictation to its host")(error)
            return { row, answer: null, refused: false }
          }
        }),
      )),
    )
  }
  return postings
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
 *
 * `heard` is the same take as the host's speech model wrote it, before Cleanup: the words that landed
 * and the words as heard are both kept, since what the cleanup did is worth seeing (ADR 0062).
 */
export async function writeDictation(config: HermesConfig, text: string, ms: number, heard?: string) {
  const trimmed = text.trim()
  if (!trimmed) return
  const row = entryOf(connectionKey(config), trimmed, ms, heard)
  await db.dictationLog.put(row).catch(quietly("Logging a dictation on this device"))
  void post(config, row)
    .then((posting) => applyPostings([posting]))
    .catch(quietly("Writing a dictation to its host"))
}

/**
 * Every page a host holds, newest first, walked back until it has answered for as many takes as its own
 * count claims.
 */
async function readAll(config: HermesConfig, want: number) {
  const rows: HostDictation[] = []
  let before: number | null = null
  let beforeId: string | null = null
  for (;;) {
    const page = await getDictations(
      config,
      before,
      beforeId,
      WALK_PAGE,
      AbortSignal.timeout(READ_TIMEOUT_MS),
    )
    if (!page.length) return rows
    rows.push(...page)
    // The host's own count is the bound, not a page that came back short: a host that caps a page
    // lower than `WALK_PAGE` answers short on every one, and stopping there would repair a mirror
    // from its newest page alone.
    if (rows.length >= want) return rows
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

/** What a host's own rows leave in the mirror: its bot, its clock, and held by it. */
function fromHost(
  mirror: DictationRecord[],
  rows: HostDictation[],
  key: string,
): DictationRecord[] {
  return toUpsert(mirror, rows).map((row) =>
    stored({
      ...row,
      connection: key,
      posted: true,
    }),
  )
}

/**
 * Whether an upgrade's backlog can settle without being posted: a mirror that already says what its
 * host says owes it nothing, so a whole log costs one write where the host holds its takes already.
 * Only rows the previous build wrote can settle this way — a row this build wrote and never
 * confirmed is one the host may still be missing.
 */
async function settleLegacy(
  key: string,
  rows: DictationRecord[],
  mirror: DictationRecord[],
  host: HostAnswer,
) {
  if (!rows.every((row) => row.posted === undefined)) return false
  if (!agrees(fingerprintOf(mirror, host.clearedAt), host)) return false
  await markPosted(rows)
  await cacheStats(key, host)
  return true
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
  const unconfirmed = mirror.filter((row) => !row.posted && !row.rejected)

  let host = await askStats(config, key)
  if (!host) return

  if (unconfirmed.length) {
    if (await settleLegacy(key, unconfirmed, mirror, host)) return
    const postings = await postAll(config, unconfirmed)
    const changed = await applyPostings(postings)
    mirror = mirror.map((row) => changed.get(row.id) ?? row)
    // The totals the host gave before the takes it just took are stale by exactly that many, so they
    // are asked for again rather than cached as a count its own log no longer matches.
    if (postings.some((posting) => posting.answer)) host = (await askStats(config, key)) ?? host
  }

  const gone = clearedAway(mirror, host.clearedAt)
  if (gone.length) {
    await db.dictationLog.bulkDelete(gone.map((row) => row.id))
    const dropped = new Set(gone.map((row) => row.id))
    mirror = mirror.filter((row) => !dropped.has(row.id))
  }

  // One it never confirmed would hold the fingerprint apart and walk the whole log on every open.
  const synced = mirror.filter((row) => row.posted)
  const print = fingerprintOf(synced, host.clearedAt)
  if (agrees(print, host)) {
    await cacheStats(key, host)
    return
  }

  // A page only closes a gap that starts at the newest row this device holds: a fresh mirror has
  // nothing to append to and a wider gap would never close, so both walk.
  const gap = host.count - print.count
  const appended = synced.length > 0 && gap > 0 && gap <= PAGE && host.oldest === print.oldest
  if (appended) {
    const page = await getDictations(config, null, null, PAGE, AbortSignal.timeout(READ_TIMEOUT_MS))
    const fresh = fromHost(mirror, page, key)
    if (fresh.length) await db.dictationLog.bulkPut(fresh)
  } else {
    const rows = await readAll(config, host.count)
    const have = new Set(rows.map((row) => row.id))
    // Rows go only off a read that agrees with the host's own count: one still arriving is not a
    // host that lost them, and deleting then would take a take both sides hold.
    const lost =
      rows.length === host.count
        ? synced.filter((row) => !have.has(row.id)).map((row) => row.id)
        : []
    if (lost.length) await db.dictationLog.bulkDelete(lost)
    const fresh = fromHost(mirror, rows, key)
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
  // Keyed by the host's id alone: a row another bot filed under it was not one this delete asked for.
  const row = await db.dictationLog.get(id)
  if (row && row.connection !== connectionKey(config)) return
  await db.dictationLog.delete(id)
}

/**
 * Takes every bot's log away: each host its own, this device the mirror and the totals with it. A
 * bot whose host refused keeps what this device holds, so a half-done clear cannot undo itself on
 * the next open.
 */
export async function clearDictationLog(profiles: Profile[]) {
  const refused: string[] = []
  const cleared: { key: string; totals?: HostDictationStats }[] = []
  await Promise.all(
    profiles.map(async (profile) => {
      const config = serverConfig(profile)
      try {
        const totals = await clearDictations(config, AbortSignal.timeout(WRITE_TIMEOUT_MS))
        cleared.push({ key: connectionKey(config), totals })
      } catch (error) {
        // An older plugin has no log, so there is nothing left on that host to keep.
        if (await lacksRoute(config, error, DICTATIONS))
          cleared.push({ key: connectionKey(config) })
        else refused.push(profile.name)
      }
    }),
  )
  await db.transaction("rw", [db.dictationLog, db.dictationStats], async () => {
    for (const { key, totals } of cleared) {
      await db.dictationLog.where("connection").equals(key).delete()
      // A clear answers with the totals it leaves behind, so they are kept rather than emptied: the
      // menu row and the stats card have their answer already, and no read is owed for it.
      if (totals) await cacheStats(key, totals)
      else await db.dictationStats.delete(key)
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
