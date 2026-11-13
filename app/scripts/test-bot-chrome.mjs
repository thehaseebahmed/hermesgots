import assert from "node:assert/strict"
import test from "node:test"

import { previewLine, stateLine } from "../src/lib/bot-chrome.ts"

test("the row previews what the bot's newest chat last said, else that chat's name", () => {
  assert.equal(
    previewLine({ line: "What was said", title: "A chat" }),
    "What was said",
    "the newest chat's own words",
  )
  assert.equal(
    previewLine({ title: "A chat" }),
    "A chat",
    "and its name where it holds no words yet",
  )
  assert.equal(previewLine({ line: "", title: "A chat" }), "A chat", "an empty line is nothing said")
})

test("a bot's row says its state: unread, online, offline, or nothing", () => {
  assert.equal(stateLine({ unread: 0, online: true }), "Online", "a host that is checking in")
  assert.equal(stateLine({ unread: 0, online: false }), "Offline", "a host that has gone stale")
  assert.equal(
    stateLine({ unread: 0 }),
    undefined,
    "a bot this device cannot answer for says nothing, and is never called Offline",
  )
  assert.equal(stateLine({ unread: 1, online: true }), "1 unread", "one conversation past the mark")
  assert.equal(stateLine({ unread: 12, online: false }), "12 unread", "and every one of them")
  assert.equal(
    stateLine({ unread: 2 }),
    "2 unread",
    "unread outranks the host's state, which this device may not know at all",
  )
})
