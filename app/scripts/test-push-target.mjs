/**
 * Where a tapped notification lands, given what this device holds. A session's chat is opened from
 * the row the device already has, so the tap goes straight to `/c/<id>`; a chat the device doesn't
 * hold keeps the path it came with, which is the session route that syncs for it. A tap that names
 * something else — a research mission, a routine, a meeting, a chat — is left exactly where it was.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { pushPath, pushTarget, pushedSession } from "../src/lib/push-kinds.ts"
import { body } from "./push-source.mjs"

test("a session's tap opens the chat this device holds", () => {
  assert.equal(pushTarget("hermes-1", "chat-1"), "/c/chat-1")
  assert.equal(pushTarget("hermes-1", "a b"), "/c/a%20b")
  // An id the notification had to encode is decoded, so the chat is found by the id Hermes knew.
  assert.equal(pushedSession("/s/a%2Fb"), "a/b")
  assert.equal(pushTarget(pushedSession(pushPath("code_input", "a/b")), "chat-1"), "/c/chat-1")
})

test("a chat this device doesn't hold keeps the session route", () => {
  assert.equal(pushTarget("hermes-1", undefined), undefined)
  assert.equal(pushedSession("/s/hermes-1"), "hermes-1")
})

test("a room's tap opens the room's own row, which is a chat here", () => {
  assert.equal(pushPath("room_input", "room-1"), "/c/room-1")
  assert.equal(pushPath("room_input", "a b"), "/c/a%20b")
  assert.equal(pushPath("room_input", undefined), "/")
})

test("a tap that names something else names no session", () => {
  assert.equal(pushedSession("/c/chat-1"), undefined)
  assert.equal(pushedSession("/research/mission-1"), undefined)
  assert.equal(pushedSession("/s/hermes-1/extra"), undefined)
  assert.equal(pushedSession("/"), undefined)
})

test("a malformed escape still names its session", () => {
  assert.equal(pushedSession("/s/%E0%A4%A"), "%E0%A4%A")
  assert.equal(pushedSession("/s/%"), "%")
})

test("the tap reads this device's chat before it names a path", () => {
  const source = body("openPush")
  assert.ok(source, "openPush is in push.ts")
  // The device's own row is what makes the fast path free: read it, then let the rule name the path.
  assert.ok(
    source.indexOf("chatIdForSession") < source.indexOf("pushTarget"),
    "openPush looks the session up before it builds the path",
  )
})
