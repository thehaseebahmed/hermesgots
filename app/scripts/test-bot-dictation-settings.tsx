import assert from "node:assert/strict"
import test from "node:test"

import { click, find, findAll, mount, type, until } from "./component-kit.tsx"
import {
  STT,
  captions,
  titlesIn,
  editor,
  fieldIn,
  here,
  lines,
  row,
  seed,
  sheetButton,
  switchIn,
  speech,
  speechPage,
  tagOf,
  titleOf,
  valueColour,
  valueOf,
} from "./dictation-page-kit.tsx"

test("the page draws every speech setting its host carries, in cards named for what they are", async () => {
  await seed(
    "stt-rows",
    ["dictation", "speech_model", "stt_settings", "cleanup_level"],
    {},
    { speech: speech({ stt: STT() }) },
  )
  await mount(editor("/settings/bots/bot-1/speech-to-text"), async () => {
    assert.deepEqual(
      captions(),
      ["General", "Local", "Cloud", "Providers", "Cleanup"],
      "the host's four cards, then the cleanup's own below them",
    )
    assert.deepEqual(
      titlesIn("General"),
      ["Enabled", "Provider", "Echo transcripts"],
      "the master switch first, then who hears",
    )
    assert.deepEqual(
      titlesIn("Cleanup"),
      ["Cleanup model"],
      "and the cleanup's model in the card the level picker sits over",
    )
    assert.deepEqual(
      [...findAll("[data-cleanup-level]")].map((card) => card.getAttribute("data-cleanup-level")),
      ["none", "light", "medium", "high"],
      "with the four levels above it",
    )
    assert.deepEqual(
      titlesIn("Local"),
      [
        "Speech model",
        "Local language",
        "Initial prompt",
        "Vocabulary",
        "VAD",
        "VAD min silence",
        "No-speech threshold",
        "Logprob threshold",
        "Unload after idle",
      ],
      "the local model's own tuning, with the vocabulary under the prompt it rides in with",
    )
    assert.deepEqual(
      titlesIn("Cloud"),
      ["Language", "Streaming", "Trim silence", "Trim threshold", "Trim keep"],
      "what only a cloud backend reads",
    )
    assert.deepEqual(
      titlesIn("Providers"),
      ["Groq", "OpenAI", "ElevenLabs"],
      "every provider but local, over the model it holds",
    )
    assert.equal(
      valueOf(row("stt.provider")),
      "Automatic · Local",
      "no pick in the file: the row names what the resolver chose",
    )
    assert.equal(valueColour(row("stt.provider")), "muted", "and reads as the host's own answer")
    assert.equal(valueOf(row("stt.language")), "es", "a value the file holds")
    assert.equal(valueColour(row("stt.language")), "accent", "is the page's own")
    assert.equal(valueOf(row("stt.local.vad_min_silence_ms")), "500", "a default is still shown")
    assert.equal(
      valueColour(row("stt.local.vad_min_silence_ms")),
      "muted",
      "read muted, because nobody wrote it here",
    )
    assert.equal(valueOf(row("stt.local.language")), "Not set", "a default of nothing holds none")
    assert.equal(
      switchIn("stt.local.vad")?.getAttribute("aria-checked"),
      "true",
      "a switch starts where the host has it",
    )
    assert.equal(tagOf(row("vocabulary")), "Gots", "the words are Gots's own")
    assert.equal(tagOf(row("cleanup-model")), "Gots", "and so is the tidying model")
    assert.equal(tagOf(row("stt.enabled")), "", "the host's settings are untagged")
    assert.equal(tagOf(row("stt.local.model")), "", "the speech model included")
    assert.equal(tagOf(row("providers-groq")), "", "and every provider row")
  })
})

test("a switch writes the one key it flips", async () => {
  const calls = await seed(
    "stt-switch",
    ["dictation", "speech_model", "stt_settings"],
    {},
    {
      speech: speech({ stt: STT() }),
      nextStt: STT({ values: { "stt.language": "es", "stt.local.vad": false } }),
    },
  )
  await mount(editor("/settings/bots/bot-1/speech-to-text"), async () => {
    await click(switchIn("stt.local.vad"))
    assert.deepEqual(
      calls.filter((call) => call.path.endsWith("/stt"))[0]?.body,
      { key: "stt.local.vad", value: false },
      "one dotted key, and the value it was given",
    )
    assert.equal(
      switchIn("stt.local.vad")?.getAttribute("aria-checked"),
      "false",
      "and the row reads what the host answered",
    )
    assert.equal(valueOf(row("stt.language")), "es", "the write left every other setting alone")
  })
})

test("a value typed in is written as itself, and a reset writes null", async () => {
  const calls = await seed(
    "stt-field",
    ["dictation", "speech_model", "stt_settings"],
    {},
    {
      speech: speech({ stt: STT() }),
      nextStt: STT({ values: {} }),
    },
  )
  await mount(editor("/settings/bots/bot-1/speech-to-text"), async () => {
    await click(row("stt.language"))
    await until(async () => Boolean(fieldIn("stt.language")), "the field the row opens")
    assert.equal(
      (fieldIn("stt.language") as HTMLInputElement)?.value,
      "es",
      "the field holds the value the file holds",
    )
    assert.equal(
      (fieldIn("stt.language") as HTMLInputElement)?.placeholder,
      "en",
      "and the host's default is what it falls back to",
    )
    await click(sheetButton("Host default"))
    assert.deepEqual(
      calls.filter((call) => call.path.endsWith("/stt"))[0]?.body,
      { key: "stt.language", value: null },
      "a reset writes null, so the key leaves the file",
    )
    assert.equal(valueOf(row("stt.language")), "en", "and the row reads the host's default")
    assert.equal(valueColour(row("stt.language")), "muted", "muted, as a default is")
  })
})

