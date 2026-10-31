/**
 * The new chat screen asks the host nothing about its version (the plugin's manifest holds it to
 * Hermes 0.22.5). A host that can't be reached is away, which is the chat header's word and not the
 * thread's: the device draws what it holds, the composer stays, and a message sent into that host
 * keeps its place in the thread until the user asks for it again (ADR 0071).
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
      await showsEverything(again, host, "the chat as this device last saw it")
      assert.equal(again.catching(), false, "and it does not say it is catching up")
      assert.equal(again.away(), false, "and draws nothing about the host being away")
      assert.equal(again.composer(), true, "the composer stays while the host is away")

      await again.send("still here")
      await eventually(
        () =>
          assert.deepEqual(
            again.unsent().map(({ text, state, retry, cancel }) => ({ text, state, retry, cancel })),
            [{ text: "still here", state: "Not sent", retry: true, cancel: true }],
          ),
        "the message it couldn't send to be kept in the thread",
      )
      assert.equal(again.draft(), "", "and not handed back to the field")
      const asked = host.asked.runs
      await showsEverything(again, host, "the chat is still the one the device holds")

      globalThis.fetch = answer
      await eventually(() => assert.equal(again.catching(), false), "the host to be read again")
      assert.deepEqual(
        again.unsent().map((row) => row.text),
        ["still here"],
        "and the message waits for the user",
      )
      assert.equal(host.asked.runs, asked, "no run was started for it")
      await showsEverything(again, host, "and the chat goes on from the host")

      await again.retry("still here")
      await eventually(() => assert.deepEqual(again.unsent(), []), "the row to leave on Retry")
      host.latest.run?.finish("Sent again.")
      await showsEverything(again, host, "the retried message, drawn by its own turn")
    })
  } finally {
    globalThis.fetch = answer
  }
})
