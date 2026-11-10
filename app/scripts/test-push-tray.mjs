/**
 * The tray rules, driven exhaustively; the wiring around them is pinned as text, because reading a
 * real tray needs a browser or a phone (`push-source.mjs`).
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { aboutSubject, chatSubject, pushSubject } from "../src/lib/push-kinds.ts"
import { body, read } from "./push-source.mjs"

const route = (name) => readFileSync(new URL(`../src/routes/${name}.tsx`, import.meta.url), "utf8")

const web = (session, group = "session") => ({
  tag: `${group}:${session}`,
  data: { sessionId: session },
})

// Android's tag is the category and the session, and no data rides: the tag is all there is to read.
const android = (category, session) => ({ tag: `${category}:${session}`, data: {} })

test("a push names the subject its tag or its data carries", () => {
  assert.equal(pushSubject(web("gots-chat-1")), "gots-chat-1")
  assert.equal(pushSubject(android("chat_input", "gots-chat-1")), "gots-chat-1")
  assert.equal(pushSubject(android("room_input", "room-1")), "room-1")
  assert.equal(pushSubject(android("research_done", "mission-1")), "mission-1")
  assert.equal(pushSubject(android("meeting_done", "meeting-1")), "meeting-1")
  // A routine's failure and a project that couldn't be set up name their own id, which no screen
  // opens: the tap is what answers them.
  assert.equal(pushSubject(android("routine_failed", "job-1")), "job-1")
  assert.equal(pushSubject(android("code_setup_failed", "project-1")), "project-1")
  // The web's notification carries it in its data, so a tag that was rewritten still names it.
  assert.equal(pushSubject({ tag: "gots", data: { sessionId: "gots-chat-1" } }), "gots-chat-1")
})

test("a push carrying no id names nothing", () => {
  // The test notification, and a push a service worker showed under no session at all.
  assert.equal(pushSubject({ tag: "test:", data: {} }), undefined)
  assert.equal(pushSubject({ tag: "gots", data: { sessionId: "" } }), undefined)
  assert.equal(pushSubject({}), undefined)
  assert.equal(pushSubject({ tag: null, data: null }), undefined)
})

test("a push is answered only by the screen it is about", () => {
  assert.equal(aboutSubject(web("gots-chat-a"), "gots-chat-a"), true)
  assert.equal(
    aboutSubject(web("gots-chat-b"), "gots-chat-a"),
    false,
    "another thread's push is left in the tray",
  )
  assert.equal(
    aboutSubject(android("chat_input", "gots-chat-c"), "gots-chat-c"),
    true,
    "and a phone's tag answers the same way",
  )
  assert.equal(
    aboutSubject({ tag: "gots", data: { sessionId: "" } }, "gots-chat-a"),
    false,
    "a push that names nothing is never answered",
  )
})

test("a chat answers its session, and a room its own id", () => {
  assert.equal(chatSubject({ id: "chat-1", hermesSessionId: "gots-chat-1" }), "gots-chat-1")
  assert.equal(
    chatSubject({
      id: "room-1",
      hermesSessionId: "gots-room-1",
      room: { id: "room-1", members: [] },
    }),
    "room-1",
    "the Host pushes a room under the room's id, not the session the app gave its row",
  )
})

test("nothing empties the tray: an arrival answers no push", () => {
  const push = read("push.ts")
  assert.doesNotMatch(
    push,
    /removeAllDeliveredNotifications/,
    "every push is dismissed one at a time, by what it is about",
  )
  assert.doesNotMatch(push, /clearNotifications/, "and nothing clears the tray whole")
  for (const name of ["startWeb", "startNative", "startPush"]) {
    assert.ok(body(name), `${name} is in push.ts`)
    assert.doesNotMatch(
      body(name),
      /dismiss/,
      `${name} answers nothing: a push leaves by the screen it is about, or by its tap`,
    )
  }
})

test("one screen's answer closes its own pushes, read once", () => {
  const dismissal = body("dismiss")
  assert.ok(dismissal, "dismiss is in push.ts")
  assert.match(dismissal, /getDeliveredNotifications\(\)/, "the phone's tray is read")
  assert.match(
    dismissal,
    /removeDeliveredNotifications\(\{ notifications: answered \}\)/,
    "and only the pushes the rule answered are removed",
  )
  assert.match(dismissal, /getNotifications\(\)/, "the web's tray is read the same way")
  const rule = dismissal.indexOf("aboutSubject(")
  assert.ok(rule >= 0, "both are held to the rule")
  assert.ok(
    rule < dismissal.indexOf("notification.close()"),
    "a notification is closed only where it picked one",
  )
  assert.ok(rule < dismissal.indexOf("removeDeliveredNotifications("), "and removed only there too")
})

test("the screens a push names answer it, and a tap answers its own", () => {
  assert.match(route("chat"), /useDismissChatPushes\(/, "the chat on screen answers its thread")
  assert.match(route("research"), /useDismissPushes\(mission\?\.id\)/, "a mission answers its own")
  assert.match(route("meetings"), /useDismissPushes\(id\)/, "and so does a meeting")
  const listen = body("listen")
  assert.ok(listen, "listen is in push.ts")
  assert.match(
    listen,
    /pushNotificationActionPerformed[\s\S]*dismiss\(/,
    "the push a tap came from has been answered, whatever screen it opens",
  )
})

test("both writers end a tag with the id a dismissal reads", () => {
  // Two files build this tag and neither can be imported here: the service worker the browser runs,
  // and the function Firebase is asked through. Pinning the shape is the only way a change to either
  // is a change to what `pushSubject` reads.
  const writers = [
    ["public/push-sw.js", /const tag = sessionId \? `\$\{[^}]+\}:\$\{sessionId\}`/, "session:"],
    ["netlify/lib/fcm.ts", /tag: `\$\{category\}:\$\{sessionId\}`/, "chat_input:"],
  ]
  for (const [file, shape, prefix] of writers) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8")
    assert.match(source, shape, `${file} tags a push \`<what it is>:<the id>\``)
    assert.equal(
      pushSubject({ tag: `${prefix}gots-1` }),
      "gots-1",
      `${file}'s tag names the session its push is about`,
    )
  }
})
