/**
 * A room's three writes, from the app's side: a create, a rename and a disband each answer the room's
 * own chat-list record, and the row is written by the one writer the merge uses too (ADR 0123).
 *
 * The fake below is the plugin's route, not the Host: it answers what `plugin/rooms.py` answers — the
 * record entry, `{at, value}` or `{at, deleted}` — so what these tests drive is the client's parse, the
 * model's ids and the writer, end to end.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { db, writeRoomRow, type Profile } from "@/lib/db"
import { roomSeats } from "@/lib/rooms"
import { disbandRoomNow, renameRoomTo, startRoom } from "@/lib/room-writes"
import { randomId } from "@/lib/utils"
import { botProfile, json, settle } from "./component-kit.tsx"

const HOST = "http://writes.test/v1"
const CODER = "bot-coder"
const WRITER = "bot-writer"
const AT_CREATED = 1_760_000_000_000
const AT_RENAMED = 1_760_000_050_000
const AT_GONE = 1_760_000_100_000

const bots: Profile[] = [
  botProfile("writes", { id: CODER, name: "Coder", baseUrl: HOST, hermesProfile: "coder" }),
  botProfile("writes", {
    id: WRITER,
    name: "Writer",
    baseUrl: HOST,
    hermesProfile: "writer",
    botId: WRITER,
  }),
]

/** Every write the client made, so a retry can be shown to carry the same id. */
const sent: { path: string; method?: string; body: Record<string, unknown> }[] = []

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input))
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
  if (init?.method !== "POST") return json({}, 404)
  sent.push({ path: url.pathname, method: init?.method, body })
  if (url.pathname.endsWith("/disband"))
    return json({ object: "gots.room.record", at: AT_GONE, deleted: true })
  if (url.pathname.endsWith("/rooms"))
    return json({
      object: "gots.room.record",
      at: AT_CREATED,
      value: {
        title: body.name,
        createdAt: AT_CREATED,
        updatedAt: AT_CREATED,
        room: { id: body.room_id, members: body.members },
      },
    })
  // A rename: the Host names the room, and says nothing about a roster this device already has.
  return json({
    object: "gots.room.record",
    at: AT_RENAMED,
    value: { title: body.name, updatedAt: AT_RENAMED },
  })
}) as typeof fetch

async function fresh() {
  sent.length = 0
  await db.profiles.clear()
  await db.profiles.bulkPut(bots)
  await db.conversations.clear()
  await db.messages.clear()
  await db.roomLog.clear()
  await db.tombstones.clear()
  await settle()
}

test("a create's answer is written as the room's row, and a retry is the same room", async () => {
  await fresh()
  const room = { roomId: randomId(), name: "Planning", members: roomSeats(bots) }

  await startRoom(bots[0], room)
  await settle()

  const [posted] = sent
  assert.equal(posted.method, "POST")
  assert.ok(posted.path.endsWith("/api/plugins/gots/rooms"), `the create reaches the plugin: ${posted.path}`)
  assert.equal(posted.body.room_id, room.roomId, "the room's id is the app's")
  assert.deepEqual(
    (posted.body.members as { memberId?: string }[]).map((one) => one.memberId),
    room.members.map((one) => one.memberId),
    "each seat's id is the app's too",
  )
  assert.equal(
    (posted.body.members as { profile?: string }[])[0].profile,
    "coder",
    "and its profile is the one it answers under",
  )

  const row = await db.conversations.get(room.roomId)
  assert.ok(row?.room, "the room is a row on this device")
  assert.equal(row.title, "Planning")
  assert.equal(row.changedAt, AT_CREATED, "the row's clock is the Host's")
  assert.equal(row.profileId, CODER)
  assert.deepEqual(
    row.room?.members.map((one) => one.handle),
    ["coder", "writer"],
    "the roster the Host answered is what the row carries",
  )

  // A retry after a dropped answer is the same room, not a second one.
  await startRoom(bots[0], room)
  await settle()
  assert.equal(sent[1].body.room_id, room.roomId, "a retry carries the id the first attempt minted")
  assert.equal((await db.conversations.where("id").equals(room.roomId).count()), 1)
})

test("a rename takes the Host's name and keeps the roster this device holds", async () => {
  await fresh()
  const room = { roomId: randomId(), name: "Planning", members: roomSeats(bots) }
  await startRoom(bots[0], room)
  await settle()

  await renameRoomTo(bots[0], room.roomId, "Planning 2", randomId())
  await settle()

  const renaming = sent[1]
  assert.ok(renaming.path.endsWith(`/rooms/${room.roomId}`))
  assert.equal(renaming.body.name, "Planning 2")
  assert.equal(typeof renaming.body.event_id, "string")

  const row = await db.conversations.get(room.roomId)
  assert.equal(row?.title, "Planning 2", "the row wears the name the Host answered")
  assert.equal(row?.changedAt, AT_RENAMED)
  assert.deepEqual(
    row?.room?.members.map((one) => one.profile),
    ["coder", "writer"],
    "an answer that names no roster leaves this device's roster alone",
  )
})

test("a disband's answer takes the row and its page, and writes no chat tombstone", async () => {
  await fresh()
  const room = { roomId: randomId(), name: "Planning", members: roomSeats(bots) }
  await startRoom(bots[0], room)
  await db.roomLog.put({
    roomId: room.roomId,
    seq: 1,
    eventId: "e1",
    kind: "message.user",
    text: "Hello",
  })
  await settle()

  await disbandRoomNow(bots[0], room.roomId, randomId())
  await settle()

  assert.ok(sent[1].path.endsWith(`/rooms/${room.roomId}/disband`))
  assert.equal(typeof sent[1].body.cancel_id, "string", "the stop carries an id of its own")
  assert.equal(await db.conversations.get(room.roomId), undefined, "the row goes")
  assert.equal(
    await db.roomLog.where("roomId").equals(room.roomId).count(),
    0,
    "and so does the page of the log this device held",
  )
  assert.equal(
    await db.tombstones.get(`chat:${room.roomId}`),
    undefined,
    "a room is never carried as a chat, so nothing tombstones one",
  )
})

test("a record that names no roster keeps the one this device holds", async () => {
  await fresh()
  const room = { roomId: randomId(), name: "Planning", members: roomSeats(bots) }
  await startRoom(bots[0], room)
  await settle()

  // A Host list answer that names no members is not an empty room: the merge keeps the seats, or the
  // room loses the bot that answers for it (ADR 0115).
  await writeRoomRow(
    room.roomId,
    { at: AT_CREATED + 5_000, value: { title: "Planning", room: { id: room.roomId, members: [] } } },
    bots[0].id,
  )
  await settle()

  const row = await db.conversations.get(room.roomId)
  assert.deepEqual(
    row?.room?.members.map((one) => one.profile),
    ["coder", "writer"],
    "the roster survives a record that says nothing about it",
  )
})

test("a record that names an empty roster still makes a room this device has none of", async () => {
  await fresh()
  const id = randomId()
  await writeRoomRow(id, { at: AT_CREATED, value: { title: "Fresh", room: { id, members: [] } } }, bots[0].id)
  await settle()
  const row = await db.conversations.get(id)
  assert.ok(row?.room, "the row is a room's, even with no seats this device can reach")
  assert.deepEqual(row?.room?.members, [])
})
