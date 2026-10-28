/** Which Hermes versions the new chat screen works with: 0.22.5 and newer. */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { atLeast, MIN_HERMES } from "../src/chat-next/api.ts"

test("the oldest Hermes it works with is the one that shares a run's events", () => {
  assert.equal(MIN_HERMES, "0.22.5")
})

test("the plugin asks Hermes for the same floor, so it never loads where the chat can't run", () => {
  const manifest = readFileSync(new URL("../../plugin/plugin.yaml", import.meta.url), "utf8")
  assert.equal(/^requires_hermes:\s*"([^"]*)"/m.exec(manifest)?.[1], `>=${MIN_HERMES}`)
})

test("0.22.5 and anything newer is supported", () => {
  for (const version of [
    "0.22.5",
    "0.22.6",
    "0.22.10",
    "0.23.0",
    "0.100.0",
    "1.0.0",
    "v0.22.5",
    "0.22.5-rc1",
    "0.22.5+build.7",
  ])
    assert.equal(atLeast(version), true, version)
})

test("anything older is not", () => {
  for (const version of ["0.21.5", "0.22.4", "0.22.0", "0.9.9", "0.0.1", "0.22"])
    assert.equal(atLeast(version), false, version)
})

test("a version it can't read is not supported", () => {
  for (const version of ["", "latest", "unknown", "x.y.z"])
    assert.equal(atLeast(version), false, version)
})

test("versions compare by number, not as text", () => {
  assert.equal(atLeast("0.22.10", "0.22.9"), true, "ten is more than nine")
  assert.equal(atLeast("0.9.0", "0.22.5"), false, "nine is less than twenty-two")
})
