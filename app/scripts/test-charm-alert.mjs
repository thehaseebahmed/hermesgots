/**
 * The charm's alert, phone side: the id a bot is named by on the charm, which has to be the id a
 * push carries, since that is the id the charm matches an alert against.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { charmBotId } from "../src/lib/charm-alert.ts"

test("a bot's charm id is its registry id", () => {
  assert.equal(charmBotId("bot-1", "9f2c4a1b7d3e5f60"), "9f2c4a1b7d3e5f60")
})

test("a bot the registry does not hold keeps its own id", () => {
  assert.equal(charmBotId("bot-1"), "bot-1")
})

test("an empty id is treated as absent", () => {
  assert.equal(charmBotId("bot-1", ""), "bot-1")
})
