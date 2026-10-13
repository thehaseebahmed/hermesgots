import assert from "node:assert/strict"
import test from "node:test"

import { MODEL_SORTS, sortByFacts } from "../src/components/chat/model-sort.ts"

const models = ["expensive-big", "cheap-small", "mid", "no-pricing", "totally-unknown"]

// Facts straight off a table — the context/cost/benchlm picks `modelFacts` makes over a catalog.
const FACTS = {
  "expensive-big": { context: 2_000_000, cost: 100, benchlm: 72 },
  "cheap-small": { context: 128_000, cost: 0.9, benchlm: 45 },
  mid: { context: 1_000_000, cost: 30, benchlm: 87 },
  "no-pricing": { context: 500_000 },
  // totally-unknown lists nothing at all
}
const facts = (m) => FACTS[m] ?? {}

test("name sort is A to Z", () => {
  assert.deepEqual(sortByFacts("name", facts, models), [
    "cheap-small",
    "expensive-big",
    "mid",
    "no-pricing",
    "totally-unknown",
  ])
})

test("price sort is cheapest first, unpriced models keep A to Z after", () => {
  assert.deepEqual(sortByFacts("price", facts, models), [
    "cheap-small",
    "mid",
    "expensive-big",
    "no-pricing",
    "totally-unknown",
  ])
})

test("context sort is largest first, models without a window keep A to Z after", () => {
  assert.deepEqual(sortByFacts("context", facts, models), [
    "expensive-big",
    "mid",
    "no-pricing",
    "cheap-small",
    "totally-unknown",
  ])
})

test("benchlm sort is highest score first, unscored models keep A to Z after", () => {
  assert.deepEqual(sortByFacts("benchlm", facts, models), [
    "mid",
    "expensive-big",
    "cheap-small",
    "no-pricing",
    "totally-unknown",
  ])
})

test("an empty list stays empty", () => {
  assert.deepEqual(sortByFacts("price", facts, []), [])
})

test("sort menu labels", () => {
  assert.deepEqual(Object.values(MODEL_SORTS), ["A to Z", "Price", "Context", "BenchLM Score"])
})
