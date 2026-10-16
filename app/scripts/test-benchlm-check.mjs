import assert from "node:assert/strict"
import test from "node:test"

import { chatIdsByProvider, classify, isChatModel, unlistedGaps } from "./check-benchlm-matches.mjs"

test("only text-output models count as chat", () => {
  assert.equal(isChatModel({ modalities: { output: ["text"] } }), true)
  assert.equal(isChatModel({ modalities: { output: ["text", "image"] } }), false)
  assert.equal(isChatModel({ modalities: { output: ["audio"] } }), false)
  assert.equal(isChatModel({ modalities: { output: [] } }), false)
  assert.equal(isChatModel({}), false)
})

test("chat ids are collected per provider", () => {
  const catalog = {
    anthropic: { models: { a: { id: "claude-x", modalities: { output: ["text"] } }, b: { id: "img", modalities: { output: ["image"] } } } },
  }
  assert.deepEqual(chatIdsByProvider(catalog, ["anthropic", "xai"]), { anthropic: ["claude-x"], xai: [] })
})

test("classify splits matched and unmatched ids", () => {
  const rows = [{ modelKey: "gpt-oss-20b", score: 18.17 }]
  assert.deepEqual(classify(["gpt-oss:20b", "unknown-model"], rows), {
    matched: ["gpt-oss:20b"],
    unmatched: ["unknown-model"],
  })
})

test("an unmatched id fails unless it is a listed gap", () => {
  const gaps = { "xai/grok-4.7": "no row" }
  assert.deepEqual(unlistedGaps({ xai: ["grok-4.7", "grok-5"] }, gaps), ["xai/grok-5"])
  assert.deepEqual(unlistedGaps({ xai: ["grok-4.7"] }, gaps), [])
})
