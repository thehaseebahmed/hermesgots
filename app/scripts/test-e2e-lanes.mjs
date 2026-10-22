// The parallel lane rule of the e2e CLI (`scripts/e2e/lanes.mjs`): a sweep split across lanes must
// cover every flow exactly once, in registry order within a lane, with lanes that have nothing to
// run staying empty rather than stealing another lane's flows.
import assert from "node:assert/strict"
import test from "node:test"

import { laneOf, MAX_LANES } from "./e2e/lanes.mjs"

const names = ["a", "b", "c", "d", "e", "f", "g"]

test("lanes cover every name exactly once, keeping registry order within a lane", () => {
  for (const lanes of [1, 2, 3, 7, 8]) {
    const covered = []
    for (let lane = 0; lane < lanes; lane++) covered.push(...laneOf(names, lanes, lane))
    assert.deepEqual([...covered].sort(), [...names].sort(), `${lanes} lanes cover the sweep exactly once`)
    for (let lane = 0; lane < lanes; lane++) {
      const slice = laneOf(names, lanes, lane)
      assert.deepEqual(
        slice,
        names.filter((_, index) => index % lanes === lane),
        `lane ${lane} of ${lanes} keeps registry order`,
      )
    }
  }
})

test("a sweep longer than a lane's share still splits evenly by one", () => {
  const swept = Array.from({ length: 60 }, (_, index) => `flow-${index}`)
  const sizes = Array.from({ length: 3 }, (_, lane) => laneOf(swept, 3, lane).length)
  assert.deepEqual(sizes, [20, 20, 20])
})

test("more lanes than names leaves the tail lanes empty", () => {
  assert.deepEqual(laneOf(["a", "b"], 4, 2), [])
  assert.deepEqual(laneOf(["a", "b"], 4, 3), [])
  assert.deepEqual(laneOf(["a", "b"], 4, 1), ["b"])
})

test("a lane count or index that can't exist is refused", () => {
  assert.throws(() => laneOf(names, 0, 0), /lanes is 1-8/)
  assert.throws(() => laneOf(names, MAX_LANES + 1, 0), /lanes is 1-8/)
  assert.throws(() => laneOf(names, 2.5, 0), /lanes is 1-8/)
  assert.throws(() => laneOf(names, 2, 2), /lane is 0-1/)
  assert.throws(() => laneOf(names, 2, -1), /lane is 0-1/)
})
