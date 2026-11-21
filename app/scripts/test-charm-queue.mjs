/**
 * The charm's radio holds one connection, so every caller of it takes a turn: a second caller
 * waits for the first to finish rather than connecting over it, and one caller's failure does not
 * wedge the queue for the next.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { oneAtATime } from "../src/lib/charm-queue.ts"

test("a second link waits for the first to close", async () => {
  const order = []
  let release
  const first = oneAtATime(async () => {
    order.push("first start")
    await new Promise((done) => (release = done))
    order.push("first end")
  })
  const second = oneAtATime(async () => {
    order.push("second")
  })
  // Let both callers reach the queue: only the first may have started.
  await new Promise((done) => setTimeout(done, 0))
  assert.deepEqual(order, ["first start"], "the second caller waits its turn")
  release()
  await Promise.all([first, second])
  assert.deepEqual(order, ["first start", "first end", "second"])
})

test("a caller that fails does not hold the queue", async () => {
  await assert.rejects(
    oneAtATime(async () => {
      throw new Error("the charm went out of reach")
    }),
    /out of reach/,
  )
  let ran = false
  await oneAtATime(async () => {
    ran = true
  })
  assert.equal(ran, true, "the next caller still takes its turn")
})
