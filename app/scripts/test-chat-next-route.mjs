/** Which chats chat-next takes: every chat whose bot it can call. No switch is consulted. */
import assert from "node:assert/strict"
import test from "node:test"

import { callable, opensOnChatNext } from "../src/chat-next/route.ts"

const bot = { baseUrl: "https://hermes.test/v1", apiKey: "k" }
const chat = {}

test("a plain chat with a callable bot opens on chat-next", () => {
  assert.equal(opensOnChatNext(chat, bot), true)
})

test("a project session opens on chat-next too, which posts its workspace before every turn", () => {
  assert.equal(opensOnChatNext({ projectId: "p1" }, bot), true)
})

test("a bot's Main opens on chat-next too, which triages its messages before they send", () => {
  assert.equal(opensOnChatNext({ main: true }, bot), true)
})

test("callable is one address and one key: a server to call, and a key to call it with", () => {
  assert.equal(callable(bot), true)
  assert.equal(
    callable({ baseUrl: "  ", apiKey: "k" }),
    false,
    "an address that is only blanks is no address",
  )
  assert.equal(callable({ baseUrl: "https://hermes.test/v1", apiKey: "" }), false, "and no key")
  assert.equal(callable(null), false)
  assert.equal(callable(undefined), false)
})

test("a new chat with no record yet, or one whose bot can't be called, stays", () => {
  assert.equal(opensOnChatNext(null, bot), false)
  assert.equal(opensOnChatNext(undefined, bot), false)
  assert.equal(opensOnChatNext(chat, { ...bot, apiKey: "" }), false)
  assert.equal(opensOnChatNext(chat, { ...bot, baseUrl: "  " }), false)
  assert.equal(opensOnChatNext(chat, undefined), false)
})
