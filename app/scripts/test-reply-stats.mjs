import assert from "node:assert/strict"
import test from "node:test"

import { measureReply } from "../src/lib/reply-stats.ts"

const base = { toolsUsed: false, startedAt: 1_000, firstTokenAt: 2_000 }

test("a reply with Hermes's count is measured by it, and how fast it wrote is the words over the time", () => {
  const stats = measureReply({
    ...base,
    text: "x".repeat(400),
    counted: 100,
    promptTokens: 900,
    endedAt: 6_000,
  })
  assert.deepEqual(stats, {
    tokens: 100,
    estimated: false,
    tokensPerSecond: 25,
    durationMs: 5_000,
    promptTokens: 900,
    toolsUsed: false,
  })
})

test("without a count the tokens are estimated from the words", () => {
  const stats = measureReply({ ...base, text: "x".repeat(40), endedAt: 3_000 })
  assert.equal(stats.tokens, 10)
  assert.equal(stats.estimated, true)
})

test("a turn that ran calls, never streamed or was picked up midway has no speed", () => {
  const ended = { text: "hello", endedAt: 9_000 }
  const withCalls = measureReply({ ...base, ...ended, toolsUsed: true })
  assert.equal(withCalls.tokensPerSecond, undefined)
  assert.equal(withCalls.durationMs, 8_000)
  assert.equal(measureReply({ ...base, ...ended, firstTokenAt: null }).tokensPerSecond, undefined)
  assert.equal(measureReply({ ...base, ...ended, resumed: true }).tokensPerSecond, undefined)
})
