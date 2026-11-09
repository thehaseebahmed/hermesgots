/**
 * A connection's roster of seatable profiles, as New room reads it: the Host seats a room's members
 * per connection and names the profiles its connection may seat, so a bot outside that list is
 * greyed rather than offered (ADR 0128). A Host older than the field names none, and then nothing
 * filters, while a bot with no profile of its own has none a roster could name.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { makerOf, seatsProfile, seatedByAny } from "../src/lib/room-seats.ts"

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

test("the earliest pick whose connection seats every pick makes the room", () => {
  const picks = [
    { profile: "ada", seatable: ["zed"] },
    { profile: "zed", seatable: ["ada", "zed"] },
  ]
  assert.equal(makerOf(picks), 1, "the room is made where its roster holds every pick")
})

test("where no connection seats them all, the first pick makes it and the create repairs the Host", () => {
  const picks = [
    { profile: "ada", seatable: ["zed"] },
    { profile: "zed", seatable: ["zed"] },
  ]
  assert.equal(makerOf(picks), 0, "pick order still names the room, and the create seats what it can't")
})

test("a connection that named every pick outranks one still owing its answer", () => {
  const picks = [
    { profile: "ada", seatable: undefined },
    { profile: "zed", seatable: ["ada", "zed"] },
  ]
  assert.equal(makerOf(picks), 1, "an answer is worth more than a guess")
  assert.equal(
    makerOf([
      { profile: "ada", seatable: ["ada", "zed"] },
      { profile: "zed", seatable: undefined },
    ]),
    0,
    "and the earliest one that named them wins",
  )
})

test("a Host that named no roster anywhere keeps the first pick", () => {
  const picks = [
    { profile: "ada", seatable: null },
    { profile: "zed", seatable: null },
  ]
  assert.equal(makerOf(picks), 0, "no roster is no rule, so nothing moves the room")
  assert.equal(makerOf([]), -1, "and no picks make no maker")
})

test("a profile no picked connection seats is marked as needing the Host", () => {
  const picks = [
    { profile: "ada", seatable: ["zed"] },
    { profile: "zed", seatable: ["zed"] },
  ]
  assert.equal(seatedByAny(picks, "zed"), true, "one connection names it, so nothing is written")
  assert.equal(seatedByAny(picks, "ada"), false, "no connection names it, so the Host will be configured")
  assert.equal(
    seatedByAny([{ profile: "ada", seatable: undefined }], "ada"),
    true,
    "an answer still owed holds nothing out and marks nothing",
  )
})
