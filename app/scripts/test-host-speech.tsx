import assert from "node:assert/strict"
import test from "node:test"

import { db } from "@/lib/db"
import { getSpeech, probeSpeech, rememberSpeech, setSpeech } from "@/lib/host-speech"
import { botProfile } from "./component-kit.tsx"

const config = { baseUrl: "http://host.test:8642/v1", apiKey: "key" }

const answer = {
  model: "small",
  models: [
    {
      name: "small",
      size_mb: 484,
      measured: { realtime: 3.2, at: "2026-11-02T09:00:00Z" },
      keeps_up: true,
      recommended: true,
      downloaded: true,
      in_use: true,
      downloading: false,
    },
  ],
  probe: { owed: false, measured: 1, recommended: "small", elsewhere: null, reason: null, at: null },
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

test("a probe is the host's own route, and answers the record its rows are drawn from", async () => {
  const calls = host({ speech: answer })
  const probed = await probeSpeech(config)
  assert.match(calls[0].path, /\/api\/plugins\/memento\/speech\/probe$/)
  assert.equal(calls[0].method, "POST")
  assert.equal(calls[0].sent, undefined, "a probe carries nothing: the host decides what it hears")
  assert.equal(probed.models[0].measured?.realtime, 3.2)
  assert.equal(probed.models[0].recommended, true)
})

test("a probe the host refuses rejects in the host's own words", async () => {
  host({ error: { message: "This host is hearing a take right now." } }, 409)
  await assert.rejects(probeSpeech(config), /hearing a take right now/)
})

test("a read keeps the model on the bot without moving the bot's clock", async () => {
  await db.profiles.clear()
  const profile = botProfile("clock")
  await db.profiles.put({ ...profile, updatedAt: 1000 })

  await rememberSpeech(profile.id, "small")

  const kept = await db.profiles.get(profile.id)
  assert.equal(kept?.speechModel, "small", "the next screen draws what the host last reported")
  // The bot's own clock is what decides which device's copy wins, and a read is no claim on it: it
  // would otherwise let a screen that was merely opened beat a rename made on another device.
  assert.equal(kept?.updatedAt, 1000, "and the bot's own clock is where the user left it")

  await rememberSpeech(profile.id, "small")
  assert.equal((await db.profiles.get(profile.id))?.updatedAt, 1000, "nor on a second read")
})
