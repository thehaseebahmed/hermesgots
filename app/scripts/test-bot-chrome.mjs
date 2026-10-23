import assert from "node:assert/strict"
import test from "node:test"

import { mainTitle, previewLine, threadCount, threadsLine } from "../src/lib/bot-chrome.ts"

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

test("Main's title is the bot's own name, never the stored \"Main\"", () => {
  assert.equal(mainTitle("Chrome", "Main"), "Chrome", "the bot's name wins over the record's")
  assert.equal(mainTitle("Chrome", "A renamed chat"), "Chrome")
  assert.equal(mainTitle(undefined, "Main"), "Main", "no name yet keeps what the record holds")
  assert.equal(mainTitle("", "Main"), "Main")
  assert.equal(mainTitle(undefined, undefined), "", "nothing to draw yet")
})

test("the row previews Main's latest line, not its newest thread's title", () => {
  assert.equal(
    previewLine({ main: true, line: "What was said in Main", latest: "A newer thread" }),
    "What was said in Main",
  )
  assert.equal(
    previewLine({ main: true, line: undefined, latest: "A newer thread" }),
    "No threads yet",
  )
  assert.equal(previewLine({ main: false, latest: "Its newest thread" }), "Its newest thread")
  assert.equal(previewLine({ main: false }), "No threads yet")
})
