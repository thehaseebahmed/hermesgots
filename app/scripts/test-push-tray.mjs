/**
 * The tray rules, driven exhaustively; the worker's own half is driven too, in a stubbed worker
 * scope, and the app-side wiring around them is pinned as text, because reading a real tray needs a
 * browser or a phone (`push-source.mjs`).
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import vm from "node:vm"

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

/** A value of the worker's realm as this one reads it: `vm`'s objects are not this realm's. */
const plain = (value) => JSON.parse(JSON.stringify(value))

/**
 * The worker scope `push-sw.js` runs in, stubbed: the listeners it registers, the entries it puts in
 * the tray, and the two things a press can reach — a link it can post to, and a window it can open.
 * No client is listed, so the worker reads the app as being away, which is when a tray entry stays.
 */
function tray() {
  const listeners = []
  const shown = []
  const posted = []
  const opened = []
  const closed = []
  const scope = {
    setTimeout,
    fetch: async (url, init) => {
      posted.push({ url, init })
      return {}
    },
    self: {
      addEventListener: (type, fn) => listeners.push({ type, fn }),
      registration: {
        showNotification: async (title, options) => shown.push({ title, options }),
        getNotifications: async () => [],
      },
      clients: { matchAll: async () => [], openWindow: async (path) => opened.push(path) },
    },
  }
  vm.createContext(scope)
  vm.runInContext(readFileSync(new URL("../public/push-sw.js", import.meta.url), "utf8"), scope)
  // A browser runs a listener and waits on what it asked to keep alive, so the two are one step.
  const fire = async (type, event) => {
    const waits = []
    const one = { ...event, waitUntil: (promise) => waits.push(promise) }
    for (const listener of listeners) if (listener.type === type) listener.fn(one)
    await Promise.all(waits)
    return one
  }
  return {
    shown,
    posted,
    opened,
    closed,
    push: (data) => fire("push", { data: { json: () => data } }),
    press: (event) => fire("notificationclick", event),
  }
}

/** The notice an approval's push carries: the chat's name, the card's body, and its two buttons. */
const ONCE = "https://bot.example/api/plugins/gots/push/answer/once-1"
const DENY = "https://bot.example/api/plugins/gots/push/answer/deny-1"
const approval = {
  kind: "approval",
  session_id: "gots-1",
  title: "Fix the build",
  body: "Clear the build\n\nrm -rf ./build",
  bot: "nova",
  actions: [
    { label: "Allow once", url: ONCE },
    { label: "Deny", url: DENY },
  ],
}

test("a tray entry is the notice's: its body, its picture and its buttons", async () => {
  const worker = tray()
  await worker.push(approval)
  const entry = worker.shown[0]
  assert.equal(entry.title, "Fix the build", "the chat's name is the title")
  assert.equal(entry.options.body, approval.body, "and the card's own body is under it")
  assert.equal(entry.options.icon, "/bots/nova/notify.png", "the badged picture, not the plain pose")
  assert.deepEqual(
    plain(entry.options.actions),
    [
      { action: "0", title: "Allow once" },
      { action: "1", title: "Deny" },
    ],
    "both buttons are the notice's, each one numbered by where it sits",
  )
  // A host that still holds a retired id draws the character that replaced it, badge and all.
  await worker.push({ kind: "run_done", session_id: "gots-2", bot: "sprout" })
  assert.equal(worker.shown[1].options.icon, "/bots/nova/notify.png")
  // And a push that names no bot keeps the app's own icon, with no buttons to draw.
  await worker.push({ kind: "run_done", session_id: "gots-3" })
  assert.equal(worker.shown[2].options.icon, "/pwa-192x192.png")
  assert.equal(worker.shown[2].options.actions, undefined, "a finished run carries none")
})

test("a press of a button posts its link and opens no window", async () => {
  const worker = tray()
  await worker.push(approval)
  const entry = worker.shown[0]
  await worker.press({
    action: "0",
    notification: { data: plain(entry.options.data), close: () => worker.closed.push(true) },
  })
  assert.deepEqual(
    worker.posted.map((one) => [one.url, plain(one.init)]),
    [[ONCE, { method: "POST", mode: "no-cors" }]],
    "the first button posts the link the notice gave it, and nothing else",
  )
  assert.deepEqual(worker.opened, [], "an answer is not a visit: no window opens")
  assert.equal(worker.closed.length, 1, "and the row leaves the tray")
})

test("a press with no button still opens what the push is about", async () => {
  const worker = tray()
  await worker.push({ kind: "approval", session_id: "gots-1", title: "Fix the build" })
  const entry = worker.shown[0]
  await worker.press({
    notification: { data: plain(entry.options.data), close: () => worker.closed.push(true) },
  })
  assert.deepEqual(worker.opened, ["/s/gots-1"], "the chat the push is about")
  assert.deepEqual(worker.posted, [], "a visit answers nothing")
  assert.equal(worker.closed.length, 1)
})
