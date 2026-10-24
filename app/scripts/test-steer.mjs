/**
 * How a message sent while a reply runs goes, as one rule: a steer is text, so only a message
 * carrying nothing but files can be one. The composer and the send path both ask it.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { canSteer, midReply } from "../src/lib/steer.ts"

const note = { id: "f1", name: "notes.txt", type: "text/plain", size: 12, image: false }
const photo = { id: "f2", name: "cat.png", type: "image/png", size: 12, image: true }
const asked = { steer: true }
const askedToQueue = { steer: false }

test("a message of plain text steers when the send asks to", () => {
  assert.equal(midReply([], asked), "steer")
})

test("a message carrying a file steers: the file reaches the model as marker text", () => {
  assert.equal(canSteer([note]), true)
  assert.equal(midReply([note], asked), "steer")
})

test("a message carrying a photo queues: a steer can't carry what the model reads", () => {
  assert.equal(canSteer([photo]), false)
  assert.equal(midReply([photo], asked), "queue")
})

test("a message carrying a file and a photo queues", () => {
  assert.equal(midReply([note, photo], asked), "queue")
})

test("a send that didn't ask to steer queues, whatever it carries", () => {
  assert.equal(midReply([], askedToQueue), "queue")
  assert.equal(midReply([note], askedToQueue), "queue")
})

test("a reply the host won't take queues, whatever it carries", () => {
  assert.equal(midReply([], { steer: true, hostTakesIt: false }), "queue")
  assert.equal(midReply([note], { steer: true, hostTakesIt: false }), "queue")
})
