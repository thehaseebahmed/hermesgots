/** Which chats chat-next takes while its switch is on: plain chats with a bot it can call. */
import assert from "node:assert/strict"
import test from "node:test"

import { opensOnChatNext } from "../src/chat-next/route.ts"

const bot = { baseUrl: "https://hermes.test/v1", apiKey: "k" }
const chat = {}

test("a plain chat with a callable bot opens on chat-next while the switch is on", () => {
  assert.equal(opensOnChatNext(true, chat, bot), true)
})

test("with the switch off, every chat stays where it was", () => {
  assert.equal(opensOnChatNext(false, chat, bot), false)
})

test("a project session opens on chat-next too, which posts its workspace before every turn", () => {
  assert.equal(opensOnChatNext(true, { projectId: "p1" }, bot), true)
})

test("a bot's Main stays, since its messages are triaged before they send", () => {
  assert.equal(opensOnChatNext(true, { main: true }, bot), false)
})

test("a chat not started, or one whose bot can't be called, stays", () => {
  assert.equal(opensOnChatNext(true, null, bot), false)
  assert.equal(opensOnChatNext(true, undefined, bot), false)
  assert.equal(opensOnChatNext(true, chat, { ...bot, apiKey: "" }), false)
  assert.equal(opensOnChatNext(true, chat, { ...bot, baseUrl: "  " }), false)
  assert.equal(opensOnChatNext(true, chat, undefined), false)
})
