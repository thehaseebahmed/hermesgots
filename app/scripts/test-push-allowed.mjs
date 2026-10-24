/**
 * What the registry is told this phone still allows. Android owns each type's switch, so the app
 * reads a channel's live importance instead of asking: none means the user switched it off, an id
 * the phone doesn't list has never been made and counts as allowed, and the phone's notifications
 * off altogether is an empty list. A unit test because the rule is pure (`allowedCategories`);
 * listing the phone's channels needs Capacitor.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { PUSH_CATEGORIES, allowedCategories } from "../src/lib/push-kinds.ts"

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
