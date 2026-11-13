import type { ModelInfo } from "./hermes.ts"
import { scoreFor, scoreMapOf } from "./model-match.ts"
import { RANKINGS, type RankingsData } from "./rankings-data.ts"

export type { RankingRow, RankingsData } from "./rankings-data.ts"

/**
 * The scores, keyed the way a lookup asks for them, built once: the payload is a constant of this
 * build, so there is nothing here that a refresh could change under it.
 */
const SCORES = scoreMapOf(RANKINGS.items)

/**
 * The BenchLM overall surface the picker scores from. It ships with the build — the committed copy
 * `scripts/build-rankings.mjs` writes, refreshed by the weekly BenchLM job — so a score costs no
 * fetch, no cache row, no freshness window and no key, and a build, a typecheck or a test needs
 * neither the network nor `BENCHLM_DATA_KEY`. It answers synchronously, since there is nothing to
 * wait for, so the picker draws its scores on the first paint; the name it is called by is kept, so
 * the sheet that reads it needs no change.
 */
export function useOverallRankings(): RankingsData {
  return RANKINGS
}

type ModelRef = Pick<ModelInfo, "provider" | "model">

/**
 * The model's BenchLM overall score, or undefined if it isn't ranked. Matching goes through the
 * candidate spellings in `model-match.ts`, so `anthropic/claude-sonnet-4-5` meets `sonnet-4-5`.
 */
export function overallScoreOf({ model }: ModelRef): number | undefined {
  if (!model) return undefined
  return scoreFor(SCORES, model)
}
