import assert from "node:assert/strict"
import test from "node:test"

import {
  CLEANUP_LEVEL_ROWS,
  heardLine,
  marked,
  modelSize,
  modelSpeed,
  readSpeech,
} from "../src/lib/speech.ts"

const settings = {
  model: "small",
  models: [
    {
      name: "base",
      size_mb: 145,
      speed: 16,
      slow_on_cpu: false,
      downloaded: true,
      in_use: false,
      downloading: false,
    },
    {
      name: "small",
      size_mb: 484,
      speed: 6,
      slow_on_cpu: false,
      downloaded: false,
      in_use: true,
      downloading: true,
    },
    {
      name: "large-v3",
      size_mb: 3090,
      speed: 0.6,
      slow_on_cpu: true,
      downloaded: false,
      in_use: false,
      downloading: false,
    },
  ],
  cleanup: { model: null, allowed: true, reason: null, level: "light" },
  hearing: { sent: false },
}

test("a host's answer reads back as the tab draws it", () => {
  const speech = readSpeech(settings)
  assert.equal(speech.model, "small")
  assert.deepEqual(
    speech.models.map((row) => [row.name, row.inUse, row.downloaded]),
    [
      ["base", false, true],
      ["small", true, false],
      ["large-v3", false, false],
    ],
  )
  assert.equal(speech.cleanup.allowed, true)
  assert.equal(speech.cleanup.model, null)
  assert.equal(speech.cleanup.level, "light")
  assert.equal(speech.hearing.sent, false)
})

test("the level and the Hearing prompt read back as the host stored them", () => {
  const speech = readSpeech({
    ...settings,
    cleanup: { model: null, allowed: true, reason: null, level: "high" },
    hearing: { sent: true },
  })
  assert.equal(speech.cleanup.level, "high")
  assert.equal(speech.hearing.sent, true)
  assert.equal(
    readSpeech({ ...settings, cleanup: { level: "loud" } }).cleanup.level,
    "light",
    "a level that is not one of the four reads as the default",
  )
})

test("the four level cards are in order, each with the same sentence tidied at it", () => {
  assert.deepEqual(
    CLEANUP_LEVEL_ROWS.map((row) => [row.level, row.name]),
    [
      ["none", "None"],
      ["light", "Light"],
      ["medium", "Medium"],
      ["high", "High"],
    ],
  )
  for (const row of CLEANUP_LEVEL_ROWS) {
    assert.ok(row.purpose.length > 10, `${row.level} says what it changes`)
    assert.ok(row.sample.length > 40, `${row.level} shows the sentence at its level`)
  }
})

test("a plugin that sends less than the tab knows about is read forgivingly", () => {
  assert.deepEqual(readSpeech(null), {
    model: "",
    models: [],
    cleanup: { model: null, allowed: false, reason: null, level: "light" },
    hearing: { sent: false },
  })
  const bare = readSpeech({ models: [{ name: "base" }, { size: 3 }] })
  assert.deepEqual(bare.models, [
    {
      name: "base",
      sizeMb: null,
      speed: null,
      slowOnCpu: false,
      downloaded: false,
      inUse: false,
      downloading: false,
    },
  ])
})

test("the cleanup pick is a provider and model, or the bot's own", () => {
  assert.deepEqual(
    readSpeech({ ...settings, cleanup: { model: { provider: "acme", model: "fast" }, allowed: true } })
      .cleanup.model,
    { provider: "acme", model: "fast" },
  )
  const half = readSpeech({ ...settings, cleanup: { model: { provider: "acme" }, allowed: true } })
  assert.equal(half.cleanup.model, null, "half a pick is no pick")
})

test("a size is the download in the units it is read in", () => {
  assert.equal(modelSize(145), "145 MB")
  assert.equal(modelSize(3090), "3.0 GB")
  assert.equal(modelSize(null), "")
})

test("a speed says how many seconds of speech a second hears", () => {
  assert.equal(modelSpeed(16), "16× realtime")
  assert.equal(modelSpeed(0.6), "0.6× realtime")
  assert.equal(modelSpeed(2.0), "2× realtime")
  assert.equal(modelSpeed(null), "")
})

test("a row says in use before it says slow, and a download before either", () => {
  const [base, small, large] = readSpeech(settings).models
  assert.equal(marked(small), "In use · downloads on the next take")
  assert.equal(marked({ ...small, downloading: false }), "In use")
  assert.equal(marked(large), "Too slow on a CPU")
  assert.equal(marked({ ...large, inUse: true, downloading: false }), "In use · too slow on a CPU")
  assert.equal(marked(base), null)
})

test("who hears a take reads back from the host's answer", () => {
  const speech = readSpeech({
    ...settings,
    provider: { name: "groq", backend: null, cloud: true },
  })
  assert.deepEqual(speech.provider, { name: "groq", backend: null, cloud: true })
})

test("a host that names no provider leaves the field out rather than guessing", () => {
  assert.equal(readSpeech(settings).provider, undefined)
  assert.equal(readSpeech({ ...settings, provider: {} }).provider, undefined)
})

test("a cloud take is said to be uploaded, not heard on the host", () => {
  assert.equal(
    heardLine({ name: "groq", backend: null, cloud: true }),
    "A take is uploaded to this provider, not heard on this host.",
  )
})

test("a whisper CLI says what it drops; a host's own model says nothing", () => {
  assert.equal(
    heardLine({ name: "local_command", backend: "local_command", cloud: false }),
    "This host's whisper CLI drops the Hearing prompt and Vocabulary.",
  )
  assert.equal(heardLine({ name: "local", backend: "local", cloud: false }), null)
  assert.equal(heardLine({ name: "none", backend: null, cloud: false }), null)
  assert.equal(heardLine(undefined), null)
})
