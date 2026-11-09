/**
 * The Stop press answers for a while and then gives Send back (ADR 0085). How it is answered rather
 * than whether: the answer waits one reading of the session's children, and a reading that lands
 * while it waits must not push it further out — a press whose children ended was being pinned for
 * another fifteen seconds by every stale "still running" that arrived after them.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { useState } from "react"
import { act } from "react"

import { Composer } from "@/components/chat/composer"

import { click, connection, find, missing, mount, until } from "./component-kit.tsx"

const bot = connection("composer-stop-press")

/** The children count as the screen reads it, so the test can land a reading when it chooses. */
const readings = { set: (_count: number) => {} }

function Harness() {
  const [count, set] = useState(1)
  readings.set = set
  return (
    <Composer
      busy={false}
      subagentsRunning={count}
      onSend={() => {}}
      onQueue={() => {}}
      onStop={() => true}
      onCommand={() => {}}
      connection={bot}
    />
  )
}

const read = (count: number) => act(async () => readings.set(count))
const waited = () => new Promise((resolve) => setTimeout(resolve, 1_200))

test("a reading that lands after the children end does not push the answer out again", async () => {
  await mount(<Harness />, async () => {
    const stop = find('button[aria-label="Stop"]')
    assert.ok(stop, "the composer offers Stop while children work")
    await click(stop)
    await until(() => Boolean(find('button[aria-label="Stopping"]')), "the press is answered")

    // The children end, so this reading is the quiet one: one read of quiet is what is believed.
    await read(0)
    const quiet = Date.now()
    // One that began before they ended lands a moment later, still saying a child runs.
    await waited()
    await read(1)

    // The button is Stop again because a child is reported running: a fresh press, not a stale answer.
    await until(
      () => Boolean(find('button[aria-label="Stop"]')),
      "the press stops being the answer",
      Date.now() - quiet + 6_000,
    )
    const answered = Date.now() - quiet
    assert.ok(missing('button[aria-label="Stopping"]'), "the answer is over")
    assert.ok(answered < 6_000, `the answer ended ${answered}ms after the quiet reading`)
  })
})
