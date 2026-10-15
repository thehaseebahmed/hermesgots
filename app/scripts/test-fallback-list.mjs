import assert from "node:assert/strict"
import test from "node:test"

import { MAX_FALLBACKS, withFallback } from "../src/lib/fallback-list.ts"

const sonnet = { provider: "openrouter", model: "anthropic/claude-sonnet-4.5" }
const deepseek = { provider: "deepseek", model: "deepseek-v4-pro" }
const opus = { provider: "anthropic", model: "claude-opus-4-5" }

test("a bot takes two fallbacks", () => {
  assert.equal(MAX_FALLBACKS, 2)
})

test("an empty list takes the first pick", () => {
  assert.deepEqual(withFallback([], 0, sonnet), [sonnet])
})

test("a second pick goes after the first", () => {
  assert.deepEqual(withFallback([sonnet], 1, deepseek), [sonnet, deepseek])
})

test("a third pick is dropped, at whatever index it arrives", () => {
  const full = [sonnet, deepseek]
  assert.deepEqual(withFallback(full, 2, opus), full)
  assert.deepEqual(withFallback(full, 0, opus), [opus, deepseek])
  assert.deepEqual(withFallback(full, 1, opus), [sonnet, opus])
})

test("writing a slot replaces only that one", () => {
  assert.deepEqual(withFallback([sonnet, deepseek], 1, opus), [sonnet, opus])
})

test("writing undefined drops the slot", () => {
  assert.deepEqual(withFallback([sonnet, deepseek], 0, undefined), [deepseek])
  assert.deepEqual(withFallback([sonnet, deepseek], 1, undefined), [sonnet])
  assert.deepEqual(withFallback([sonnet], 0, undefined), [])
})

test("undefined on the add row adds nothing", () => {
  assert.deepEqual(withFallback([sonnet], 1, undefined), [sonnet])
  assert.deepEqual(withFallback([], 0, undefined), [])
})

test("an index outside the list leaves it as it was", () => {
  assert.deepEqual(withFallback([sonnet], 2, deepseek), [sonnet])
  assert.deepEqual(withFallback([sonnet], -1, deepseek), [sonnet])
})

test("a chain longer than the cap can still be trimmed or edited", () => {
  // A host can hold more than two (Hermes's own `fallback` command adds them), and the plugin lets
  // a shorter list through, so the rows must still be editable.
  const three = [sonnet, deepseek, opus]
  assert.deepEqual(withFallback(three, 0, undefined), [deepseek, opus])
  assert.deepEqual(withFallback(three, 2, undefined), [sonnet, deepseek])
  assert.deepEqual(withFallback(three, 1, sonnet), [sonnet, sonnet, opus])
})
