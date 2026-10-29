import assert from "node:assert/strict"
import test from "node:test"

import { measureTurn } from "../src/chat-next/stats.ts"

const timing = { startedAt: 1_000, firstTokenAt: 2_000 }

test("a reply with Hermes's count is measured by it, and how fast it wrote is the words over the time", () => {
  const stats = measureTurn({
    text: "x".repeat(400),
    toolsUsed: false,
    usage: { input_tokens: 900, output_tokens: 100 },
    timing,
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
  const stats = measureTurn({ text: "x".repeat(40), toolsUsed: false, timing, endedAt: 3_000 })
  assert.equal(stats.tokens, 10)
  assert.equal(stats.estimated, true)
})

test("a turn that ran calls, or never streamed, has no speed: its time is not the writing's", () => {
  const withCalls = measureTurn({ text: "hello", toolsUsed: true, timing, endedAt: 9_000 })
  assert.equal(withCalls.tokensPerSecond, undefined)
  assert.equal(withCalls.durationMs, 8_000)
  const silent = measureTurn({
    text: "hello",
    toolsUsed: false,
    timing: { startedAt: 1_000 },
    endedAt: 9_000,
  })
  assert.equal(silent.tokensPerSecond, undefined)
})
