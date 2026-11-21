/**
 * The Firmware row's words, on their own: a version that cannot be compared says so rather than
 * "up to date", and a link that never opened is not a charm that had nothing to say.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { firmwareOffers, firmwareWords } from "../src/lib/charm-words.ts"
import { compareVersions } from "../src/lib/version-compare.ts"

test("a prerelease is ordered below its release, and a name that isn't a version can't be compared", () => {
  assert.equal(compareVersions("0.1.0", "0.2.0"), -1)
  assert.equal(compareVersions("0.9.0", "0.10.0"), -1, "compared as numbers, not text")
  assert.equal(compareVersions("0.2.0", "0.2.0"), 0)
  // The beta firmware answers `0.1.0-beta`, and it is older than the release it leads to.
  assert.equal(compareVersions("0.1.0-beta", "0.1.0"), -1)
  assert.equal(compareVersions("0.1.0", "0.1.0-beta"), 1)
  assert.equal(compareVersions("0.1.0-beta.2", "0.1.0-beta.10"), -1, "compared as numbers")
  assert.equal(compareVersions("0.1.0-beta", "0.1.0-beta"), 0)
  // A fourth part and a name that is not a version are builds nobody's publish wrote: no comparison.
  assert.equal(compareVersions("0.1.0.9", "0.1.0"), null)
  assert.equal(compareVersions("latest", "0.1.0"), null)

  const running = { state: "says", version: "0.2.0-beta" }
  assert.equal(firmwareOffers({ running, published: "0.2.0", answered: true }), true)
  assert.equal(
    firmwareWords({ running, published: "0.2.0", answered: true }),
    "Charm 0.2.0-beta · 0.2.0 available",
  )
  assert.equal(
    firmwareWords({ running, published: "0.2.0-beta", answered: true }),
    "Charm 0.2.0-beta · up to date",
  )
  assert.equal(
    firmwareWords({
      running: { state: "says", version: "0.1.0" },
      published: "0.1.0.9",
      answered: true,
    }),
    "Charm 0.1.0 · can't tell if 0.1.0.9 is newer",
  )
})

test("a link that never opened is not a charm that had nothing to say", () => {
  assert.equal(
    firmwareWords({
      running: { state: "unreachable" },
      published: "0.2.0",
      answered: true,
    }),
    "0.2.0 published · couldn't reach the charm",
  )
  assert.equal(
    firmwareWords({ running: { state: "reading" }, published: "0.2.0", answered: true }),
    "0.2.0 published · the charm didn't say",
    "not read yet is still its own answer",
  )
  assert.equal(
    firmwareWords({ running: { state: "too-old" }, published: "0.2.0", answered: true }),
    "This charm can't say which version it runs — the first update is by cable",
    "and a firmware too old to say is said in the row's own words",
  )
})
