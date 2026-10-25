/**
 * What the registry is told this phone allows, when a list is news, and the channels a launch
 * writes. Pure rules over plain inputs, so the unit tier drives them exhaustively; the wiring around
 * them is pinned as text (`push-source.mjs`) because listing a phone's channels needs Capacitor.
 */
import assert from "node:assert/strict"
import test from "node:test"

import {
  PUSH_CATEGORIES,
  allowedCategoryIds,
  changedList,
  channelName,
  channelPlan,
  reachableCategories,
} from "../src/lib/push-kinds.ts"
import { body, read } from "./push-source.mjs"

const ids = (categories) => categories.map((category) => category.id)
/** Every id, in the order the list keeps: what a phone that can reach everything is told. */
const all = ids(reachableCategories(true))
/** The fourteen a phone without the Meetings experiment can reach. */
const withoutMeetings = ids(reachableCategories(false))
/** A phone that has made every channel and left it alone: Android's importance 2, 3 or 4. */
const healthy = PUSH_CATEGORIES.map(({ id, importance }) => ({ id, importance }))

test("a channel switched off in Android's settings is left out", () => {
  const channels = healthy.map((channel) =>
    channel.id === "code_run_done" ? { ...channel, importance: 0 } : channel,
  )
  assert.deepEqual(
    allowedCategoryIds({ allowed: true, channels }, true),
    all.filter((id) => id !== "code_run_done"),
    "that one stops costing a push, and nothing else changes",
  )
})

test("each channel the user switched off is left out, however many", () => {
  const off = ["chat_input", "code_pr_merged", "routine_failed"]
  const channels = healthy.map((channel) =>
    off.includes(channel.id) ? { ...channel, importance: 0 } : channel,
  )
  assert.deepEqual(
    allowedCategoryIds({ allowed: true, channels }, true),
    all.filter((id) => !off.includes(id)),
  )
})

test("a channel the phone doesn't list counts as allowed", () => {
  assert.deepEqual(
    allowedCategoryIds({ allowed: true, channels: [] }, true),
    all,
    "a first launch has made no channel it can read, and must still register the full list",
  )
  // A phone that lists some of them: the ones it hasn't made are allowed, the rest by importance.
  assert.deepEqual(
    allowedCategoryIds(
      {
        allowed: true,
        channels: [
          { id: "chat_input", importance: 4 },
          { id: "code_input", importance: 0 },
        ],
      },
      true,
    ),
    all.filter((id) => id !== "code_input"),
  )
})

test("a healthy phone allows every type, in the order the list keeps", () => {
  const allowed = allowedCategoryIds({ allowed: true, channels: healthy }, true)
  assert.deepEqual(allowed, all)
  assert.equal(allowed.length, PUSH_CATEGORIES.length, "the sixteen stay sixteen")
})

test("with the phone's notifications off the registration carries an empty list", () => {
  assert.deepEqual(
    allowedCategoryIds({ allowed: false, channels: healthy }, true),
    [],
    "not a deleted device, and not a list that would keep sending",
  )
})

test("an importance the phone doesn't report is a channel the user left alone", () => {
  const channels = healthy.map(({ id }) => ({ id }))
  assert.deepEqual(
    allowedCategoryIds({ allowed: true, channels }, true),
    all,
    "a plugin that answers without importance must not silence anything",
  )
})

test("a phone that cannot reach Meetings does not register its two", () => {
  for (const meetings of [false, undefined]) {
    const allowed = allowedCategoryIds({ allowed: true, channels: healthy }, meetings)
    assert.deepEqual(allowed, withoutMeetings, "fourteen, and Meetings' two among the missing")
    assert.equal(allowed.includes("meeting_done"), false, "no channel it will never be shown")
    assert.equal(allowed.includes("meeting_failed"), false)
  }
  assert.deepEqual(
    allowedCategoryIds({ allowed: true, channels: [] }, false),
    withoutMeetings,
    "a first launch on such a phone registers fourteen",
  )
})

