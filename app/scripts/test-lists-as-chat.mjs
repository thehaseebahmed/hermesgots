import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { listsAsChat, listsAsThread } from "../src/lib/lists-as-chat.ts"

const cases = [
  { name: "a plain chat", chat: {}, asChat: true, asThread: true },
  { name: "a project session", chat: { projectId: "p" }, asChat: false, asThread: false },
  { name: "Main", chat: { main: true }, asChat: true, asThread: false },
  {
    name: "a project session flagged Main",
    chat: { projectId: "p", main: true },
    asChat: false,
    asThread: false,
  },
  {
    name: "an empty project id is no project",
    chat: { projectId: "" },
    asChat: true,
    asThread: true,
  },
  {
    name: "a discarded chat is still the chat list's to hide",
    chat: { discardedAt: 3 },
    asChat: true,
    asThread: true,
  },
]

test("a project session and Main are not listed as threads", () => {
  for (const { name, chat, asChat, asThread } of cases) {
    assert.equal(listsAsChat(chat), asChat, `${name}: listed as a chat`)
    assert.equal(listsAsThread(chat), asThread, `${name}: listed as a thread`)
  }
})

test("a thread is always a chat", () => {
  for (const { chat } of cases) {
    if (listsAsThread(chat)) assert.ok(listsAsChat(chat))
  }
})

const shared = JSON.parse(
  readFileSync(new URL("../../plugin/tests/thread-rule-cases.json", import.meta.url), "utf8"),
)

test("listsAsThread follows the table the plugin's is_plain_thread is held to", () => {
  for (const { name, chat, app } of shared.cases) {
    assert.equal(listsAsThread(chat), app, name)
  }
})
