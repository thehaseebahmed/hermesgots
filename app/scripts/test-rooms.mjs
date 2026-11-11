/**
 * The Host a room's members resolve against: a profile name is unique on its Host, not across a
 * device's bots, so a room on one gateway never answers with another gateway's bot of the same name.
 * The Host there is the address a bot answers at, since one gateway linked twice holds one roster.
 */
import assert from "node:assert/strict"
import test from "node:test"

import {
  botsByProfile,
  roomRowOf,
  roomAnswerer,
  roomAnswerers,
  roomFaces,
  roomLastLine,
} from "../src/lib/rooms.ts"

/** A bot of one Host, reached by the link `hostId` names. */
const bot = (id, profile, baseUrl, hostId) => ({
  id,
  name: id,
  baseUrl,
  apiKey: `key-${id}`,
  hermesProfile: profile,
  botId: id,
  hostId,
})

const roomOf = (...profiles) => ({
  id: "room-1",
  name: "A room",
  members: profiles.map((profile, at) => ({
    memberId: `m${at}`,
    profile,
    handle: profile,
    displayName: profile,
  })),
})

test("two links of one gateway resolve each other's members", () => {
  const ada = bot("ada", "ada", "http://one.test/v1", "link-1")
  const bo = bot("bo", "bo", "http://one.test/v1", "link-2")
  assert.deepEqual([...botsByProfile([ada, bo], ada).keys()].sort(), ["ada", "bo"])
  assert.deepEqual(
    roomFaces(roomOf("ada", "bo"), [ada, bo], ada),
    { shown: ["ada", "bo"], more: 0 },
    "a room seated across two links of its Host draws both faces",
  )
})

test("another gateway's bot of the same name is not the room's", () => {
  const here = bot("ada", "ada", "http://one.test/v1", "link-1")
  const away = bot("ada-away", "ada", "http://two.test/v1", "link-2")
  assert.equal(
    botsByProfile([away, here], here).get("ada")?.id,
    "ada",
    "the member resolves to the bot on the room's own Host",
  )
  assert.equal(
    botsByProfile([away, here], here).size,
    1,
    "and the other Host's bot of that name is not a member of this room",
  )
})

test("a room with no anchor narrows to nothing", () => {
  const ada = bot("ada", "ada", "http://one.test/v1", "link-1")
  assert.equal(botsByProfile([ada], undefined).get("ada")?.id, "ada")
})

test("a room of two bots lists in both their lists, in member order", () => {
  const ada = bot("ada", "ada", "http://one.test/v1", "link-1")
  const bo = bot("bo", "bo", "http://one.test/v1", "link-2")
  const room = roomOf("bo", "ada")
  const bots = new Map([
    [ada.id, ada],
    [bo.id, bo],
  ])
  const ids = (listed) => listed.map((one) => one.id)
  assert.deepEqual(
    ids(roomAnswerers(room, bots, ada)),
    ["bo", "ada"],
    "both bots the roster seats name the room, in the order it seats them",
  )
  const boOff = new Map([
    [ada.id, ada],
    [bo.id, { ...bo, disabled: true }],
  ])
  assert.deepEqual(
    ids(roomAnswerers(room, boOff, ada)),
    ["ada"],
    "a member whose bot is turned off is left out",
  )
  assert.equal(
    roomAnswerer(room, boOff, ada)?.id,
    "ada",
    "and the one answerer is still the first bot that answers",
  )
})

test("a room's row says the last message a member sent, and never the reader's own", () => {
  // The Host's log is ordered by one sequence number, and the page this device holds is a slice of it.
  const page = [
    { seq: 1, kind: "message.user", text: "Who takes the release?" },
    { seq: 3, kind: "message.member", text: "I'll take the API.\nAnd the routes." },
    { seq: 2, kind: "message.member", text: "I can, but @user has to pick." },
    { seq: 4, kind: "turn.started", text: "" },
  ]
  assert.equal(
    roomLastLine(page),
    "I'll take the API. And the routes.",
    "the newest member's words, on one line",
  )
  assert.equal(
    roomLastLine([page[0], page[3]]),
    undefined,
    "a room only the reader has spoken in says nothing, and its row names its members instead",
  )
  assert.equal(
    roomLastLine([]),
    undefined,
    "and a room this device has not read says nothing at all",
  )
  // A reply whose text the Host trimmed still has nothing to say, so the row does not draw an empty line.
  assert.equal(roomLastLine([{ seq: 5, kind: "message.member", text: "  " }]), undefined)
})

test("a room with nothing said and no members line says so on its row", () => {
  const row = roomRowOf({ id: "r", title: "A room", updatedAt: 1 }, { shown: [], more: 0 })
  assert.equal(row.line, "Nothing said in this room yet")
})
