/**
 * The channels a phone gets: one per notification type it can reach. Meetings' two exist only once
 * that experiment is on, so a device that never turns it on is never asked about notes it cannot get.
 * A unit test because the rule is pure (`reachableCategories`), and `listen()` is not reachable
 * without Capacitor.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { PUSH_CATEGORIES, reachableCategories } from "../src/lib/push-kinds.ts"

const ids = (categories) => categories.map((category) => category.id)

test("with the experiment off, Meetings' two are not this phone's", () => {
  assert.deepEqual(
    ids(reachableCategories(false)),
    ids(PUSH_CATEGORIES.filter((category) => category.feature !== "meetings")),
    "fourteen, in the order the list keeps",
  )
})

test("every feature but Meetings is reachable with the experiment off", () => {
  assert.deepEqual(
    [...new Set(reachableCategories(false).map((category) => category.feature))],
    ["chats", "code", "routines", "research"],
  )
})

test("with the experiment on, every type is", () => {
  assert.deepEqual(reachableCategories(true), PUSH_CATEGORIES)
  assert.deepEqual(ids(reachableCategories(true)).slice(-2), ["meeting_done", "meeting_failed"])
})

/**
 * The rest of the ticket is text, not a rule `node --test` can call: `listen()` and `sendTestPush()`
 * need Capacitor, and the registry and the manifest are other files entirely. So the same way
 * `plugin/tests/test_push_kinds.py` guards the four id lists, these read the three files as text and
 * pin the one id they must agree on.
 */
const app = new URL("../src/lib/", import.meta.url)
const read = (path) => readFileSync(new URL(path, app), "utf8")

const push = read("push.ts")
const registry = read("../../netlify/lib/fcm.ts")
const manifest = read("../../android/app/src/main/AndroidManifest.xml")

test("launch makes the channels this phone can reach, not all sixteen", () => {
  assert.match(
    push,
    /for \(const category of reachableCategories\(meetings\)\)/,
    "the loop asks the rule with the experiment's own flag",
  )
  assert.doesNotMatch(push, /for \(const category of PUSH_CATEGORIES\)/)
})

test("nothing is made at launch for the test push", () => {
  assert.doesNotMatch(
    push,
    /createChannel\(\{\s*id:\s*"sessions"/,
    "the legacy channel is not created on any launch",
  )
})

test("the channel an earlier build made for the test push is deleted at launch", () => {
  assert.match(push, /deleteChannel\(\{\s*id:\s*"sessions"\s*\}\)\s*\.catch\(\(\) => \{\}\)/)
})

test("the tap that sends the test makes its channel first", () => {
  const sendTest = push.match(/export async function sendTestPush\(\) \{[\s\S]*?\n\}/)?.[0] ?? ""
  assert.ok(sendTest, "sendTestPush is in push.ts")
  const made = sendTest.indexOf("createChannel")
  const posted = sendTest.indexOf('"push-test"')
  assert.ok(made >= 0, "it creates the test notification's channel")
  assert.ok(posted >= 0, "it asks the registry for the test push")
  assert.ok(made < posted, "so a send can never outrun its channel's existence")
})

test("the app, the registry and the manifest name the same test channel", () => {
  const made = push.match(
    /createChannel\(\{\s*id:\s*"([a-z_]+)",\s*name:\s*"([^"]+)",\s*importance:\s*(\d)/,
  )
  const sent = registry.match(/channel_id:\s*kind === "test"\s*\?\s*"([a-z_]+)"\s*:\s*category/)
  const fallback = manifest.match(
    /default_notification_channel_id"\s*\n\s*android:value="([a-z_]+)"/,
  )
  // A channel-less push falls back to the manifest's id, so it must be a channel that exists once a
  // tap has made it, never the deleted legacy one (which would land in Android's "Miscellaneous").
  assert.deepEqual(
    [made?.[1], sent?.[1], fallback?.[1]],
    ["test_notification", "test_notification", "test_notification"],
  )
  assert.equal(made?.[2], "Test notification", "the phone's list shows what the row sends")
  assert.equal(made?.[3], "4", "it peeks, as the row that sends it is the user's own doing")
  assert.doesNotMatch(registry, /"sessions"/, "the registry knows no legacy channel")
})
