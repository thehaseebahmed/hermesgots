/**
 * The retry seam on its own: `useReadAttempt` is what a bot tab's read is keyed on, what says whether
 * the last read threw, and what settles the promise a tap waits on — when that read lands, or when
 * the screen that asked for it goes away or asks about something else. A read torn down mid-flight is
 * the case no screen can show (the page it was reading for is replaced by its loader), so the seam is
 * read here, where the effect's teardown is the whole of it.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { useState } from "react"

import { useReadAttempt } from "@/lib/read-attempt"
import { click, find, mount, settle } from "./component-kit.tsx"

const probe: { api?: ReturnType<typeof useReadAttempt>; next?: () => void } = {}

function ReadAttemptProbe() {
  probe.api = useReadAttempt()
  return null
}

test("a retry's promise settles when its read is torn down", async () => {
  probe.api = undefined
  const settled: string[] = []
  await mount(<ReadAttemptProbe />, async () => {
    assert.equal(probe.api?.retry, undefined, "a read that has not thrown offers no retry")

    probe.api!.landedThrew()
    await settle()
    const tap = probe.api!.retry
    assert.ok(tap, "a read that threw offers the same read again")

    void tap().then(() => settled.push("settled"))
    await settle()
    assert.deepEqual(settled, [], "and the tap waits on the read it asked for")
  })

  await settle()
  assert.deepEqual(
    settled,
    ["settled"],
    "the teardown settles it, so the control can never be left waiting for good",
  )
})

/** A read of one thing, then of another: what a sheet does when the next server is opened. */
function ChangingProbe() {
  const [readFor, setReadFor] = useState("first")
  probe.api = useReadAttempt(readFor)
  probe.next = () => setReadFor("second")
  return (
    <button type="button" onClick={() => setReadFor("second")}>
      another
    </button>
  )
}

test("a read about something else starts with nothing to retry", async () => {
  probe.api = undefined
  const settled: string[] = []
  await mount(<ChangingProbe />, async () => {
    probe.api!.landedThrew()
    await settle()
    const tap = probe.api!.retry
    assert.ok(tap, "the first read's refusal is one that can be asked again")
    void tap().then(() => settled.push("settled"))

    await click(find("button"))
    await settle()
    assert.equal(probe.api?.retry, undefined, "and the next thing read offers nothing to retry")
    assert.deepEqual(settled, ["settled"], "while the tap that was waiting is let go")
  })
})
