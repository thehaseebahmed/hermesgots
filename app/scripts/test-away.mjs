import assert from "node:assert/strict"
import test from "node:test"

import { AWAY_SEND_MS, awayLine, sendTimeoutMs } from "../src/lib/away.ts"

const READ = 15_000

test("the header says nothing while the host answers", () => {
  assert.equal(awayLine(false, true), undefined)
  assert.equal(awayLine(false, false), undefined)
})

test("a device with a network names the host, one without names itself", () => {
  assert.equal(awayLine(true, true), "This host isn't answering")
  assert.equal(awayLine(true, false), "You're offline")
})

test("a send while away is given a breath, and the reads' own wait otherwise", () => {
  assert.equal(sendTimeoutMs(true, READ), AWAY_SEND_MS)
  assert.ok(AWAY_SEND_MS < READ, "shorter than a read waits")
  assert.ok(AWAY_SEND_MS >= 1_000, "long enough for a host that has come back")
  assert.equal(sendTimeoutMs(false, READ), READ)
})

test("a read timeout shorter than the short one is never stretched by it", () => {
  assert.equal(sendTimeoutMs(true, 1_500), 1_500)
})
