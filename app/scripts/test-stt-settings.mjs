/**
 * The Speech-to-text page's own rules, without a host or a screen (ADR 0063): the key table covers
 * everything the host's `stt` block carries; a row reads the host's default where the file holds
 * nothing and its own value where it does; a number is typed as one or refused; the Provider row
 * names what Hermes resolved, or says why it resolved nothing; the local models are Gots's
 * catalogue kept to the names the host declares, with the one in play always in it; and a provider
 * whose models only a live catalogue names has no page until the host reports one.
 */
import assert from "node:assert/strict"
import test from "node:test"

import {
  PROVIDER_FIELDS,
  STT_ROWS,
  sttGroups,
  effective,
  explicitly,
  modelOptions,
  parseNumber,
  providerLabel,
  providerLine,
  providerPage,
  providerNote,
  providerRows,
  providerModelKey,
  readStt,
  rowOn,
  rowValue,
  tableKeys,
} from "../src/lib/stt-settings.ts"

/** A host's block, as `GET speech` answers it: the defaults Hermes ships, one explicit language. */
const block = (patch = {}) =>
  readStt({
    values: { "stt.language": "es" },
    defaults: {
      "stt.enabled": true,
      "stt.echo_transcripts": true,
      "stt.language": "en",
      "stt.streaming": false,
      "stt.cloud_trim_silence": true,
      "stt.cloud_trim_threshold_db": -40,
      "stt.cloud_trim_keep_ms": 300,
      "stt.local.model": "base",
      "stt.local.language": "",
      "stt.local.initial_prompt": "",
      "stt.local.vad": true,
      "stt.local.vad_min_silence_ms": 500,
      "stt.local.no_speech_prob_threshold": 0.6,
      "stt.local.logprob_threshold": -1,
      "stt.local.unload_after_idle_seconds": 0,
      "stt.groq.model": "whisper-large-v3-turbo",
      "stt.groq.language": "",
      "stt.openai.model": "whisper-1",
      "stt.openai.streaming_model": "gpt-live-transcribe",
      "stt.openai.language": "",
      "stt.openai.timeout": 60,
      "stt.openai.max_retries": 1,
      "stt.mistral.model": "voxtral-mini-latest",
      "stt.mistral.language": "",
      "stt.xai.model": "",
      "stt.xai.language": "",
      "stt.elevenlabs.model_id": "scribe_v2",
      "stt.elevenlabs.language_code": "",
      "stt.elevenlabs.tag_audio_events": false,
      "stt.elevenlabs.diarize": false,
      "stt.deepinfra.model": "",
    },
    provider: { name: "local", reason: null, explicit: null },
    providers: [
      { name: "groq", key_set: true },
      { name: "openai", key_set: false },
      { name: "mistral", key_set: false },
      { name: "xai", key_set: false },
      { name: "elevenlabs", key_set: false },
      { name: "deepinfra", key_set: false },
    ],
    models: {
      local: ["base", "tiny", "small", "medium", "large-v3", "turbo"],
      groq: ["whisper-large-v3-turbo", "whisper-large-v3"],
      openai: ["whisper-1", "gpt-4o-transcribe"],
      mistral: ["voxtral-mini-latest"],
      xai: ["grok-voice-transcribe-2.0"],
      elevenlabs: ["scribe_v2", "scribe_v1"],
    },
    ...patch,
  })

test("the table names every key the host's block carries", () => {
  const carried = Object.keys(block().defaults)
  const table = tableKeys(block())
  assert.equal(carried.length, 31, "the schema's own defaults, as the plugin flattens them")
  assert.deepEqual(
    carried.filter((key) => !table.includes(key)),
    ["stt.deepinfra.model"],
    "only the provider whose page waits for a catalogue the host hasn't reported is undrawn",
  )
  assert.ok(table.includes("stt.provider"), "the pick the schema never seeds is the page's own row")
  assert.equal(
    STT_ROWS.length +
      providerRows(block()).reduce((sum, row) => sum + providerPage(row.name).length, 0),
    table.length,
    "the inline rows and the providers' pages are the whole table",
  )
  const all = block()
  all.models.deepinfra = ["openai/whisper-large-v3"]
  assert.deepEqual(
    carried.filter((key) => !tableKeys(all).includes(key)),
    [],
    "and every key is drawn once the host reports that catalogue",
  )
})

