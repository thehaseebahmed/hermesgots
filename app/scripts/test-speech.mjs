import assert from "node:assert/strict"
import test from "node:test"

import { marked, modelSize, modelSpeed, readSpeech } from "../src/lib/speech.ts"

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
  warning: null,
  cleanup: { model: null, allowed: true, reason: null },
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
})

test("a plugin that sends less than the tab knows about is read forgivingly", () => {
  assert.deepEqual(readSpeech(null), {
    model: "",
    models: [],
    warning: null,
    cleanup: { model: null, allowed: false, reason: null },
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

test("a warning is the model that failed and the host's reason", () => {
  const warned = readSpeech({
    ...settings,
    warning: { model: "small", reason: "the file is corrupt" },
  })
  assert.deepEqual(warned.warning, { model: "small", reason: "the file is corrupt" })
  assert.equal(readSpeech({ ...settings, warning: { model: 4 } }).warning, null)
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
  assert.equal(marked(base), null)
})
