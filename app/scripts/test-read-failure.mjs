import assert from "node:assert/strict"
import test from "node:test"

import { describeReadFailure, formatReadFailure } from "../src/lib/read-failure.ts"

const profile = {
  id: "bot-1",
  name: "Mainly",
  baseUrl: "https://secret-host.test/v1",
  apiKey: "sk-secret-key-123",
  model: "test/model",
  botId: "bot-1",
  pluginVersion: "1.4.0",
  createdAt: 1,
  updatedAt: 1,
}

const chat = {
  id: "c-1",
  profileId: "bot-1",
  title: "A session",
  hermesSessionId: "h-1",
  createdAt: 1,
  updatedAt: 2,
  changedAt: 2,
}

const AT = 1_700_000_000_000
const built = (error) =>
  describeReadFailure({ at: AT, error, chat, profile, stored: 0, endpoint: "/messages" })

test("a read that answered with no rows says so, and names the chat it was for", () => {
  const one = built(undefined)
  assert.equal(one.read.ended, "empty")
  assert.equal(one.read.message, undefined)
  assert.equal(one.read.stack, undefined)
  assert.equal(one.chat.id, "c-1")
  assert.equal(one.chat.session, "h-1")
  assert.equal(one.chat.stored, 0)
  assert.equal(one.bot.id, "bot-1")
  assert.equal(one.bot.pluginVersion, "1.4.0")
  assert.equal(one.at, new Date(AT).toISOString())
})

test("a host that refused the read names the status and code it refused with", () => {
  const error = Object.assign(new Error("no route"), {
    name: "HermesError",
    status: 404,
    code: "not_found",
  })
  const one = built(error)
  assert.equal(one.read.ended, "host")
  assert.equal(one.read.status, 404)
  assert.equal(one.read.code, "not_found")
  assert.equal(one.read.message, "no route")
  assert.match(one.read.stack, /no route/, "the stack is what a support thread reads")
})

test("a read that never landed is a network ending, not a host one", () => {
  const one = built(new TypeError("Failed to fetch"))
  assert.equal(one.read.ended, "network")
  assert.equal(one.read.status, undefined)
  assert.equal(one.read.name, "TypeError")
})

test("a chat holding only part of the transcript says so", () => {
  assert.equal(built(undefined).chat.older, undefined)
  const older = describeReadFailure({
    at: AT,
    chat: { ...chat, olderThan: true },
    profile,
    stored: 0,
    endpoint: "/messages",
  })
  assert.equal(older.chat.older, true)
})

test("neither the bot's address nor its key can ride along, however they got in", () => {
  const error = new Error(
    "GET https://secret-host.test/v1/api/sessions/h-1/messages with sk-secret-key-123 failed",
  )
  const text = formatReadFailure(built(error))
  assert.ok(!text.includes("secret-host.test"), "the address is scrubbed")
  assert.ok(!text.includes("sk-secret-key-123"), "the key is scrubbed")
  assert.ok(text.includes("<redacted>"), "and the paste shows it was")
})
