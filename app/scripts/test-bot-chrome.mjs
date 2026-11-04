import assert from "node:assert/strict"
import test from "node:test"

import { previewLine, threadCount, threadsLine } from "../src/lib/bot-chrome.ts"

const thread = (main = false) => ({ chat: { main: main || undefined } })

test("a bot's thread count leaves Main out", () => {
  assert.equal(threadCount(undefined), 0, "nothing read yet")
  assert.equal(threadCount([]), 0)
  assert.equal(threadCount([thread(true)]), 0, "Main is the bot, not a thread of it")
  assert.equal(threadCount([thread(true), thread(), thread(), thread()]), 3)
})

test("the line under Main's title counts the bot's threads, and says so when there are none", () => {
  assert.equal(threadsLine(0), "No threads")
  assert.equal(threadsLine(1), "1 thread")
  assert.equal(threadsLine(2), "2 threads")
  assert.equal(threadsLine(11), "11 threads")
})

test("the row previews Main's words, else the newest thread's, else its name, else its host's state", () => {
  assert.equal(
    previewLine({ main: true, line: "What was said in Main", latest: "A newer thread" }),
    "What was said in Main",
  )
  assert.equal(
    previewLine({ main: true, line: undefined, thread: "What the thread said", latest: "A newer thread" }),
    "What the thread said",
    "nothing said in Main yet, so the newest thread's own words stand in",
  )
  assert.equal(
    previewLine({ main: true, line: undefined, latest: "A newer thread" }),
    "A newer thread",
    "and its name where the thread holds no words",
  )
  assert.equal(
    previewLine({ main: true, line: undefined, thread: undefined, latest: "Main" }),
    "Main",
    "an empty Main with nothing under it yet still names the row",
  )
  assert.equal(previewLine({ main: false, latest: "Its newest thread" }), "Its newest thread")
  assert.equal(previewLine({ main: false, online: true }), "Online")
  assert.equal(previewLine({ main: true, line: undefined, online: false }), "Offline")
  assert.equal(previewLine({ main: false }), undefined, "and nothing at all where it can't tell")
})
