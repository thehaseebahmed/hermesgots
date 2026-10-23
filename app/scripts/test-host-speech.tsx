import assert from "node:assert/strict"
import test from "node:test"

import { getSpeech, setSpeech } from "@/lib/host-speech"

const config = { baseUrl: "http://host.test:8642/v1", apiKey: "key" }

const answer = {
  model: "small",
  models: [
    {
      name: "small",
      size_mb: 484,
      speed: 6,
      slow_on_cpu: false,
      downloaded: true,
      in_use: true,
      downloading: false,
    },
  ],
  warning: null,
  cleanup: { model: null, allowed: true, reason: null },
}

function host(body: unknown, status = 200) {
  const calls: { path: string; method: string; sent: unknown }[] = []
  globalThis.fetch = (async (input, init) => {
    calls.push({
      path: new URL(String(input)).pathname,
      method: init?.method ?? "GET",
      sent: init?.body ? JSON.parse(String(init.body)) : undefined,
    })
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })
  }) as typeof globalThis.fetch
  return calls
}

test("the read is the host's speech route, and answers the shape the tab draws", async () => {
  const calls = host({ speech: answer })
  const speech = await getSpeech(config)
  assert.match(calls[0].path, /\/api\/plugins\/memento\/speech$/)
  assert.equal(calls[0].method, "GET")
  assert.equal(speech.model, "small")
  assert.equal(speech.models[0].inUse, true)
})

test("a model pick sends only the model", async () => {
  const calls = host({ speech: { ...answer, model: "base" } })
  await setSpeech(config, { model: "base" })
  assert.deepEqual(calls[0].sent, { model: "base" })
})

test("cleanup's pick sends only its own line, and null hands the phrase back to the bot's model", async () => {
  const calls = host({ speech: answer })
  await setSpeech(config, { cleanup_model: { provider: "acme", model: "fast" } })
  await setSpeech(config, { cleanup_model: null })
  assert.deepEqual(calls[0].sent, { cleanup_model: { provider: "acme", model: "fast" } })
  assert.deepEqual(calls[1].sent, { cleanup_model: null })
})

test("a write the host refuses rejects in the host's own words", async () => {
  host({ error: { message: "enormous isn't a speech model this host can use." } }, 400)
  await assert.rejects(
    setSpeech(config, { model: "enormous" }),
    /enormous isn't a speech model this host can use/,
  )
})
