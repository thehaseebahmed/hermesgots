/**
 * What the device's tray is holding, and what an opened screen has answered. The rules are pure, so
 * the unit tier drives them; the wiring around them is pinned as text elsewhere in this file's
 * suite, because reading a tray needs a browser or a phone (`push-source.mjs`). A push about a
 * thread leaves the tray when that thread is opened, and one about anything else stays where it is.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { aboutSubject, chatSubject, pushSubject } from "../src/lib/push-kinds.ts"

/** A push the web's service worker is showing, tagged and carried the way it writes them. */
const web = (session, group = "session") => ({
  tag: `${group}:${session}`,
  data: { sessionId: session, screen: `/c/${session}` },
})

/** The same push on Android: Firebase's tag is the category and the session, and no data rides. */
const android = (category, session) => ({ tag: `${category}:${session}`, data: {} })

test("a push names the subject its tag or its data carries", () => {
  assert.equal(pushSubject(web("gots-chat-1")), "gots-chat-1")
  assert.equal(pushSubject(android("chat_input", "gots-chat-1")), "gots-chat-1")
  // A room, a mission and a meeting are subjects too: each has a screen that opens it.
  assert.equal(pushSubject(android("room_input", "room-1")), "room-1")
  assert.equal(pushSubject(android("research_done", "mission-1")), "mission-1")
  assert.equal(pushSubject(android("meeting_done", "meeting-1")), "meeting-1")
  // The web's notification carries it in its data, so a tag that was rewritten still names it.
  assert.equal(pushSubject({ tag: "gots", data: { sessionId: "gots-chat-1" } }), "gots-chat-1")
})

test("a push about nothing a screen opens names no subject", () => {
  // A routine's failure and a project that couldn't be set up: no thread, no screen of their own.
  assert.equal(pushSubject({ tag: "gots", data: { sessionId: "", screen: "/routines" } }), undefined)
  assert.equal(pushSubject({ tag: "routine_failed:", data: {} }), undefined)
  assert.equal(pushSubject({ tag: "code_setup_failed:", data: {} }), undefined)
  assert.equal(pushSubject({}), undefined)
  assert.equal(pushSubject({ tag: null, data: null }), undefined)
})

test("only the subject a screen has opened is answered", () => {
  const shown = [web("gots-chat-a"), web("gots-chat-b"), android("chat_input", "gots-chat-c")]
  const answered = shown.filter((push) => aboutSubject(push, ["gots-chat-b"]))
  assert.deepEqual(
    answered.map((push) => push.tag),
    ["session:gots-chat-b"],
    "opening one thread dismisses its push, and the other threads' are left in the tray",
  )
  assert.equal(
    shown.filter((push) => aboutSubject(push, ["gots-chat-a", "gots-chat-c"])).length,
    2,
    "two screens on display answer two pushes",
  )
  assert.equal(aboutSubject(web("gots-chat-a"), []), false, "nothing on display answers nothing")
  assert.equal(
    aboutSubject({ tag: "gots", data: { sessionId: "" } }, ["gots-chat-a"]),
    false,
    "a push that names nothing is never answered by a screen",
  )
})

test("a chat answers its session, and a room its own id", () => {
  assert.equal(chatSubject({ id: "chat-1", hermesSessionId: "gots-chat-1" }), "gots-chat-1")
  assert.equal(
    chatSubject({ id: "room-1", hermesSessionId: "gots-room-1", room: { id: "room-1" } }),
    "room-1",
    "the Host pushes a room under the room's id, not the session the app gave its row",
  )
  assert.equal(chatSubject({ id: "chat-1" }), undefined, "a chat with no session names nothing")
})
