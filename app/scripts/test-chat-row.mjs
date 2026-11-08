import assert from "node:assert/strict"
import test from "node:test"

import { rowAnswers, rowBot, rowProfileId } from "../src/lib/chat-row.ts"

const bots = new Map([
  ["on", { id: "on" }],
  ["off", { id: "off", disabled: true }],
])

const cases = [
  { name: "a bot this device holds and the user has left on", row: { profileId: "on" }, bot: "on", answers: true },
  { name: "a bot the user has turned off", row: { profileId: "off" }, bot: "off", answers: false },
  { name: "a bot this device no longer holds", row: { profileId: "gone" }, bot: undefined, answers: true },
]

test("a row carries the profile id its record names", () => {
  for (const { name, row } of cases) assert.equal(rowProfileId(row), row.profileId, name)
})

test("a bot turned off is the one thing that stops a row drawing", () => {
  for (const { name, row, answers } of cases) assert.equal(rowAnswers(row, bots), answers, name)
})

test("a row draws with the bot this device holds, when it holds one", () => {
  for (const { name, row, bot } of cases) assert.equal(rowBot(row, bots)?.id, bot, name)
})
