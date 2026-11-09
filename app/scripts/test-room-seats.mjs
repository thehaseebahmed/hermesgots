/**
 * A connection's roster of seatable profiles, as New room reads it: the Host seats a room's members
 * per connection and names the profiles its connection may seat, so a bot outside that list is
 * greyed rather than offered (ADR 0128). A Host older than the field names none, and then nothing
 * filters, while a bot with no profile of its own has none a roster could name.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { seatsProfile } from "../src/lib/room-seats.ts"

test("a named roster seats the profile it names and leaves the others out", () => {
  assert.equal(seatsProfile(["coder", "ops"], "coder"), true)
  assert.equal(seatsProfile(["coder", "ops"], "writer"), false)
})

test("an empty roster seats nothing, because the Host named one", () => {
  assert.equal(seatsProfile([], "coder"), false, "a roster that names no profile is still a roster")
})

test("a Host that named no roster filters nothing", () => {
  assert.equal(seatsProfile(null, "coder"), true, "an older Host, which keeps the picker it had")
  assert.equal(seatsProfile(undefined, "coder"), true, "no answer yet, so nothing is held out")
})

test("a bot with no profile is no seat where a roster is named", () => {
  assert.equal(seatsProfile(["coder"], null), false, "no roster names it, and the create would name it")
  assert.equal(seatsProfile(["coder"], undefined), false)
  assert.equal(seatsProfile(["coder"], ""), false)
  assert.equal(seatsProfile(null, null), true, "where no roster is named there is no rule to break")
})
