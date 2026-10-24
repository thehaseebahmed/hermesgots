/**
 * What the registry is told this phone still allows. Android owns each type's switch, so the app
 * reads a channel's live importance instead of asking: none means the user switched it off, an id
 * the phone doesn't list has never been made and counts as allowed, and the phone's notifications
 * off altogether is an empty list — and whether a list is news at all, so only a change is sent
 * again. A unit test because the rules are pure (`allowedCategories`, `categoriesChanged`); listing
 * the phone's channels needs Capacitor.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { PUSH_CATEGORIES, allowedCategories, categoriesChanged } from "../src/lib/push-kinds.ts"

/** The rule answers with ids, so the expected lists are the ids in the order the list keeps. */
const all = PUSH_CATEGORIES.map((category) => category.id)
/** A phone that has made every channel and left it alone: Android's importance 2, 3 or 4. */
const healthy = PUSH_CATEGORIES.map(({ id, importance }) => ({ id, importance }))

test("a channel switched off in Android's settings is left out", () => {
  const channels = healthy.map((channel) =>
    channel.id === "code_run_done" ? { ...channel, importance: 0 } : channel,
  )
  assert.deepEqual(
    allowedCategories({ allowed: true, channels }),
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
    allowedCategories({ allowed: true, channels }),
    all.filter((id) => !off.includes(id)),
  )
})

test("a channel the phone doesn't list counts as allowed", () => {
  assert.deepEqual(
    allowedCategories({ allowed: true, channels: [] }),
    all,
    "a first launch has made no channel it can read, and must still register the full list",
  )
  // A phone that lists some of them: the ones it hasn't made are allowed, the rest by importance.
  assert.deepEqual(
    allowedCategories({
      allowed: true,
      channels: [
        { id: "chat_input", importance: 4 },
        { id: "code_input", importance: 0 },
      ],
    }),
    all.filter((id) => id !== "code_input"),
  )
})

test("a healthy phone allows every type, in the order the list keeps", () => {
  const allowed = allowedCategories({ allowed: true, channels: healthy })
  assert.deepEqual(allowed, all)
  assert.equal(allowed.length, PUSH_CATEGORIES.length, "the sixteen stay sixteen")
})

test("with the phone's notifications off the registration carries an empty list", () => {
  assert.deepEqual(
    allowedCategories({ allowed: false, channels: healthy }),
    [],
    "not a deleted device, and not a list that would keep sending",
  )
})

test("an importance the phone doesn't report is a channel the user left alone", () => {
  const channels = healthy.map(({ id }) => ({ id }))
  assert.deepEqual(
    allowedCategories({ allowed: true, channels }),
    all,
    "a plugin that answers without importance must not silence anything",
  )
})

/** `allowedCategories` is a rule; the wiring around it is text. These pin what the ticket changes. */
const push = readFileSync(new URL("../src/lib/push.ts", import.meta.url), "utf8")
const body = (name) =>
  push.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\)[\\s\\S]*?\\n\\}`))?.[0] ?? ""

/**
 * Only a change is sent again: the registry filters by the list a device last sent, so a list that
 * reads the same must cost no call, while a device carrying an older one is told the live one on
 * its first resume.
 */
test("a list never sent is sent, and a list already told is not", () => {
  assert.equal(categoriesChanged(undefined, all), true, "nothing sent yet, so the live list goes")
  assert.equal(
    categoriesChanged(all.join(), all),
    false,
    "a resume that changed nothing costs no call",
  )
  assert.equal(
    categoriesChanged(all.slice(0, 5).join(), all),
    true,
    "a device carrying an older subset is told the live one",
  )
})

test("a phone that lost a channel is told, and the list it now has is what is kept", () => {
  const after = all.filter((id) => id !== "code_run_done")
  assert.equal(categoriesChanged(all.join(), after), true, "one channel switched off is a change")
  assert.equal(categoriesChanged(after.join(), after), false, "and telling it once is enough")
})

test("with notifications off the empty list is still a change, told once", () => {
  assert.equal(categoriesChanged(undefined, []), true, "an empty list is news, not silence")
  assert.equal(categoriesChanged(all.join(), []), true, "the phone switched everything off")
  assert.equal(categoriesChanged([].join(), []), false, "and repeating it says nothing new")
  assert.equal(categoriesChanged([].join(), all), true, "turning them back on is a change again")
})

test("syncCategories sends only a changed list, before it patches, and records what it sent", () => {
  const sync = body("syncCategories")
  assert.ok(sync, "syncCategories is in push.ts")
  const checked = sync.indexOf("categoriesChanged(sentCategories, categories)")
  const patched = sync.indexOf('"PATCH"')
  const recorded = sync.lastIndexOf("sentCategories = categories.join()")
  assert.ok(checked >= 0, "it asks the rule whether this list is news")
  assert.ok(patched >= 0, "and patches the device when it is")
  assert.ok(recorded >= 0, "then records the list the registry now has")
  assert.ok(checked < patched, "the check comes first, so the same list never patches twice")
  assert.ok(patched < recorded, "and the record is of the list that got through")
  assert.doesNotMatch(
    sync,
    /"POST"/,
    "a PATCH needs only the device id: with notifications off no token arrives",
  )
})

test("sendToken records the list a registered token carried", () => {
  const send = body("sendToken")
  assert.ok(send, "sendToken is in push.ts")
  const posted = send.indexOf('"POST"')
  const recorded = send.indexOf("sentCategories = categories.join()")
  assert.ok(posted >= 0, "registering a token posts the device")
  assert.ok(recorded > posted, "and leaves behind the list it sent, so a resume doesn't repeat it")
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

test("the web's per-type writer no longer tells the registry on a phone", () => {
  assert.ok(body("setCategories"), "setCategories is in push.ts")
  assert.doesNotMatch(
    body("setCategories"),
    /syncCategories/,
    "the in-app list is the web's switch only",
  )
})