test("the table is drawn as cards named for what their settings are about, the master switch first", () => {
  const groups = sttGroups()
  assert.deepEqual(
    groups.map((group) => group.title),
    ["General", "Local", "Cloud"],
    "three cards, by subject rather than by owner",
  )
  assert.deepEqual(
    groups[0].rows.map((row) => row.label),
    ["Enabled", "Provider", "Echo transcripts"],
    "who hears at all, who hears, and whether the take is echoed back",
  )
  assert.deepEqual(
    groups[1].rows.map((row) => row.label),
    [
      "Speech model",
      "Local language",
      "Initial prompt",
      "VAD",
      "VAD min silence",
      "No-speech threshold",
      "Logprob threshold",
      "Unload after idle",
    ],
    "the local model, in the order a take is heard",
  )
  assert.deepEqual(
    groups[2].rows.map((row) => row.label),
    ["Language", "Streaming", "Trim silence", "Trim threshold", "Trim keep"],
    "what only a cloud backend reads, the language the pick overrides last",
  )
  assert.equal(
    groups.flatMap((group) => group.rows).length,
    STT_ROWS.length,
    "every row the page draws sits in exactly one card",
  )
})

test("a row shows the host's default where the file holds nothing, and what it holds where it does", () => {
  const held = block()
  assert.equal(effective(held, "stt.language"), "es", "the value the file holds")
  assert.equal(explicitly(held, "stt.language"), true, "and it is the file's")
  assert.equal(effective(held, "stt.local.vad"), true, "a key left out falls back to Hermes's own")
  assert.equal(explicitly(held, "stt.local.vad"), false, "which is not a value this device wrote")
  assert.equal(rowValue(held, "stt.local.language"), "", "a default of nothing reads as nothing")
  assert.equal(rowValue(held, "stt.local.no_speech_prob_threshold"), "0.6", "a number as text")
  assert.equal(rowOn(held, "stt.streaming"), false, "a switch reads the default")
  assert.equal(rowOn(held, "stt.enabled"), true)
})

test("a number is taken as one, a blank clears it, and anything else is refused", () => {
  assert.deepEqual(parseNumber("-1"), { ok: true, value: -1 }, "a negative threshold")
  assert.deepEqual(parseNumber("0.25"), { ok: true, value: 0.25 }, "a decimal")
  assert.deepEqual(
    parseNumber(" 500 "),
    { ok: true, value: 500 },
    "surrounding space is not a value",
  )
  assert.deepEqual(
    parseNumber(""),
    { ok: true, value: null },
    "a blank field is the host's default",
  )
  for (const junk of ["junk", "1,5", "0x10", "Infinity", "1e3", "--2", "500ms"]) {
    assert.deepEqual(parseNumber(junk), { ok: false }, `${junk} is not a number`)
  }
})

test("the Provider row names what Hermes resolved, and how it got there", () => {
  assert.deepEqual(
    providerLine(block()),
    { value: "Automatic · Local", muted: true, note: null },
    "no pick in the file: the resolver's own answer, read as the default it is",
  )
  assert.deepEqual(
    providerLine(block({ provider: { name: "groq", reason: null, explicit: "groq" } })),
    { value: "Groq", muted: false, note: null },
    "a pick is the value, in the accent colour",
  )
  assert.deepEqual(
    providerLine(
      block({
        provider: {
          name: "none",
          reason: "No speech provider on this host can hear a take.",
          explicit: null,
        },
      }),
    ),
    {
      value: "Automatic",
      muted: true,
      note: "No speech provider on this host can hear a take.",
    },
    "nothing usable says so in the host's words, and names no provider",
  )
})

