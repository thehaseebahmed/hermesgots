/**
 * A steer the user sent into a running reply: it is drawn where it reached the agent, and it is
 * drawn as soon as the host took it — a stream carries no event for a steer, so the transcript's row
 * for one arrives a read later, and the row lands only when the run reads the steer.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { withCarried, withSteer } from "../src/chat-next/fold.ts"

const steer = (text) => ({ kind: "steer", text })
const words = (text) => ({ kind: "text", text })
const call = (id) => ({ kind: "tools", calls: [{ id, name: "terminal" }] })

const reply = (parts) => ({ user: "go", done: false, delivered: [], parts })
const kinds = (turn) => turn.parts.map((part) => part.kind)
const said = (turn) => turn.parts.filter((part) => part.kind === "steer").map((part) => part.text)

test("a steer the transcript folded is drawn in the reply the stream is drawing", () => {
  // The run wrote "One." then read the steer, and the copy says so: the steer stands after it.
  const copy = reply([words("One."), steer("please slow down"), words("Two.")])
  const live = reply([words("One.Two.")])
  assert.deepEqual(kinds(withCarried(live, copy)), ["text", "steer"])
  assert.deepEqual(said(withCarried(live, copy)), ["please slow down"])
})

test("a steer whose place the reply has already written past still draws, where the reply crossed it", () => {
  // The host writes the row when it reads the steer; by the read that brings it here the reply may
  // have run on, so the anchor can be behind the live copy — the steer must still draw.
  const copy = reply([words("One."), steer("please slow down")])
  const live = reply([words("One."), call("c1"), words("Two.")])
  assert.deepEqual(kinds(withCarried(live, copy)), ["text", "steer", "tools", "text"])
  assert.deepEqual(said(withCarried(live, copy)), ["please slow down"])
})

test("a steer the stream has not caught up to yet waits at the foot, rather than nowhere", () => {
  // The copy can be ahead of the stream it is paired with: the row is drawn, then the stream writes
  // the words around it later. A steer anchored past everything drawn goes at the reply's end.
  const copy = reply([words("One. Two."), steer("please slow down")])
  const live = reply([words("One.")])
  const drawn = withCarried(live, copy)
  assert.deepEqual(kinds(drawn), ["text", "steer"])
  assert.deepEqual(said(drawn), ["please slow down"])
})

test("a steer this device sent is drawn once, not again when its row arrives", () => {
  const live = withSteer(reply([words("One.")]), "please slow down")
  assert.deepEqual(kinds(live), ["text", "steer"], "the steer stands at once")
  const copy = reply([words("One."), steer("please slow down"), words("Two.")])
  const drawn = withCarried(live, copy)
  assert.deepEqual(said(drawn), ["please slow down"], "the row is the same steer, not a second one")
})

test("another device's steer still lands beside this device's own", () => {
  const live = withSteer(reply([words("One.")]), "mine")
  const copy = reply([words("One."), steer("mine"), words("Two."), steer("theirs")])
  const drawn = withCarried(live, copy)
  assert.deepEqual(said(drawn), ["mine", "theirs"])
})

test("a steer with nothing to say is not a part", () => {
  const live = reply([words("One.")])
  assert.equal(withSteer(live, "   "), live)
})

test("a reply with nothing carried is the stream's own turn, untouched", () => {
  const live = reply([words("One.")])
  assert.equal(withCarried(live, reply([words("One.")])), live)
})
