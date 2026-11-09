import assert from "node:assert/strict"
import test from "node:test"

import { chatOwner } from "../src/lib/chat-owner.ts"

/** The address every bot below answers at, unless a case gives its own. */
const URL_ONE = "http://one.test/v1"

const on = { id: "on", name: "On", baseUrl: URL_ONE }
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

const coder = { id: "coder", name: "Coder", hermesProfile: "coder", baseUrl: URL_ONE }
const writer = {
  id: "writer",
  name: "Writer",
  hermesProfile: "writer",
  baseUrl: URL_ONE,
  disabled: true,
}
const roomBots = new Map([
  [on.id, on],
  [coder.id, coder],
  [writer.id, writer],
])
const room = (...profiles) => ({
  profileId: on.id,
  room: { id: "room-1", members: profiles.map((profile) => ({ profile, handle: profile })) },
})

test("a room lists, and the bot that answers for it is one of its members", () => {
  const owner = chatOwner(room("coder", "writer"), roomBots)
  assert.equal(owner.listed, true, "a room is nobody's thread and every chat list's row")
  assert.equal(owner.answerer, coder.id, "the first member this device has a bot for")
  assert.equal(owner.bot, coder)
})

test("a room's member turned off in Gots answers nothing, and the room still lists", () => {
  const owner = chatOwner(room("writer", "gone", "coder"), roomBots)
  assert.equal(owner.listed, true, "an unlinked or turned-off member still draws, read-only")
  assert.equal(owner.answerer, coder.id, "the turned-off member is skipped for the next one")
  assert.deepEqual(
    chatOwner(room("writer", "gone"), roomBots),
    { bot: undefined, listed: true, answerer: undefined },
    "a room whose members this device holds no bot for lists with no answerer",
  )
  assert.deepEqual(chatOwner(room("coder")), {
    bot: undefined,
    listed: true,
    answerer: undefined,
  })
})

test("a room's answerer is the Host's bot, never another server's of the same profile", () => {
  const here = { id: "here", name: "Coder here", hermesProfile: "coder", baseUrl: URL_ONE }
  const elsewhere = {
    id: "there",
    name: "Coder there",
    hermesProfile: "coder",
    baseUrl: "http://two.test/v1",
  }
  const carrier = { id: "carrier", name: "Carrier", hermesProfile: "default", baseUrl: URL_ONE }
  const both = new Map([
    [elsewhere.id, elsewhere],
    [here.id, here],
    [carrier.id, carrier],
  ])
  const row = { ...room("coder"), profileId: carrier.id }
  assert.equal(chatOwner(row, both).answerer, here.id, "the Host the record came on's own bot")
  assert.equal(
    // With the bot that carried the record gone there is no Host to scope by, so the room answers
    // with what this device has rather than with nothing.
    chatOwner(row, new Map([[elsewhere.id, elsewhere]])).answerer,
    elsewhere.id,
    "the roster alone decides it where no carrier names the Host",
  )
})
