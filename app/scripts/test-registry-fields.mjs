/**
 * The fields a registry read writes on a bot, and the one rule that is easy to get wrong: a record
 * sealed before the plugin sent its profile name must write nothing there, since an undefined write
 * is a delete.
 *
 * Run: node --test scripts/test-registry-fields.mjs
 */
import assert from "node:assert/strict"
import test from "node:test"

import { localFields } from "../src/lib/registry-fields.ts"

test("a record's profile is the bot's Hermes profile", () => {
  assert.equal(localFields({ enabled: true }, { profile: "coder" }).hermesProfile, "coder")
})

test("a record sealed without one writes no key at all, rather than deleting the name", () => {
  const local = localFields({ enabled: true }, {})
  assert.equal("hermesProfile" in local, false)
})

test("the host's own flags ride with it, the check-in's version winning", () => {
  assert.deepEqual(
    localFields({ enabled: false, seen: { at: 5, pluginVersion: "0.90" } }, { pluginVersion: "0.80" }),
    { disabled: true, seenAt: 5, pluginVersion: "0.90" },
  )
})
