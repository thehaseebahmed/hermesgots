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

test("the host's own flag rides with it, and the sealed record's version is the only one", () => {
  assert.deepEqual(localFields({ enabled: false }, { pluginVersion: "0.80" }), {
    disabled: true,
    pluginVersion: "0.80",
  })
})

test("a read writes nothing about when the host was heard: presence is the pass's answer", () => {
  const local = localFields({ enabled: true }, {})
  assert.equal("seenAt" in local, false, "no timestamp of the account's, ever")
})
