/**
 * Mark as read, pressed in the Android tray: the presses the phone queued while the app was closed,
 * read into the marks this device keeps, and the hold that keeps a chat read through the activity its
 * notice reported until the chat's rows catch up.
 *
 * A press can be overtaken by a clock written after it — a catch-up floors a synced message's
 * `createdAt` forward, and the record's `updatedAt` moves when it syncs — so a press alone could leave
 * the dot standing. The hold is what a press covered, on the host's clock: a reply the host wrote
 * after it is news, and keeps its dot.
 */
import assert from "node:assert/strict"
import test from "node:test"

import {
  HOLD_KEEP,
  HOLD_MS,
  drainTrayReads,
  heldMark,
  holdsWith,
  latestReads,
} from "../src/lib/tray-reads.ts"

const NOW = 1_763_456_000_000

test("a mark pressed in the tray moves the chat's read mark on the next launch", async () => {
  const taken = []
  const marked = []
  await drainTrayReads(
    async () => {
      taken.push("take")
      return [{ chat: "chat-1", at: NOW - 60_000, through: NOW - 90_000 }]
    },
    (read) => marked.push(read),
  )
  assert.deepEqual(taken, ["take"], "the queue is asked for once")
  assert.deepEqual(marked, [{ chat: "chat-1", at: NOW - 60_000, through: NOW - 90_000 }])
})

test("a queue the phone can't hand over moves nothing", async () => {
  const marked = []
  await drainTrayReads(
    async () => {
      throw new Error("no plugin")
    },
    (read) => marked.push(read),
  )
  assert.deepEqual(marked, [])
})

test("the latest press per chat is kept, and a row that isn't one is dropped", () => {
  assert.deepEqual(
    latestReads([
      { chat: "chat-1", at: 10, through: 5 },
      { chat: "chat-1", at: 30 },
      { chat: "chat-1", at: 20, through: 8 },
      { chat: "chat-2", at: 40 },
      { chat: "", at: 50 },
      { chat: "chat-3", at: -1 },
      { chat: "chat-4", at: "50" },
      { chat: 42, at: 50 },
      { chat: "a b", at: 50 },
      null,
      "chat-5",
      { chat: "chat-6", at: 60, through: "soon" },
    ]),
    [
      { chat: "chat-1", at: 30, through: 8 },
      { chat: "chat-2", at: 40 },
      { chat: "chat-6", at: 60 },
    ],
  )
  assert.deepEqual(latestReads("not a list"), [])
  assert.deepEqual(latestReads(undefined), [])
})

test("a hold lasts a day, keeps the furthest moment, and is bounded", () => {
  const one = holdsWith({}, { chat: "chat-1", at: NOW, through: NOW - 10 }, NOW)
  assert.deepEqual(one["chat-1"], { through: NOW - 10, press: NOW, until: NOW + HOLD_MS })
  const again = holdsWith(one, { chat: "chat-1", at: NOW - 5, through: NOW - 20 }, NOW + 1)
  assert.equal(again["chat-1"].through, NOW - 10, "a hold never moves back")
  assert.equal(again["chat-1"].press, NOW)
  assert.deepEqual(
    Object.keys(holdsWith(one, { chat: "chat-2", at: NOW, through: NOW }, NOW + HOLD_MS + 1)),
    ["chat-2"],
    "a day-old hold is dropped",
  )
  let many = {}
  for (let index = 0; index < HOLD_KEEP + 3; index++)
    many = holdsWith(many, { chat: `chat-${index}`, at: NOW + index, through: NOW }, NOW + index)
  assert.equal(Object.keys(many).length, HOLD_KEEP)
  assert.equal("chat-0" in many, false, "the oldest holds go first")
})

test("a held chat is marked through its own clocks while its newest reply is one the notice covered", () => {
  const hold = { through: NOW, press: NOW + 5_000, until: NOW + HOLD_MS }
  // The reply the notice was about, synced after the press: its device clock is floored forward and
  // its record's moved, but the host wrote it before the moment the notice covered.
  assert.deepEqual(
    heldMark(hold, NOW + 9_000, {
      at: NOW + 8_000,
      updatedAt: NOW + 8_500,
      newest: { hermesAt: NOW - 1_000, createdAt: NOW + 8_000 },
    }),
    { mark: NOW + 8_500 },
  )
  assert.deepEqual(heldMark(hold, NOW + 9_000, { updatedAt: NOW + 7_000 }), { mark: NOW + 7_000 })
})

test("a reply newer than the notice keeps its dot, and the hold lets go", () => {
  const hold = { through: NOW, press: NOW + 5_000, until: NOW + HOLD_MS }
  assert.equal(
    heldMark(hold, NOW + 9_000, {
      at: NOW + 8_000,
      updatedAt: NOW + 8_500,
      newest: { hermesAt: NOW + 2_000, createdAt: NOW + 8_000 },
    }),
    "release",
  )
  // One this device wrote itself, with no host clock yet, is judged by the press on its own clock.
  assert.equal(
    heldMark(hold, NOW + 9_000, { at: NOW + 6_000, newest: { createdAt: NOW + 6_000 } }),
    "release",
  )
  assert.equal(
    heldMark(hold, NOW + HOLD_MS + 1, { updatedAt: NOW }),
    "release",
    "and a day ends it",
  )
})
