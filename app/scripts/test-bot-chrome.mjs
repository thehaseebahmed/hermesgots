import assert from "node:assert/strict"
import test from "node:test"

import { previewLine } from "../src/lib/bot-chrome.ts"

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

test("a bot with nothing said says whether its host is checking in, and nothing where it can't tell", () => {
  assert.equal(previewLine({ online: true }), "Online")
  assert.equal(previewLine({ online: false }), "Offline")
  assert.equal(previewLine({}), undefined, "and nothing at all where it can't tell")
})
