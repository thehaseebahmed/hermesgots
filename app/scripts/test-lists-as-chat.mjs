import assert from "node:assert/strict"
import test from "node:test"

import { listsAsChat } from "../src/lib/lists-as-chat.ts"

const cases = [
  { name: "a plain chat", chat: {}, listed: true },
  { name: "a project session", chat: { projectId: "p" }, listed: false },
  { name: "Main", chat: { main: true }, listed: true },
  {
    name: "a project session flagged Main",
    chat: { projectId: "p", main: true },
    listed: false,
  },
  { name: "an empty project id is no project", chat: { projectId: "" }, listed: true },
  {
    name: "a discarded chat is still the chat list's to hide",
    chat: { discardedAt: 3 },
    listed: true,
  },
  {
    name: "a room is its own row, not one of a bot's chats",
    chat: { room: { id: "room-1", members: [] } },
    listed: false,
  },
]

test("a project session is Code's, Main is the bot's own chat, and a room is its own row", () => {
  for (const { name, chat, listed } of cases) {
    assert.equal(listsAsChat(chat), listed, `${name}: listed as a chat`)
  }
})
