/**
 * The Host a room's members resolve against: a profile name is unique on its Host, not across a
 * device's bots, so a room on one gateway never answers with another gateway's bot of the same name.
 * The Host there is the address a bot answers at, since one gateway linked twice holds one roster.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { botsByProfile, roomFaces } from "../src/lib/rooms.ts"

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