test("a number that isn't one is refused before it is written", async () => {
  const calls = await seed(
    "stt-number",
    ["dictation", "speech_model", "stt_settings"],
    {},
    { speech: speech({ stt: STT() }) },
  )
  await mount(editor("/settings/bots/bot-1/speech-to-text"), async () => {
    await click(row("stt.local.vad_min_silence_ms"))
    await until(async () => Boolean(fieldIn("stt.local.vad_min_silence_ms")), "the field")
    await type(fieldIn("stt.local.vad_min_silence_ms"), "a while")
    assert.equal(
      sheetButton("Save")?.hasAttribute("disabled"),
      true,
      "Save waits for a number, and nothing is sent",
    )
    assert.deepEqual(calls, [], "no write was made")
  })
})

test("the providers card lists each one over its model, the one in use and a missing key", async () => {
  await seed(
    "stt-providers",
    ["dictation", "speech_model", "stt_settings"],
    {},
    {
      speech: speech({
        stt: STT({
          provider: { name: "groq", explicit: "groq", reason: null },
        }),
      }),
    },
  )
  await mount(editor("/settings/bots/bot-1/speech-to-text"), async () => {
    assert.deepEqual(
      lines(row("providers-groq")),
      ["Groq", "whisper-large-v3-turbo", "In use"],
      "the provider Hermes is using says so over the model it holds",
    )
    assert.deepEqual(
      lines(row("providers-openai")),
      ["OpenAI", "whisper-1", "Key not set"],
      "a provider with no key on the host says that",
    )
    assert.deepEqual(
      lines(row("providers-elevenlabs")),
      ["ElevenLabs", "scribe_v2"],
      "and one that can be used says nothing at all",
    )
    assert.deepEqual(titlesIn("Providers").length, 3, "local is never in the list")
  })
})

test("a provider's page draws its own rows, and a pick writes that provider's key", async () => {
  const calls = await seed(
    "stt-provider-rows",
    ["dictation", "speech_model", "stt_settings"],
    {},
    {
      speech: speech({ stt: STT() }),
      nextStt: STT({
        values: { "stt.language": "es", "stt.groq.model": "whisper-large-v3" },
      }),
    },
  )
  await mount(editor("/settings/bots/bot-1/speech-to-text"), async () => {
    // The card's row is the way in, and Done is the way back.
    await click(row("providers-groq"))
    await until(async () => Boolean(find('[data-stt-provider="groq"]')), "the provider's own page")
    assert.equal(here(), "/settings/bots/bot-1/speech-to-text/providers/groq", "at its own address")
    assert.deepEqual(
      lines(row("stt.groq.model")),
      ["Model", "whisper-large-v3-turbo"],
      "the model it holds",
    )
    assert.equal(valueOf(row("stt.groq.language")), "Not set", "and a language nothing holds")
    await click(row("stt.groq.model"))
    const options = findAll('[data-pick-list="Model"] > button')
    assert.deepEqual(
      options.map((one) => (one.textContent ?? "").trim()),
      ["whisper-large-v3-turbo", "whisper-large-v3"],
      "the models the host declares for it",
    )
    await click(options[1])
    assert.deepEqual(
      calls.filter((call) => call.path.endsWith("/stt"))[0]?.body,
      { key: "stt.groq.model", value: "whisper-large-v3" },
      "one key, under the provider whose page it is",
    )
    assert.equal(valueOf(row("stt.groq.model")), "whisper-large-v3", "and the row follows it")
    await click(sheetButton("Done"))
    await until(async () => Boolean(speechPage()), "back on the page the card sits in")
    assert.equal(here(), "/settings/bots/bot-1/speech-to-text", "which is the page itself")
  })
})

test("a list address with no item lands on the page that draws its rows", async () => {
  await seed(
    "stt-list-address",
    ["dictation", "speech_model", "stt_settings"],
    {},
    { speech: speech({ stt: STT() }) },
  )
  await mount(editor("/settings/bots/bot-1/speech-to-text/providers"), async () => {
    await until(async () => Boolean(speechPage()), "the page, since the rows are drawn on it")
    assert.equal(here(), "/settings/bots/bot-1/speech-to-text", "at the page's own address")
  })
})

test("a host without stt_settings draws the page it always had", async () => {
  await seed(
    "stt-absent",
    ["dictation", "speech_model"],
    {},
    // The block is there, but the host never advertised the feature: the page keeps its one row.
    { speech: speech({ stt: STT() }) },
  )
  await mount(editor("/settings/bots/bot-1/speech-to-text"), async () => {
    assert.deepEqual(
      captions(),
      ["Cleanup"],
      "one caption, over the cleanup's own card, and none over groups the host doesn't have",
    )
    assert.deepEqual(
      [...(speechPage()?.querySelectorAll("[data-setting]") ?? [])].map(titleOf),
      ["Speech model", "Vocabulary", "Cleanup model"],
      "the model it has, then Gots's two rows",
    )
    assert.equal(tagOf(row("vocabulary")), "Gots", "still marked as Gots's own")
    assert.equal(tagOf(row("cleanup-model")), "Gots")
    assert.equal(tagOf(row("speech-model")), "", "and the host's row unmarked")
    assert.ok(!row("stt.provider"), "no provider row")
    assert.ok(!row("stt.local.vad"), "and none of the tuning")
    assert.ok(!row("providers-groq"), "nor any provider")
  })
})