test("the local models are the host's names, with the model in play kept", () => {
  const rows = [
    { name: "base", sizeMb: 145 },
    { name: "small", sizeMb: 484 },
    { name: "distil-large-v3", sizeMb: 1510 },
  ]
  assert.deepEqual(
    modelOptions(rows, ["base", "small", "medium"], "base").map((row) => row.name),
    ["base", "small"],
    "a name the host doesn't declare is not offered",
  )
  assert.deepEqual(
    modelOptions(rows, ["base", "small"], "distil-large-v3").map((row) => row.name),
    ["base", "small", "distil-large-v3"],
    "the model in play is always in the list, even outside the filter",
  )
})

test("the providers list is every provider but local, each over the model it holds", () => {
  const rows = providerRows(block())
  assert.deepEqual(
    rows.map((row) => row.name),
    ["groq", "openai", "mistral", "xai", "elevenlabs"],
  )
  const groq = rows.find((row) => row.name === "groq")
  assert.equal(groq.model, "whisper-large-v3-turbo", "the model it holds")
  assert.equal(groq.inUse, false, "and it is not the one Hermes is using")
  assert.equal(rows.find((row) => row.name === "openai").keySet, false, "a provider with no key")
  const eleven = rows.find((row) => row.name === "elevenlabs")
  assert.equal(eleven.model, "scribe_v2", "ElevenLabs' model is model_id")
  assert.equal(eleven.label, "ElevenLabs")
})

test("a provider's model key is the field its own page labels Model", () => {
  assert.equal(providerModelKey("groq"), "stt.groq.model", "the name the schema uses")
  assert.equal(
    providerModelKey("elevenlabs"),
    "stt.elevenlabs.model_id",
    "except where it kept its own",
  )
  assert.deepEqual(
    providerPage("elevenlabs").map((row) => row.key)[0],
    providerModelKey("elevenlabs"),
    "so the list reads the row its page draws, not a second table's guess",
  )
  assert.equal(
    providerModelKey("nous"),
    "stt.nous.model",
    "a provider the app doesn't draw still names",
  )
})

test("a provider's row says either that it is in use or that its key is missing", () => {
  assert.equal(providerNote({ inUse: true, keySet: true }), "In use", "the one Hermes hears on")
  assert.equal(providerNote({ inUse: false, keySet: false }), "Key not set", "one it could not use")
  assert.equal(
    providerNote({ inUse: false, keySet: true }),
    null,
    "and one ready to pick says nothing",
  )
  assert.equal(
    providerNote({ inUse: false, keySet: null }),
    null,
    "nor does one it can't ask about",
  )
})

test("deepinfra has no page until the host reports a catalogue for it", () => {
  assert.equal(
    providerRows(block()).some((row) => row.name === "deepinfra"),
    false,
    "no catalogue, no page",
  )
  const withCatalogue = block()
  withCatalogue.models.deepinfra = ["openai/whisper-large-v3"]
  assert.equal(
    providerRows(withCatalogue).some((row) => row.name === "deepinfra"),
    true,
    "and a page once the host has one",
  )
})

test("a provider page holds the schema's own keys and labels", () => {
  assert.deepEqual(
    providerPage("elevenlabs").map((row) => row.key),
    [
      "stt.elevenlabs.model_id",
      "stt.elevenlabs.language_code",
      "stt.elevenlabs.tag_audio_events",
      "stt.elevenlabs.diarize",
    ],
    "the names Hermes spells them by, not the Dashboard's",
  )
  assert.deepEqual(
    providerPage("deepinfra"),
    [
      {
        key: "stt.deepinfra.model",
        label: "Model",
        control: "text",
        purpose: "Blank uses the host's own model",
      },
    ],
    "deepinfra's model is typed",
  )
  for (const name of Object.keys(PROVIDER_FIELDS))
    assert.ok(providerPage(name).length > 0, `${name} has a page`)
  assert.deepEqual(providerPage("nobody"), [], "a provider this build doesn't know holds no rows")
})

test("a host that carries none of this has no block at all", () => {
  assert.equal(readStt(undefined), undefined)
  assert.equal(readStt({}), undefined, "no defaults, nothing to draw")
  assert.deepEqual(readStt({ values: {}, defaults: { "stt.enabled": true } }).defaults, {
    "stt.enabled": true,
  })
  assert.equal(providerLabel("somethingnew"), "Somethingnew", "an unknown provider still reads")
})
