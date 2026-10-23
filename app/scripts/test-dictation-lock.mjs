import assert from "node:assert/strict"
import test from "node:test"

import { holdTake, releaseTake, takeRunning } from "../src/lib/dictation-lock.ts"

const profile = (name) => `http://${name}.test/v1|key`

test("a profile's second take is refused while the first holds it", () => {
  const one = profile("held")
  const held = holdTake(one)
  assert.ok(held, "the first take holds the profile")
  assert.equal(takeRunning(one), true)
  assert.equal(holdTake(one), null, "the second is refused before it asks for the mic")
})

test("a take is per profile: another bot's microphone is its own", () => {
  const one = profile("one")
  const other = profile("other")
  assert.ok(holdTake(one))
  assert.ok(holdTake(other), "another profile may hear its own take")
  assert.equal(takeRunning(one), true)
  assert.equal(takeRunning(other), true)
})

test("the take that holds it gives it back, and the next one may start", () => {
  const one = profile("given-back")
  const held = holdTake(one)
  releaseTake(one, held)
  assert.equal(takeRunning(one), false)
  const next = holdTake(one)
  assert.ok(next, "the profile is free again")
  releaseTake(one, next)
})

test("a take that ends after a newer one began cannot let go of it", () => {
  const one = profile("late")
  const first = holdTake(one)
  releaseTake(one, first)
  const second = holdTake(one)
  releaseTake(one, first)
  assert.equal(takeRunning(one), true, "the newer take still holds the profile")
  releaseTake(one, second)
  assert.equal(takeRunning(one), false)
})

test("a restored take, which never asked for the mic, releases nothing", () => {
  const one = profile("restored")
  const held = holdTake(one)
  releaseTake(one, null)
  assert.equal(takeRunning(one), true, "a take with no token is not the holder")
  releaseTake(one, held)
})