test("a channel the phone already holds keeps the importance the phone reported", () => {
  const plan = channelPlan(reachableCategories(false), [
    { id: "code_pr_merged", importance: 4 },
    { id: "chat_input", importance: 2 },
  ])
  const planned = (id) => plan.find((channel) => channel.id === id)
  assert.equal(planned("code_pr_merged").importance, 4, "the user's louder choice is left as it is")
  assert.equal(planned("chat_input").importance, 2, "and their silence is not undone")
  assert.equal(
    planned("code_pr_merged").name,
    "Code: Pull request merged",
    "while the name still tracks the code",
  )
})

test("a channel the phone never had is made with its row's importance", () => {
  const plan = channelPlan(reachableCategories(false), [])
  assert.deepEqual(
    plan.map(({ id, importance }) => [id, importance]),
    PUSH_CATEGORIES.filter((category) => category.feature !== "meetings").map(
      ({ id, importance }) => [id, importance],
    ),
    "the first launch's defaults, one channel each",
  )
  assert.equal(plan.length, 14, "and none for a feature this phone cannot reach")
  for (const channel of plan) {
    const row = PUSH_CATEGORIES.find((category) => category.id === channel.id)
    assert.equal(channel.name, channelName(row), channel.id)
  }
})

test("a channel the phone lists without an importance keeps its row's", () => {
  const plan = channelPlan(reachableCategories(false), [{ id: "research_done" }])
  assert.equal(plan.find((channel) => channel.id === "research_done").importance, 3)
})

test("a list never sent is sent, and a list already told is not", () => {
  assert.equal(changedList(undefined, all), all.join(), "nothing sent yet, so the live list goes")
  assert.equal(
    changedList(all.join(), all),
    undefined,
    "a resume that changed nothing costs no call",
  )
  assert.equal(
    changedList(all.slice(0, 5).join(), all),
    all.join(),
    "a device carrying an older subset is told the live one",
  )
})

test("a phone that lost a channel is told, and the list it now has is what is kept", () => {
  const after = all.filter((id) => id !== "code_run_done")
  assert.equal(changedList(all.join(), after), after.join(), "one channel switched off is a change")
  assert.equal(changedList(after.join(), after), undefined, "and telling it once is enough")
})

test("with notifications off the empty list is still a change, told once", () => {
  assert.equal(changedList(undefined, []), "", "an empty list is news, not silence")
  assert.equal(changedList(all.join(), []), "", "the phone switched everything off")
  assert.equal(changedList("", []), undefined, "and repeating it says nothing new")
  assert.equal(changedList("", all), all.join(), "turning them back on is a change again")
})

test("syncCategories asks the rule first, and patches only what is news", () => {
  const sync = body("syncCategories")
  assert.ok(sync, "syncCategories is in push.ts")
  const asked = sync.indexOf("changedList(sentCategories, categories)")
  const patched = sync.indexOf('"PATCH"')
  assert.ok(asked >= 0, "it asks the rule whether this list is news")
  assert.ok(patched > asked, "and patches the device only when it is")
  assert.match(
    sync,
    /if \(wire !== undefined\)/,
    "an empty list is still a list: only one never told is skipped",
  )
  assert.doesNotMatch(
    sync,
    /"POST"/,
    "a PATCH needs only the device id: with notifications off no token arrives",
  )
})

test("a pass landing inside a PATCH is told once the call settles, not dropped", () => {
  const sync = body("syncCategories")
  assert.ok(sync, "syncCategories is in push.ts")
  assert.match(sync, /parked = read \?\? parked/, "its read is parked while a call is out")
  assert.match(sync, /if \(patching\) return patching/, "and no second call is started beside it")
  const drained = sync.indexOf("while (parked)")
  const sent = sync.indexOf('"PATCH"')
  assert.ok(
    drained >= 0 && drained < sent,
    "the parked slot is drained in a loop, one PATCH per read",
  )
  assert.match(
    sync,
    /if \(parked\) void syncCategories\(device\)/,
    "a read that landed as the last call settled starts a drain of its own",
  )
})

