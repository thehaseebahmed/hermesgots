/**
 * How a device is notified, as a rule: which transports a build offers, which is in use, what the
 * app must hold before ntfy can be turned on, and where an ntfy notification's link goes.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { PUSH_CATEGORIES, linkedPush } from "../src/lib/push-kinds.ts"
import {
  PUSH_TRANSPORTS,
  activeTransport,
  mintTopic,
  ntfyTokenOk,
  ntfyPriorities,
  ntfyServer,
  ntfyTopicOk,
  transportsFor,
} from "../src/lib/push-transport.ts"

const apk = { native: true, firebase: true, web: false }
const bare = { native: true, firebase: false, web: false }
const page = { native: false, firebase: false, web: true }

test("an APK without Firebase offers ntfy and nothing else", () => {
  assert.deepEqual(transportsFor(bare), ["ntfy"])
  assert.equal(activeTransport(bare), "ntfy")
  assert.equal(
    activeTransport(bare, "firebase"),
    "ntfy",
    "a pick this build can't carry falls to ntfy",
  )
})

test("an APK with Firebase stays on it until ntfy is picked", () => {
  assert.deepEqual(transportsFor(apk), ["firebase", "ntfy"])
  assert.equal(activeTransport(apk), "firebase", "an install that predates the pick keeps Firebase")
  assert.equal(activeTransport(apk, "ntfy"), "ntfy")
})

test("a browser has Web Push or nothing", () => {
  assert.deepEqual(transportsFor(page), ["webpush"])
  assert.equal(activeTransport(page, "ntfy"), "webpush")
  assert.deepEqual(transportsFor({ ...page, web: false }), [])
  assert.equal(activeTransport({ ...page, web: false }), undefined)
})

test("only Firebase leaves a category's switch to the phone", () => {
  assert.equal(PUSH_TRANSPORTS.firebase.categories, "system")
  assert.equal(PUSH_TRANSPORTS.ntfy.categories, "app")
  assert.equal(PUSH_TRANSPORTS.webpush.categories, "app")
})

test("any web address is a server, with or without the scheme typed", () => {
  assert.equal(ntfyServer("ntfy.sh"), "https://ntfy.sh")
  assert.equal(ntfyServer(" https://ntfy.example.com/ "), "https://ntfy.example.com")
  assert.equal(ntfyServer("https://example.com/ntfy/"), "https://example.com/ntfy")
  // Whether the bot's host can reach it is the host's business, so a LAN or plain-http one is taken.
  assert.equal(ntfyServer("http://192.168.1.5:2586"), "http://192.168.1.5:2586")
  assert.equal(ntfyServer("http://localhost"), "http://localhost")
  assert.equal(ntfyServer("ntfy"), "https://ntfy")
  for (const refused of ["", "ftp://ntfy.sh", "https://u:p@ntfy.sh", "https://ntfy.sh/?x=1"])
    assert.equal(ntfyServer(refused), undefined, refused)
})

test("a minted topic is one ntfy takes and nobody guesses", () => {
  const random = (count) => crypto.getRandomValues(new Uint8Array(count))
  const topic = mintTopic(random)
  assert.match(topic, /^gots-[A-Za-z0-9]{22}$/)
  assert.ok(ntfyTopicOk(topic))
  assert.notEqual(topic, mintTopic(random))
  // A source that only ever answers bytes past the even range is drawn again, never folded in.
  let calls = 0
  const skewed = (count) => new Uint8Array(count).fill(calls++ ? 7 : 255)
  assert.equal(mintTopic(skewed), `gots-${"h".repeat(22)}`)
  for (const refused of ["", "a b", "a/b", "x".repeat(65)])
    assert.equal(ntfyTopicOk(refused), false)
})

test("a token is what a header can carry", () => {
  assert.ok(ntfyTokenOk("tk_abc"))
  for (const refused of ["", "two words", "x".repeat(513)]) assert.equal(ntfyTokenOk(refused), false)
})

test("a category's importance is its ntfy priority", () => {
  const priorities = ntfyPriorities(PUSH_CATEGORIES)
  assert.equal(priorities.chat_input, 4, "what waits on the user peeks")
  assert.equal(priorities.code_run_failed, 3)
  assert.equal(priorities.code_pr_merged, 2, "and a merge stays silent")
  assert.equal(Object.keys(priorities).length, PUSH_CATEGORIES.length)
})

test("an ntfy notification's link lands where any other tap would", () => {
  assert.equal(linkedPush("gots://open?kind=question&id=gots-1"), "/s/gots-1")
  assert.equal(linkedPush("gots://open?kind=room_input&id=room-1"), "/c/room-1")
  assert.equal(linkedPush("gots://open?kind=research_done&id=m%2F1"), "/research/m%2F1")
  assert.equal(linkedPush("gots://open?kind=routine_failed&id=job"), "/routines")
  assert.equal(linkedPush("gots://auth#token"), null, "the sign-in link is not a notification's")
  assert.equal(linkedPush("https://open?kind=question&id=1"), null)
  assert.equal(linkedPush("not a url"), null)
  assert.equal(linkedPush("gots://open?kind=question"), null, "a link naming nothing opens nothing")
})
