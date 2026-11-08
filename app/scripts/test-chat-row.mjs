import assert from "node:assert/strict"
import test from "node:test"

import { rowBot, rowDraws } from "../src/lib/chat-row.ts"

const bots = new Map([
  ["on", { id: "on" }],
  ["off", { id: "off", disabled: true }],
  ["keyless", { id: "keyless", apiKey: "" }],
])

const rows = ["on", "off", "keyless", "gone", ""].map((profileId) => ({ profileId }))

/** What the Recents filter asked before this rule moved: a row draws unless its bot is off. */
const drewBefore = (row, bots) => !bots.get(row.profileId)?.disabled

test("a row draws exactly as the chat list drew it before the rule moved", () => {
  for (const row of rows) {
    assert.equal(rowDraws(row, bots), drewBefore(row, bots), JSON.stringify(row.profileId))
  }
})

test("a bot turned off is the one thing that stops a row drawing", () => {
  assert.equal(rowDraws({ profileId: "on" }, bots), true)
  assert.equal(rowDraws({ profileId: "off" }, bots), false)
})

test("a row a bot can be called from still draws, a keyless bot's included", () => {
  assert.equal(rowDraws({ profileId: "keyless" }, bots), true)
})

test("a row draws with the bot this device holds, when it holds one", () => {
  assert.equal(rowBot({ profileId: "on" }, bots)?.id, "on")
  assert.equal(rowBot({ profileId: "gone" }, bots), undefined)
})
