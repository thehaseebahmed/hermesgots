import assert from "node:assert/strict"
import test from "node:test"

import { rowBot, rowOwner } from "../src/lib/chat-row.ts"

const bots = new Map([
  ["on", { id: "on" }],
  ["off", { id: "off", disabled: true }],
])

test("a row belongs to the bot its record names", () => {
  assert.equal(rowOwner({ profileId: "on" }), "on")
})

test("a bot this device holds and the user has left on answers for its row", () => {
  assert.equal(rowBot({ profileId: "on" }, bots)?.id, "on")
})

test("a row whose bot is turned off answers nothing", () => {
  assert.equal(rowBot({ profileId: "off" }, bots), undefined)
})

test("a row whose bot this device no longer holds answers nothing", () => {
  assert.equal(rowBot({ profileId: "gone" }, bots), undefined)
})

test("an empty profile id is no bot at all", () => {
  assert.equal(rowBot({ profileId: "" }, bots), undefined)
})
