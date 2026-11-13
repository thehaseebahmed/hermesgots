import type { ModelInfo } from "@/lib/hermes"
import { scoreFor, scoreMapOf, type ScoredRow } from "@/lib/model-match"
import { RANKINGS } from "@/lib/rankings-data"

/**
 * The BenchLM overall surface the picker scores from. It ships with the build — the committed copy
 * `scripts/build-rankings.mjs` writes, refreshed by the weekly BenchLM job — so a score costs no
 * fetch, no cache row, no freshness window and no key, and a build, a typecheck or a test needs
 * neither the network nor `BENCHLM_DATA_KEY`.
 */
export interface RankingsPayload {
  items?: unknown
}

/** The payload must carry an items array to be worth scoring from. */
function isRankings(data: unknown): data is RankingsPayload {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return false
  const items = (data as Record<string, unknown>).items
  return Array.isArray(items)
}

/**
 * The shipped rankings: the one payload a model's score comes from. It answers synchronously, since
 * there is nothing to wait for, so the picker draws its scores on the first paint; the name it is
 * called by is kept, so the sheet that reads it needs no change.
 */
export function useOverallRankings(): RankingsPayload {
  return RANKINGS
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