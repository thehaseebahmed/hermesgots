// Checks which chat model ids from models.dev have no BenchLM score.
// Plain string matching only (no AI). Exits 1 when an unmatched id is not
// listed in scripts/benchlm-known-gaps.json, so new mismatches get fixed.
//
// Usage: node scripts/check-benchlm-matches.mjs [--report <path>]

import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"

import { scoreFor, scoreMapOf } from "../src/lib/model-match.ts"

const PROVIDERS = ["github-copilot", "ollama-cloud", "anthropic", "deepseek", "xai"]
// The candidate deploy carries main's proxy, which serves the overall surface the app's picker
// reads; the apex host still answers with the older coding payload until that deploy is promoted.
const BENCHLM_URL = "https://candidate--hermesgots.netlify.app/.netlify/functions/benchlm"
const MODELS_DEV_URL = "https://models.dev/api.json"
const here = path.dirname(fileURLToPath(import.meta.url))
const GAPS_PATH = path.join(here, "benchlm-known-gaps.json")

// Chat models produce text and nothing else (drops image, audio, video, embedding).
export function isChatModel(model) {
  const output = model?.modalities?.output
  if (!Array.isArray(output) || !output.includes("text")) return false
  return !output.some((m) => ["image", "audio", "video", "embedding"].includes(m))
}

// Returns the chat model ids of the given providers, keyed by provider.
export function chatIdsByProvider(catalog, providers = PROVIDERS) {
  const out = {}
  for (const provider of providers) {
    const models = catalog?.[provider]?.models ?? {}
    out[provider] = Object.values(models)
      .filter(isChatModel)
      .map((m) => m.id)
      .sort()
  }
  return out
}

// Splits ids into matched and unmatched using the same rules as the picker.
export function classify(ids, map) {
  const matched = []
  const unmatched = []
  for (const id of ids) {
    const score = scoreFor(map, id)
    if (score === undefined) unmatched.push(id)
    else matched.push(id)
  }
  return { matched, unmatched }
}

// Known gaps: { "<provider>/<id>": "one-line reason" }.
export function unlistedGaps(unmatchedByProvider, gaps) {
  const failing = []
  for (const [provider, ids] of Object.entries(unmatchedByProvider)) {
    for (const id of ids) {
      if (!(`${provider}/${id}` in gaps)) failing.push(`${provider}/${id}`)
    }
  }
  return failing
}

async function main() {
  const reportIdx = process.argv.indexOf("--report")
  const reportPath = reportIdx > -1 ? process.argv[reportIdx + 1] : null

  const [catalogRes, benchRes] = await Promise.all([fetch(MODELS_DEV_URL), fetch(BENCHLM_URL)])
  if (!catalogRes.ok) throw new Error(`models.dev returned ${catalogRes.status}`)
  if (!benchRes.ok) throw new Error(`BenchLM proxy returned ${benchRes.status}`)
  const catalog = await catalogRes.json()
  const bench = await benchRes.json()
  const rows = bench.items ?? []

  const ids = chatIdsByProvider(catalog)
  const gaps = JSON.parse(readFileSync(GAPS_PATH, "utf8"))
  // One map for every provider, built from the payload's own rows, so a row carrying only a slug or
  // a name scores here exactly as it does in the app.
  const map = scoreMapOf(rows)

  const unmatchedByProvider = {}
  const summary = {}
  for (const provider of PROVIDERS) {
    const { matched, unmatched } = classify(ids[provider], map)
    summary[provider] = { checked: ids[provider].length, matched: matched.length, unmatched: unmatched.length }
    unmatchedByProvider[provider] = unmatched
  }

  const failing = unlistedGaps(unmatchedByProvider, gaps)
  const report = {
    checkedAt: new Date().toISOString(),
    benchlmDataAsOf: bench.dataAsOf ?? null,
    summary,
    unmatched: unmatchedByProvider,
    failing,
  }
  if (reportPath) writeFileSync(reportPath, JSON.stringify(report, null, 2))

  console.log(JSON.stringify(summary, null, 2))
  if (failing.length) {
    console.error(`${failing.length} unmatched id(s) not in benchlm-known-gaps.json:`)
    for (const f of failing) console.error(`  ${f}`)
    process.exit(1)
  }
  console.log("All unmatched ids are listed as known gaps.")
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err)
    process.exit(2)
  })
}
