import assert from "node:assert/strict"
import test from "node:test"

import { benchCandidates, scoreFor, scoreMapOf } from "../src/lib/model-match.ts"

// Rows shaped like the BenchLM payload: a modelKey and a score.
const ROWS = [
  { modelKey: "gpt-oss-20b", score: 18.17 },
  { modelKey: "gpt-oss-120b", score: 22.98 },
  { modelKey: "gemma-4-31b", score: 31.65 },
  { modelKey: "gemini-3-pro", score: 42.98 },
  { modelKey: "claude-opus-4-5", score: 40.33 },
  { modelKey: "claude-haiku-4-5", score: 16.77 },
  { modelKey: "mistral-large-3", score: 15.01 },
  { modelKey: "claude-sonnet-4-6", score: 44.68 },
  { modelKey: "deepseek-v4-pro-max", score: 70 },
]
const map = scoreMapOf(ROWS)

test("exact ids still score", () => {
  assert.equal(scoreFor(map, "gpt-oss-20b"), 18.17)
  assert.equal(scoreFor(map, "claude-sonnet-4.6"), 44.68)
})

test("a colon tag reaches its dashed BenchLM row", () => {
  assert.equal(scoreFor(map, "gpt-oss:20b"), 18.17)
  assert.equal(scoreFor(map, "gpt-oss:120b"), 22.98)
  assert.equal(scoreFor(map, "mistral-large-3:675b"), 15.01)
})

test("gemma4 is BenchLM's gemma-4", () => {
  assert.equal(scoreFor(map, "gemma4:31b"), 31.65)
})

test("a bare family reaches the row BenchLM keys by its creator", () => {
  const m = scoreMapOf([{ modelKey: "reflection-beam", score: 51.5 }])
  assert.equal(scoreFor(m, "beam"), 51.5)
  assert.equal(scoreFor(m, "ollama-cloud/beam"), 51.5)
})

test("a row's own key is not aliased again", () => {
  assert.deepEqual(benchCandidates("reflection-beam"), ["reflection-beam"])
})

test("a family alias never shadows an exact row", () => {
  const m = scoreMapOf([
    { modelKey: "reflection-beam", score: 2 },
    { modelKey: "beam", score: 1 },
  ])
  assert.equal(scoreFor(m, "beam"), 1)
  assert.equal(scoreFor(m, "ollama-cloud/beam"), 1)
})

test("dated snapshots map onto their base model", () => {
  assert.equal(scoreFor(map, "claude-opus-4-5-20251101"), 40.33)
  assert.equal(scoreFor(map, "claude-haiku-4-5-20251001"), 16.77)
})

test("-preview and -free are dropped before matching", () => {
  assert.equal(scoreFor(map, "gemini-3-pro-preview"), 42.98)
})

test("ids BenchLM does not rank stay unmatched", () => {
  assert.equal(scoreFor(map, "deepseek-v4-flash"), undefined)
  assert.equal(scoreFor(map, "gpt-4o"), undefined)
  assert.equal(scoreFor(map, "claude-sonnet-4.5"), undefined)
})

test("a fuzzy neighbour never claims another model's row", () => {
  // claude-sonnet-4.5 must not resolve to claude-sonnet-4-6.
  assert.equal(scoreFor(map, "claude-sonnet-4.5"), undefined)
})

test("an exact row beats a derived one across rows", () => {
  // The stripped key `foo` from the `foo-preview` row must not shadow the real `foo` row.
  const m = scoreMapOf([
    { modelKey: "foo-preview", score: 1 },
    { modelKey: "foo", score: 2 },
  ])
  assert.equal(scoreFor(m, "foo"), 2)
})

test("benchCandidates puts the id as-is first", () => {
  assert.equal(benchCandidates("gpt-oss:20b")[0], "gpt-oss:20b")
})
