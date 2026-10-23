import assert from "node:assert/strict"
import test from "node:test"

import { startDictationTake } from "@/lib/hermes"

const config = { baseUrl: "http://host.test:8642/v1", apiKey: "test-key" } as never

function host() {
  const calls: { path: string; body: unknown }[] = []
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      path: new URL(String(input)).pathname,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    })
    return new Response(JSON.stringify({ take: "dt_1", ready: true }), {
      headers: { "content-type": "application/json" },
    })
  }
  globalThis.fetch = fetch as unknown as typeof globalThis.fetch
  return calls
}

test("a bot's words ride on the call that opens its take", async () => {
  const calls = host()
  await startDictationTake(config, "Gots, the chat", ["Gots", "Haseeb"])
  assert.equal(calls.length, 1, "one request, the start")
  assert.match(calls[0].path, /\/dictation\/take$/)
  assert.deepEqual(calls[0].body, { hint: "Gots, the chat", vocabulary: ["Gots", "Haseeb"] })
})

test("a bot with no words sends the call it always sent", async () => {
  const calls = host()
  await startDictationTake(config, "Gots, the chat", [])
  assert.deepEqual(calls[0].body, { hint: "Gots, the chat" })
})
