import assert from "node:assert/strict"
import test from "node:test"

import { diagBot, diagChat, formatDiagnostics } from "../src/lib/diagnostics.ts"

const profile = {
  id: "bot-1",
  name: "Mainly",
  baseUrl: "https://secret-host.test/v1",
  apiKey: "key-one",
  model: "test/model",
  botId: "bot-1",
  createdAt: 1,
  updatedAt: 1,
}

const chat = (id, createdAt, extra = {}) => ({
  id,
  profileId: "bot-1",
  title: `Chat ${id}`,
  hermesSessionId: `memento-${id}`,
  createdAt,
  updatedAt: createdAt + 1,
  changedAt: createdAt + 2,
  ...extra,
})

test("a chat is named by its shape and clocks, never by what it holds", () => {
  const built = diagChat(chat("c1", 1_000, { main: true, moves: [{}], olderThan: { id: 4, offset: 2 } }), {
    user: 3,
    assistant: 2,
  })
  assert.equal(built.main, true)
  assert.equal(built.older, true)
  assert.equal(built.moves, 1, "the moves it carries are a count")
  assert.deepEqual(built.messages, { user: 3, assistant: 2 })
  assert.equal(built.createdAt, new Date(1_000).toISOString())
  const withNothing = diagChat(chat("c2", 1_000))
  assert.equal(withNothing.moves, undefined, "no moves ride as no field")
  assert.equal(withNothing.messages, undefined, "counts only where they were counted")
})

test("a bot's state separates Main from its threads and never carries its key or host", () => {
  const chats = [diagChat(chat("main-bot-1", 1_000, { main: true })), diagChat(chat("t1", 2_000))]
  const built = diagBot(profile, chats, { plugin: "0.99.0", features: ["triage", "moves"] })
  assert.equal(built.main?.id, "main-bot-1", "Main is named as its own field")
  assert.equal(built.threads, 1)
  assert.deepEqual(
    built.chats.map((one) => one.id),
    ["t1"],
    "the threads list holds the rest, oldest first",
  )
  assert.equal(built.configured, true)
  assert.equal(built.plugin, "0.99.0")
  assert.deepEqual(built.features, ["triage", "moves"])
  const text = formatDiagnostics({ ...device(), bots: [built] })
  assert.ok(!text.includes("key-one"), "the key is never in the dump")
  assert.ok(!text.includes("secret-host"), "the server address is never in the dump")
})

test("a bot without a Main, or an answer, still reads", () => {
  const blank = ""
  const unconfigured = { ...profile, baseUrl: blank }
  delete unconfigured.apiKey
  const built = diagBot(unconfigured, [diagChat(chat("t1", 2_000))], {
    plugin: null,
    features: null,
    lastThread: null,
  })
  assert.equal(built.main, undefined)
  assert.equal(built.configured, false, "no server and key means nothing could be asked")
  assert.equal(built.plugin, null, "an absent answer reads as null, not as a missing field")
  assert.equal(built.lastThread, null)
  assert.equal(built.disabled, undefined, "a switch that is off rides as no field")
})

const device = () => ({
  at: "2026-10-23T00:00:00.000Z",
  app: "1.0.0",
  minPlugin: "0.76.0",
  native: false,
  route: "/c/main-bot-1",
  schema: 25,
  developer: true,
  botThreads: true,
  bots: [],
})
