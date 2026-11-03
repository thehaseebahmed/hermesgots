import assert from "node:assert/strict"
import test from "node:test"

import { clearAllData, db, deleteProfile } from "@/lib/db"
import { cachedSpeech, getSpeech, probeSpeech, setSpeech } from "@/lib/host-speech"
import { connectionKey } from "@/lib/connection"
import { botProfile, connection } from "./component-kit.tsx"

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

test("a read keeps the host's whole answer on this device, keyed by the connection it came from", async () => {
  await db.speechCache.clear()
  host({ speech: answer })
  await getSpeech(config)

  const kept = await db.speechCache.get(connectionKey(config))
  assert.equal(kept?.speech.model, "small", "the answer a page opens on before its own read lands")
  assert.equal(
    kept?.speech.models[0]?.inUse,
    true,
    "the model list and everything else the page draws, not the name alone",
  )
  assert.equal(
    await cachedSpeech(connectionKey(config)).then((one) => one?.model),
    "small",
    "and one reader answers it",
  )

  // A write is an answer too: the host states the block it now holds, and the device keeps it.
  host({ speech: { ...answer, model: "base" } })
  await setSpeech(config, { model: "base" })
  assert.equal(
    (await cachedSpeech(connectionKey(config)))?.model,
    "base",
    "a successful write replaces the copy",
  )

  // A failed read keeps what was there: the page draws the older answer rather than nothing.
  host({ error: { message: "No speech here." } }, 500)
  await assert.rejects(getSpeech(config))
  assert.equal((await cachedSpeech(connectionKey(config)))?.model, "base", "a failed read keeps it")
})

test("a bot's copy of its host's answer goes with the bot, and a clear leaves none", async () => {
  const server = connection("dropped")
  const profile = botProfile("dropped")
  await db.profiles.clear()
  await db.speechCache.clear()
  await db.profiles.put(profile)
  host({ speech: answer })
  await getSpeech(server)
  assert.ok(await db.speechCache.get(connectionKey(server)), "the answer this device read")

  await deleteProfile(profile.id, { last: true })
  assert.equal(await db.speechCache.count(), 0, "goes with the bot it belongs to")

  await getSpeech(server)
  await clearAllData()
  assert.equal(await db.speechCache.count(), 0, "and Clear local data leaves no copy behind")
})
