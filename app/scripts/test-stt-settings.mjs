/**
 * The Speech-to-text page's own rules, without a host or a screen (ADR 0063): the key table covers
 * everything the host's `stt` block carries; a row reads the host's default where the file holds
 * nothing and its own value where it does; a number is typed as one or refused; the Provider row
 * names what Hermes resolved, or says why it resolved nothing; the local models are Gots's
 * catalogue kept to the names the host declares, with the one in play always in it; and a provider
 * whose models only a live catalogue names has no page until the host reports one; and the Provider
 * pick offers the host's own order with local in it, while the rows the screen draws leave it out.
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
  pickOptions,
  providerHasPage,
  providerNote,
  providerOptions,
  providerPage,
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
    choices: [
      { name: "local" },
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
    "local is in the host's list for the pick, and never among the provider rows",
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

test("the Provider pick offers local first, then the host's order, Automatic ahead of both", () => {
  const options = providerOptions(block())
  assert.deepEqual(
    options.map((one) => one.id),
    ["", "local", "groq", "openai", "mistral", "xai", "elevenlabs", "deepinfra"],
    "every provider the pick can set, local among them, with the unhurried state first",
  )
  assert.equal(options[0].label, "Automatic", "which is a state, not the absence of one")
  assert.equal(options[0].detail, "Local", "over the name the resolver answered")
  assert.deepEqual(
    options.slice(1).map((one) => one.label),
    ["Local", "Groq", "OpenAI", "Mistral", "xAI", "ElevenLabs", "DeepInfra"],
    "and each provider as the app spells it",
  )
})

test("a choice says its key is missing only where the screen knows about one", () => {
  const options = providerOptions(block())
  const openai = options.find((one) => one.id === "openai")
  assert.equal(openai?.detail, "Key not set", "a provider whose key the host lacks says so")
  assert.equal(
    options.find((one) => one.id === "local")?.detail,
    "In use",
    "the one hearing a take here says that, not that its key is missing",
  )
  const cloud = providerOptions({
    ...block(),
    provider: { name: "groq", reason: null, explicit: "groq" },
  })
  assert.equal(cloud.find((one) => one.id === "groq")?.detail, "In use", "the one Hermes hears on")
  assert.equal(
    cloud.find((one) => one.id === "local")?.detail,
    undefined,
    "and off it, local says nothing at all: it needs no key",
  )
  assert.equal(cloud[0].detail, "Groq", "while Automatic names the provider it resolved")
})

test("a host from before the pick's own list still offers local", () => {
  const { choices, ...older } = block()
  assert.equal(choices.length > 0, true, "the fixture carries one")
  assert.deepEqual(
    readStt({ ...older, values: {}, defaults: block().defaults }).choices.map((one) => one.name),
    ["local", "groq", "openai", "mistral", "xai", "elevenlabs", "deepinfra"],
    "the rows it has, and local, which was Hermes's to resolve all along",
  )
})

test("a pick row offers the providers on the Provider row and that provider's models on its own", () => {
  const providers = STT_ROWS.find((row) => row.key === "stt.provider")
  const [first] = pickOptions(block(), providers)
  assert.equal(first.id, "", "the Provider row picks a provider, Automatic first")
  const model = STT_ROWS.find((row) => row.key === "stt.local.model")
  assert.deepEqual(
    pickOptions(block(), model).map((one) => one.id),
    ["base", "tiny", "small", "medium", "large-v3", "turbo"],
    "and the speech model row picks from the host's own catalogue",
  )
})

test("a local backend's settings are a card, not a page, so its address is no page at all", () => {
  assert.equal(providerHasPage("groq"), true, "a provider with rows of its own has a page")
  assert.equal(providerHasPage("local"), false, "local's are drawn on the Local card")
  assert.equal(
    providerHasPage("local_command"),
    false,
    "and the other backend Hermes decodes on itself is the same card, not a page of its own",
  )
  assert.equal(
    providerLabel("local_command"),
    "Local command",
    "a name with an underscore in it is not how a settings page says a thing",
  )
})
