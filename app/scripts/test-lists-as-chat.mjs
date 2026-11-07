import assert from "node:assert/strict"
import test from "node:test"

import { listsAsChat, listsAsThread } from "../src/lib/lists-as-chat.ts"

const cases = [
  { name: "a plain chat", chat: {}, chat_: true, thread: true },
  { name: "a project session", chat: { projectId: "p" }, chat_: false, thread: false },
  { name: "Main", chat: { main: true }, chat_: true, thread: false },
  {
    name: "a project session flagged Main",
    chat: { projectId: "p", main: true },
    chat_: false,
    thread: false,
  },
  { name: "an empty project id is no project", chat: { projectId: "" }, chat_: true, thread: true },
  {
    name: "a discarded chat is still the chat list's to hide",
    chat: { discardedAt: 3 },
    chat_: true,
    thread: true,
  },
]

test("a project session and Main are not listed as threads", () => {
  for (const { name, chat, chat_, thread } of cases) {
    assert.equal(listsAsChat(chat), chat_, `${name}: listed as a chat`)
    assert.equal(listsAsThread(chat), thread, `${name}: listed as a thread`)
  }
})

test("a thread is always a chat", () => {
  for (const { chat } of cases) {
    if (listsAsThread(chat)) assert.ok(listsAsChat(chat))
  }
})
