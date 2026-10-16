import { useLiveQuery } from "dexie-react-hooks"

import { db } from "@/lib/db"
import type { ModelInfo } from "@/lib/hermes"
import { isNative, SITE_URL } from "@/lib/native"
import { scoreFor, scoreMapOf, type ScoredRow } from "@/lib/model-match"

const RANKINGS_URL = `${isNative ? SITE_URL : ""}/.netlify/functions/benchlm`
const RANKINGS_ROW = "overall"
const TTL_MS = 24 * 60 * 60 * 1000

/** The shape we expect from the BenchLM overall surface, validated before caching. */
export interface RankingsPayload {
  items?: unknown
}

/** The cached payload must carry an items array to be useful. */
export function isRankings(data: unknown): data is RankingsPayload {
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
      await db.overallRankings.put({ id: RANKINGS_ROW, data, fetchedAt: Date.now() })
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
  await db.overallRankings.put({ id: RANKINGS_ROW, data, fetchedAt: Date.now() })
  return data
}

/** BenchLM's overall rankings, read from the device cache. */
async function loadRankings(): Promise<RankingsPayload> {
  const row = await db.overallRankings.get(RANKINGS_ROW)
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
export function useOverallRankings(): RankingsPayload | undefined {
  const row = useLiveQuery(() => db.overallRankings.get(RANKINGS_ROW))
  return row?.data as RankingsPayload | undefined
}

type ModelRef = Pick<ModelInfo, "provider" | "model">

// Pre-normalised score lookup, built once per payload so repeated calls during search typing
// are O(1) — mirrors the WeakMap cache in `modelFacts`.
const scoreCache = new WeakMap<RankingsPayload, Map<string, number | undefined>>()

/**
 * The model's BenchLM overall score, or undefined if it isn't ranked. Matching goes through the
 * candidate spellings in `model-match.ts`, so `anthropic/claude-sonnet-4-5` meets `sonnet-4-5`.
 */
export function overallScoreOf(
  rankings: RankingsPayload | undefined,
  { model }: ModelRef,
): number | undefined {
  if (!model || !rankings) return undefined
  let map = scoreCache.get(rankings)
  if (!map) {
    if (!isRankings(rankings)) return undefined
    map = scoreMapOf(rankings.items as ScoredRow[])
    scoreCache.set(rankings, map)
  }
  return scoreFor(map, model)
}