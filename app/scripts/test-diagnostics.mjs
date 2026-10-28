import assert from "node:assert/strict"
import test from "node:test"

import { diagBot, diagChat, diagResume, formatDiagnostics } from "../src/lib/diagnostics.ts"

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
  const built = diagChat(
    chat("c1", 1_000, { main: true, moves: [{}], olderThan: { id: 4, offset: 2 } }),
    {
      user: 3,
      assistant: 2,
    },
  )
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
  const main = diagChat(chat("main-bot-1", 1_000, { main: true }))
  const chats = [diagChat(chat("t1", 2_000))]
  const built = diagBot({
    profile,
    host: {
      configured: true,
      pluginVersion: null,
      plugin: "0.99.0",
      features: ["triage", "moves"],
      lastThread: "t1",
      lastStored: "t1",
    },
    chats,
    main,
    threads: 1,
  })
  assert.equal(built.main?.id, "main-bot-1", "Main is named as its own field")
  assert.equal(built.threads, 1, "the thread count is what the reader counted")
  assert.equal(built.lastThread, "t1", "the pane's answer rides")
  assert.equal(built.lastStored, "t1", "and so does what storage holds")
  assert.deepEqual(
    built.chats.map((one) => one.id),
    ["t1"],
    "the threads list holds what the reader read, without Main",
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
  const built = diagBot({
    profile: unconfigured,
    host: {
      configured: false,
      pluginVersion: null,
      plugin: null,
      features: null,
      lastThread: null,
      lastStored: null,
    },
    chats: [diagChat(chat("t1", 2_000))],
    main: null,
    threads: 1,
  })
  assert.equal(built.main, null, "no Main row reads as null")
  assert.equal(built.configured, false, "nothing was asked of a bot with no server and key")
  assert.equal(built.plugin, null, "an absent answer reads as null, not as a missing field")
  assert.equal(built.lastThread, null)
  assert.equal(built.disabled, undefined, "a switch that is off rides as no field")
})

test("a bot whose own reads failed says so rather than claiming emptiness", () => {
  const built = diagBot({
    profile,
    host: {
      configured: true,
      pluginVersion: null,
      plugin: null,
      features: null,
      lastThread: null,
      lastStored: null,
    },
    chats: [],
    main: null,
    threads: 0,
    unread: true,
  })
  assert.equal(built.unread, true, "an unread bot is marked, not mistaken for a fresh one")
  assert.deepEqual(built.chats, [])
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
  chatNext: false,
  bots: [],
})

test("the resume block names stages and offsets, and nothing can ride along", () => {
  const clean = diagResume({
    at: 1_000,
    started: 10,
    stages: { "sync-start": [400, Number.NaN, "private thoughts"], "sync-end": [900] },
    requests: { "chats-merge-end": 2, "runs-live-end": "key-one" },
  })
  assert.equal(clean.at, new Date(1_000).toISOString(), "the return is dated")
  assert.deepEqual(clean.stages["sync-start"], [400], "non-numbers are dropped field by field")
  assert.deepEqual(clean.stages["sync-end"], [900])
  assert.equal(clean.requests["chats-merge-end"], 2)
  assert.equal(
    clean.requests["runs-live-end"],
    undefined,
    "a count that isn't a count claims nothing",
  )

  const poisoned = diagResume({
    at: "secret-host.test",
    started: 10,
    stages: {
      "https://secret-host.test/v1": [1],
      "a chat titled private thoughts": [2],
      "sync-start": [3, { leaked: "key-one" }],
    },
    requests: { "https://secret-host.test/v1": 4, "sync-start": 5 },
  })
  assert.equal(poisoned.at, undefined, "a clock that isn't a clock never dates the dump")
  assert.deepEqual(Object.keys(poisoned.stages), ["sync-start"], "only stages the trace can name")
  assert.deepEqual(poisoned.stages["sync-start"], [3], "and only the numbers among their offsets")
  assert.deepEqual(poisoned.requests, { "sync-start": 5 }, "the rest of the stage names never ride")

  const text = formatDiagnostics({ ...device(), resume: poisoned })
  assert.ok(!text.includes("secret-host"), "the address is never in the dump")
  assert.equal(
    diagResume({ at: 1e300, started: 0, stages: {}, requests: {} }).at,
    undefined,
    "a clock no date can hold never dates it",
  )
})
