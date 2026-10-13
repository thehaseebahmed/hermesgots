import { useLiveQuery } from "dexie-react-hooks"

import { db } from "@/lib/db"
import type { ModelInfo } from "@/lib/hermes"
import { isNative, SITE_URL } from "@/lib/native"
import { lastSegment, normalise } from "@/lib/models"

const RANKINGS_URL = `${isNative ? SITE_URL : ""}/.netlify/functions/benchlm`
const RANKINGS_ROW = "coding"
const TTL_MS = 24 * 60 * 60 * 1000

/** A row in BenchLM's coding rankings: a model's key/slug and its BenchAlign score. */
interface RankingRow {
  modelKey?: unknown
  slug?: unknown
  name?: unknown
  score?: unknown
}

/** The shape we expect from the BenchLM coding surface, validated before caching. */
export interface RankingsPayload {
  items?: unknown
}

/** The cached payload must carry an items array to be useful. */
function isRankings(data: unknown): data is RankingsPayload {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return false
  const items = (data as Record<string, unknown>).items
  return Array.isArray(items)
}

/** Fetches the rankings from the Netlify proxy. */
async function fetchRankings(): Promise<RankingsPayload> {
  const response = await fetch(RANKINGS_URL)
  if (!response.ok) throw new Error(`BenchLM proxy responded ${response.status}`)
  const data: unknown = await response.json()
  if (!isRankings(data)) throw new Error("BenchLM returned an unexpected payload")
  return data
}

/** One shared background refresh at a time. */
let refreshing: Promise<void> | undefined

function refreshRankings() {
  refreshing ??= (async () => {
    try {
      const data = await fetchRankings()
      await db.codingRankings.put({ id: RANKINGS_ROW, data, fetchedAt: Date.now() })
    } catch {
      // The stale row keeps serving; the next load past the TTL tries again.
    } finally {
      refreshing = undefined
    }
  })()
}

/** One shared cold fetch, reset on failure so the next lookup retries. */
let coldFetch: Promise<RankingsPayload> | undefined

async function fetchAndCache(): Promise<RankingsPayload> {
  const data = await fetchRankings()
  await db.codingRankings.put({ id: RANKINGS_ROW, data, fetchedAt: Date.now() })
  return data
}

/** BenchLM's coding rankings, read from the device cache. */
async function loadRankings(): Promise<RankingsPayload> {
  const row = await db.codingRankings.get(RANKINGS_ROW)
  if (row) {
    if (Date.now() - row.fetchedAt >= TTL_MS) refreshRankings()
    return row.data as RankingsPayload
  }
  if (!coldFetch) {
    coldFetch = fetchAndCache().catch((error: unknown) => {
      coldFetch = undefined
      throw error
    })
  }
  return coldFetch
}

/** Warms the cache when the app opens, beside the models.dev catalog. */
export function warmRankings() {
  void loadRankings().catch(() => {})
}

/** The cached rankings payload, live: the model sheet renders scores from this. */
export function useCodingRankings(): RankingsPayload | undefined {
  const row = useLiveQuery(() => db.codingRankings.get(RANKINGS_ROW))
  return row?.data as RankingsPayload | undefined
}

/** Extracts the score from a ranking row, guarding the payload shape. */
function scoreOf(row: RankingRow | undefined): number | undefined {
  const score = row?.score
  return typeof score === "number" && Number.isFinite(score) ? score : undefined
}

/** Extracts a model id from a ranking row: modelKey, then slug, then name. */
function modelIdOf(row: RankingRow | undefined): string | undefined {
  const id = row?.modelKey ?? row?.slug ?? row?.name
  return typeof id === "string" && id.trim() ? id.trim() : undefined
}

type ModelRef = Pick<ModelInfo, "provider" | "model">

// Pre-normalised score lookup, built once per payload so repeated calls during search typing
// are O(1) — mirrors the WeakMap cache in `modelFacts`.
const scoreCache = new WeakMap<RankingsPayload, Map<string, number | undefined>>()

function buildScoreMap(rows: RankingRow[]): Map<string, number | undefined> {
  const map = new Map<string, number | undefined>()
  for (const row of rows) {
    const id = modelIdOf(row)
    if (!id) continue
    const full = normalise(id)
    const short = lastSegment(full)
    const score = scoreOf(row)
    // Full match takes priority; only store short if no full entry exists yet.
    if (!map.has(full)) map.set(full, score)
    if (!map.has(short)) map.set(short, score)
  }
  return map
}

/**
 * The model's BenchLM coding score, or undefined if it isn't ranked. The matching follows the
 * same normalise → exact → suffix order as `models.ts` so `anthropic/claude-sonnet-4-5` meets
 * `sonnet-4-5` under any provider.
 */
export function codingScoreOf(
  rankings: RankingsPayload | undefined,
  { model }: ModelRef,
): number | undefined {
  if (!model || !rankings) return undefined
  let map = scoreCache.get(rankings)
  if (!map) {
    if (!isRankings(rankings)) return undefined
    map = buildScoreMap(rankings.items as RankingRow[])
    scoreCache.set(rankings, map)
  }
  const full = normalise(model)
  const short = lastSegment(full)
  return map.get(full) ?? map.get(short)
}