test("one call records what the registry was told", () => {
  const tell = body("tellRegistry")
  assert.ok(tell, "tellRegistry is in push.ts")
  const refused = tell.indexOf("!response.ok")
  const kept = tell.indexOf("sentCategories = wire")
  assert.ok(refused >= 0, "a refusal is thrown")
  assert.ok(
    kept > refused,
    "and the wire form is kept only once the call answered, so a failure is asked again",
  )
  for (const name of ["sendToken", "syncCategories"]) {
    assert.match(body(name), /tellRegistry\(/, `${name} registers through it, not around it`)
    assert.doesNotMatch(body(name), /sentCategories =/, `${name} keeps no copy of the record`)
  }
})

test("a pass reads the phone once, through one read", () => {
  const asks = body("readPhone")
  assert.ok(asks, "readPhone is in push.ts")
  assert.match(asks, /checkPermissions/, "the permission is read there")
  assert.match(asks, /listChannels/, "with the channel list, in the same read")
  // A pass, the switch's own state, and the tap that asks for the permission: no fourth reader.
  const elsewhere = read("push.ts")
    .replace(asks, "")
    .replace(body("useNativePermission"), "")
    .replace(body("enableNative"), "")
  assert.doesNotMatch(elsewhere, /checkPermissions/, "nothing else asks the phone again")
})

test("the channels are written once a launch, and again only when Meetings flips", () => {
  const writes = body("provisionChannels")
  assert.ok(writes, "provisionChannels is in push.ts")
  assert.match(
    writes,
    /if \(provisionedFor === meetings\) return provisioned/,
    "a pass under the same flag reuses the launch's write",
  )
  assert.match(
    writes,
    /provisionedFor = meetings/,
    "the flag it wrote for is kept, so flipping it is not answered with the old channels",
  )
  assert.match(
    writes,
    /channelPlan\(reachableCategories\(meetings\), held\)/,
    "only the categories this launch can reach, at the importance the phone reported",
  )
  assert.match(
    writes,
    /if \(legacyDeleted\) return/,
    "and the legacy channel is deleted once a launch, however often the write runs",
  )
  const pass = body("syncNative")
  assert.ok(pass, "syncNative is in push.ts")
  assert.match(
    pass,
    /if \(read\.allowed\) \{[\s\S]*provisionChannels/,
    "a phone that cannot notify is given none",
  )
  assert.doesNotMatch(body("listen"), /createChannel/, "registering listeners writes no channel")
})

test("the three-second pass reads the phone when it fires, not when the pass began", () => {
  const soon = body("soonCategories")
  assert.ok(soon, "soonCategories is in push.ts")
  assert.match(
    soon,
    /read: \(\) => Promise<PhoneRead>/,
    "a pass hands over its read, not its answer",
  )
  const armed = soon.indexOf("setTimeout")
  assert.ok(
    soon.indexOf("clearTimeout") < armed,
    "one timer: the newest pass replaces the one waiting",
  )
  assert.ok(
    soon.indexOf("read()") > armed,
    "and the phone is read inside the callback, three seconds after the pass",
  )
  assert.match(
    body("syncNative"),
    /soonCategories\(fcm\.device, \(\) => readPhone\(push\)\)/,
    "a pass's own read is what it hands over",
  )
})

test("the registration carries the phone's list, not the app's stored preferences", () => {
  for (const name of ["sendToken", "syncCategories"]) {
    assert.ok(body(name), `${name} is in push.ts`)
    assert.doesNotMatch(
      body(name),
      /pushCategories|wantedCategories/,
      `${name} reads the phone, so a stored per-type list has no say on Android`,
    )
  }
})

test("the app's own list is saved on the web alone", () => {
  const set = body("setCategories")
  assert.ok(set, "setCategories is in push.ts")
  assert.match(set, /if \(isNative\) return/, "a phone reads its channels, so it stores no list")
  assert.match(set, /syncPush\(\)/, "the web's bots are told with its subscription")
  assert.doesNotMatch(set, /syncCategories/, "and the phone's registration is never its business")
})
