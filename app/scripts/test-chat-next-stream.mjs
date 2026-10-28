/**
 * The stream parser against the bytes two real Hermes versions sent: v0.21.5 numbers nothing, and
 * v0.22.5 puts an `id:` and a `seq` from 0 on every event, `tool_call_id` on its calls, and sends
 * every subscriber all of it (`fixtures/multi-reader.events.sse` is a second follower joining
 * late). Frames are cut at awkward sizes, since a network never hands them over whole.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { followRun } from "../src/chat-next/api.ts"

const recorded = (name) =>
  readFileSync(new URL(`../src/chat-next/fixtures/${name}`, import.meta.url), "utf8")

/** Serves `text` as an event stream, `size` bytes at a time. */
function serve(text, size) {
  const bytes = new TextEncoder().encode(text)
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          for (let at = 0; at < bytes.length; at += size)
            controller.enqueue(bytes.slice(at, at + size))
          controller.close()
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    )
}

async function read(name, size = 1 << 20) {
  serve(recorded(name), size)
  const events = []
  await followRun({ server: "http://hermes.test", key: "k" }, "run", (event) => events.push(event))
  return events
}

test("v0.21.5's stream is read whole and carries no numbers", async () => {
  const events = await read("echo-run.events.sse")
  assert.deepEqual(
    events.map((event) => event.event),
    [
      "tool.started",
      "tool.completed",
      "message.delta",
      "message.delta",
      "reasoning.available",
      "run.completed",
    ],
  )
  assert.ok(
    events.every((event) => event.seq === undefined),
    "nothing is numbered",
  )
})

test("v0.22.5's stream is read whole, every event numbered from 0 with the call it belongs to", async () => {
  const events = await read("multi-reader.events.sse")
  assert.deepEqual(
    events.map((event) => event.seq),
    Array.from({ length: events.length }, (_, at) => at),
    "numbered from 0 with no gap",
  )
  assert.equal(events.at(-1).event, "run.completed", "a late follower is given the ending too")
  const calls = events.filter((event) => event.event.startsWith("tool."))
  assert.ok(calls.length >= 8, "four calls, each started and completed")
  assert.ok(
    calls.every((event) => event.tool_call_id),
    "every call event names its call",
  )
})

for (const size of [1, 7, 64]) {
  test(`both streams read the same in pieces of ${size} bytes`, async () => {
    for (const name of ["echo-run.events.sse", "multi-reader.events.sse"])
      assert.deepEqual(await read(name, size), await read(name), name)
  })
}
