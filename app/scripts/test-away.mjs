import assert from "node:assert/strict"
import test from "node:test"

import { AWAY_SEND_MS, awayLine, readPace, sendTimeoutMs } from "../src/lib/away.ts"
import { CHAT_IDLE_MS, CHAT_POLL_MS, READ_TIMEOUT_MS, SAFETY_MS } from "../src/lib/freshness.ts"

const READ = READ_TIMEOUT_MS

/**
 * The paces the page keeps: its own two, which `freshness.ts` owns with every other interval, and
 * the net an open stream leaves it.
 */
const PACES = { pollMs: CHAT_POLL_MS, idleMs: CHAT_IDLE_MS, safetyMs: SAFETY_MS }
/** The state of a page that is answering, with whatever the case under test changes. */
const page = (over) => ({ busy: false, misses: 0, streamOpen: false, ...over })

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

test("a host that has just missed a read is read as fast as a busy page, stream or not", () => {
  for (const streamOpen of [false, true])
    assert.equal(
      readPace(page({ misses: 1, streamOpen }), PACES),
      PACES.pollMs,
      `an open stream must not leave the away words waiting (streamOpen: ${streamOpen})`,
    )
})

test("a host that keeps not answering is asked again more slowly, down to the idle pace", () => {
  const pace = (misses) => readPace(page({ misses }), PACES)
  assert.deepEqual(
    [1, 2, 3].map(pace),
    [PACES.pollMs, PACES.pollMs * 2, PACES.pollMs * 4],
    "the first retry is the quick one, and each miss after it waits longer",
  )
  assert.equal(pace(4), PACES.idleMs, "capped at the pace an idle page keeps anyway")
  assert.equal(pace(50), PACES.idleMs, "and it stays there however long the host is gone")
})

test("a host that is answering keeps the pace it had", () => {
  assert.equal(readPace(page({ busy: true }), PACES), PACES.pollMs, "a turn in flight reads fast")
  assert.equal(readPace(page({}), PACES), PACES.idleMs, "an idle page without a stream, slowly")
  assert.equal(
    readPace(page({ streamOpen: true }), PACES),
    Math.max(PACES.idleMs, PACES.safetyMs),
    "and behind a stream the timer is only the net under it",
  )
})
