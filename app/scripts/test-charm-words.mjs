/**
 * The Firmware row's words, on their own: a version that cannot be compared says so rather than
 * "up to date", and a link that never opened is not a charm that had nothing to say.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { firmwareOffers, firmwareWords } from "../src/lib/charm-words.ts"
import { compareVersions } from "../src/lib/version-compare.ts"

test("a version that isn't three plain numbers can't be compared, so nothing is offered", () => {
  assert.equal(compareVersions("0.1.0", "0.2.0"), -1)
  assert.equal(compareVersions("0.9.0", "0.10.0"), -1, "compared as numbers, not text")
  assert.equal(compareVersions("0.2.0", "0.2.0"), 0)
  // A prerelease and a fourth part are builds nobody's publish wrote: no comparison is made.
  assert.equal(compareVersions("0.2.0-rc1", "0.2.0"), null)
  assert.equal(compareVersions("0.1.0.9", "0.1.0"), null)

  assert.equal(firmwareOffers({ running: "0.2.0-rc1", published: "0.2.0", answered: true }), false)
  assert.equal(
    firmwareWords({ running: "0.2.0-rc1", published: "0.2.0", answered: true }),
    "Charm 0.2.0-rc1 · can't tell if 0.2.0 is newer",
  )
  assert.equal(
    firmwareWords({ running: "0.1.0", published: "0.1.0.9", answered: true }),
    "Charm 0.1.0 · can't tell if 0.1.0.9 is newer",
  )
})

test("a link that never opened is not a charm that had nothing to say", () => {
  assert.equal(
    firmwareWords({ running: undefined, published: "0.2.0", answered: true, reachFailed: true }),
    "0.2.0 published · couldn't reach the charm",
  )
  assert.equal(
    firmwareWords({ running: undefined, published: "0.2.0", answered: true }),
    "0.2.0 published · the charm didn't say",
    "not read yet is still its own answer",
  )
})
