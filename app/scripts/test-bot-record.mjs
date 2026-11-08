import assert from "node:assert/strict"
import test from "node:test"

import { botFields } from "../src/lib/bot-record.ts"

const sealed = {
  name: "Gots",
  profile: "gots",
  baseUrl: "http://host.example:8642",
  apiKey: "k",
}

test("a bot keeps the Hermes profile name it answers as", () => {
  assert.equal(botFields({ enabled: true }, sealed).hermesProfile, "gots")
})

test("a bot the registry turned off is off here too, and one it left on carries no switch", () => {
  assert.equal(botFields({ enabled: false }, sealed).disabled, true)
  assert.equal(botFields({ enabled: true }, sealed).disabled, undefined)
})

test("its last check-in is the registry's, never this device's clock", () => {
  assert.equal(botFields({ enabled: true, seen: { at: 1700 } }, sealed).seenAt, 1700)
})

test("the plugin version is the one its host reported, or the sealed one it came with", () => {
  assert.equal(
    botFields({ enabled: true, seen: { at: 1, pluginVersion: "2.0" } }, sealed).pluginVersion,
    "2.0",
  )
  assert.equal(
    botFields({ enabled: true, seen: { at: 1 } }, { ...sealed, pluginVersion: "1.0" }).pluginVersion,
    "1.0",
  )
})

test("a record sealed with no profile name says nothing about it", () => {
  // A bot that has one keeps it: the read carried no name rather than an empty one.
  assert.equal("hermesProfile" in botFields({ enabled: true }, { ...sealed, profile: "" }), false)
})
