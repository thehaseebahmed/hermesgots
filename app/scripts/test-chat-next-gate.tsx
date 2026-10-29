/**
 * The new chat screen asks the host nothing about its version (the plugin's manifest holds it to
 * Hermes 0.22.5). A host that can't be reached is away, which the thread says and the chat survives.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { fakeHost } from "./chat-next-host.ts"
import { eventually, openDevice, showsEverything, turn, withDevice } from "./chat-next-devices.tsx"

test("a host that can't be reached is away, not unsupported: the device draws what it holds", async () => {
  const host = fakeHost("memento-gate-away", { plugin: true })
  const first = await openDevice(host)
  await turn(first, host, "one", "First.")
  await first.close()

  const answer = globalThis.fetch
  globalThis.fetch = (async () => {
    throw new TypeError("Failed to fetch")
  }) as typeof fetch
  try {
    await withDevice(openDevice(host, { database: first.database }), async (again) => {
      assert.equal(again.away(), true)
      await showsEverything(again, host, "the chat as this device last saw it")
      assert.equal(again.composer(), false, "nothing can be sent to a host that isn't there")

      globalThis.fetch = answer
      await eventually(() => assert.equal(again.away(), false), "the host is read again")
      assert.equal(again.composer(), true)
      await showsEverything(again, host, "and the chat goes on from the host")
    })
  } finally {
    globalThis.fetch = answer
  }
})
