import assert from "node:assert/strict"
import test from "node:test"

import { chatOwner } from "../src/lib/chat-owner.ts"

const on = { id: "on", name: "On" }
const off = { ...on, id: "off", disabled: true }
const bots = new Map([
  [on.id, on],
  [off.id, off],
])

const cases = [
  {
    name: "a chat of a bot this device has",
    row: { profileId: on.id },
    bot: on,
    listed: true,
  },
  {
    name: "a chat of a bot turned off in Gots",
    row: { profileId: off.id },
    bot: off,
    listed: false,
  },
  {
    name: "a chat of a bot this device has no record of",
    row: { profileId: "gone" },
    bot: undefined,
    listed: true,
  },
  {
    name: "a project session",
    row: { profileId: on.id, projectId: "project-1" },
    bot: on,
    listed: false,
  },
]

test("a row lists unless it is a project session or its bot is turned off", () => {
  for (const { name, row, bot, listed } of cases) {
    const owner = chatOwner(row, bots)
    assert.equal(owner.listed, listed, `${name}: listed`)
    assert.equal(owner.bot, bot, `${name}: bot`)
    assert.equal(owner.answerer, listed ? row.profileId : undefined, `${name}: answerer`)
  }
})

test("a screen that names no bots lists the row where its chat is a chat", () => {
  assert.deepEqual(chatOwner({ profileId: "gone" }), {
    bot: undefined,
    listed: true,
    answerer: "gone",
  })
  assert.equal(chatOwner({ profileId: "gone", projectId: "project-1" }).listed, false)
})
