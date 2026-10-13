import { useLiveQuery } from "dexie-react-hooks"

import { db, type CodingRankings } from "@/lib/db"
import { isNative, SITE_URL } from "@/lib/native"
import type { ModelInfo } from "@/lib/hermes"

const RANKINGS_URL = `${isNative ? SITE_URL : ""}/.netlify/functions/benchlm`
const RANKINGS_ROW = "coding"
const TTL_MS = 24 * 60 * 60 * 1000

/** A row in BenchLM's coding rankings: a model's id and its BenchAlign score. */
interface RankingRow {
  model_id?: unknown
  name?: unknown
  score?: unknown
  rank?: unknown
}

/** The shape we expect from the BenchLM coding surface, validated before caching. */
interface RankingsPayload {
  rankings?: unknown
}

/** The cached payload must carry a rankings array to be useful. */
function isRankings(data: unknown): data is RankingsPayload {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return false
  const rankings = (data as Record<string, unknown>).rankings
  return Array.isArray(rankings)
}

/** Fetches the rankings from the Netlify proxy. */
async function fetchRankings(): Promise<unknown> {
  const response = await fetch(RANKINGS_URL)
  if (!response.ok) throw new Error(`BenchLM proxy responded ${response.status}`)
  const data: unknown = await response.json()
  if (!isRankings(data)) throw new Error("BenchLM returned an unexpected payload")
  return data
}

/** One shared background refresh at a time. */
let refreshing: Promise<void> | undefined

function refreshRankings(_row: CodingRankings) {
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
let coldFetch: Promise<unknown> | undefined

async function fetchAndCache(): Promise<unknown> {
  const data = await fetchRankings()
  await db.codingRankings.put({ id: RANKINGS_ROW, data, fetchedAt: Date.now() })
  return data
}

/** BenchLM's coding rankings, read from the device cache. */
async function loadRankings(): Promise<unknown> {
  const row = await db.codingRankings.get(RANKINGS_ROW)
  if (row) {
    if (Date.now() - row.fetchedAt >= TTL_MS) refreshRankings(row)
    return row.data
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
export function useCodingRankings() {
  const row = useLiveQuery(() => db.codingRankings.get(RANKINGS_ROW))
  return row?.data
}

/** `anthropic/Claude-Sonnet-4.5` and `claude-sonnet-4-5` should meet. */
const normalise = (id: string) => id.toLowerCase().replace(/\./g, "-")
const lastSegment = (id: string) => id.slice(id.lastIndexOf("/") + 1)

/** Extracts the score from a ranking row, guarding the payload's unconfirmed shape. */
function scoreOf(row: RankingRow | undefined): number | undefined {
  const score = row?.score
  return typeof score === "number" && Number.isFinite(score) ? score : undefined
}

/** Extracts a model id from a ranking row, guarding the payload's unconfirmed shape. */
function modelIdOf(row: RankingRow | undefined): string | undefined {
  const id = row?.model_id ?? row?.name
  return typeof id === "string" && id.trim() ? id.trim() : undefined
}

type ModelRef = Pick<ModelInfo, "provider" | "model">

/**
 * The model's BenchLM coding score, or undefined if it isn't ranked. The matching follows the
 * same normalise → exact → suffix order as `models.ts` so `anthropic/claude-sonnet-4-5` meets
 * `sonnet-4-5` under any provider.
 */
export function codingScoreOf(rankings: unknown, { model }: ModelRef): number | undefined {
  if (!model || !isRankings(rankings)) return undefined
  const rows = rankings.rankings as RankingRow[]
  const full = normalise(model)
  const short = lastSegment(full)
  // Exact match on the model id, then a normalised match, then a last-segment match.
  for (const row of rows) {
    const id = modelIdOf(row)
    if (id && normalise(id) === full) return scoreOf(row)
  }
  for (const row of rows) {
    const id = modelIdOf(row)
    if (id && lastSegment(normalise(id)) === short) return scoreOf(row)
  }
  return undefined
}