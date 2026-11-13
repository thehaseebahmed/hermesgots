/**
 * A pick whose list is settled and holds exactly one option applies it; every other state — still
 * reading, a read that failed, an empty list, a list of two — opens the sheet. The rule is held here
 * on its own, with no DOM and no host.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { pickStep } from "../src/lib/pick-one.ts"

const sonnet = { provider: "anthropic", model: "claude-sonnet-4.5" }
const gpt = { provider: "openai", model: "gpt-5" }

test("a list still reading opens the sheet", () => {
  assert.deepEqual(pickStep({ at: "reading" }), { act: "open" })
})

test("a read that failed opens the sheet", () => {
  assert.deepEqual(pickStep({ at: "failed" }), { act: "open" })
})

test("an empty list opens the sheet", () => {
  assert.deepEqual(pickStep({ at: "ready", options: [] }), { act: "open" })
})

test("a list of two opens the sheet", () => {
  assert.deepEqual(pickStep({ at: "ready", options: [sonnet, gpt] }), { act: "open" })
})

test("one option, with nothing said to be in force, is applied", () => {
  assert.deepEqual(pickStep({ at: "ready", options: [sonnet] }), { act: "apply", option: sonnet })
})

test("one option that is already in force is quiet", () => {
  assert.deepEqual(
    pickStep({ at: "ready", options: [sonnet] }, (option) => option.model === sonnet.model),
    { act: "quiet" },
  )
})

test("one option that is not in force is applied", () => {
  assert.deepEqual(
    pickStep({ at: "ready", options: [sonnet] }, (option) => option.model === gpt.model),
    { act: "apply", option: sonnet },
  )
})

test("a list of two is never asked what is in force", () => {
  let asked = 0
  pickStep({ at: "ready", options: [sonnet, gpt] }, () => {
    asked += 1
    return true
  })
  assert.equal(asked, 0, "no option is singled out, so nothing is compared")
})
