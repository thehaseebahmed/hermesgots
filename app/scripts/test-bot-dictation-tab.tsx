import assert from "node:assert/strict"
import test from "node:test"

import {
  speech,
  editor,
  routedEditor,
  here,
  speechPage,
  speechRow,
  row,
  lines,
  titleOf,
  valueOf,
  valueColour,
  headings,
  chevrons,
  speechSheet,
  speechOptions,
  speechInPlay,
  speechOption,
  openSpeech,
  unmeasured,
  modelRow,
  openCleanup,
  vocabulary,
  removeButton,
  addField,
  addButton,
  openAdd,
  add,
  sheetButton,
  seed,
  seedCache,
  loading,
  off,
  STT,
  switchIn,
  writes,
  speechReads,
} from "./dictation-page-kit.tsx"
import {
  click,
  find,
  findAll,
  labelled,
  missing,
  mount,
  type,
  until,
  wordsOf,
} from "./component-kit.tsx"
import { connectionKey } from "@/lib/connection"
import { db } from "@/lib/db"

/** Any button on screen showing nothing but Done: the footer every drill-in used to end with. */
const doneFooter = () =>
  findAll("button").find((one) => one.textContent?.trim() === "Done") ?? null

test("a host that can hear speech has a Speech-to-text page, its Vocabulary row counting the words", async () => {
  await seed("dictating", ["dictation"], { vocabulary: ["Haseeb"] })
  await mount(editor("/settings/bots/bot-1/speech-to-text"), async () => {
    assert.ok(speechRow(), "the Speech-to-text row is in the list beside the page")
    assert.ok(speechPage(), "and the page is the one drawn")
    assert.equal(valueOf(row("vocabulary")), "1 word", "the row counts the word the bot holds")
    assert.equal(valueColour(row("vocabulary")), "accent", "and the count wears the accent colour")
    assert.equal(here(), "/settings/bots/bot-1/speech-to-text", "the address is the page's own")
  })
})

test("a host that can't hear speech has no Speech-to-text page, and its address lands on the bot's page", async () => {
  await seed("no-dictation", ["general_page", "speech_model"])
  await mount(editor("/settings/bots/bot-1/speech-to-text"), async () => {
    assert.ok(!speechRow(), "no Speech-to-text row")
    assert.ok(!speechPage(), "no Speech-to-text page")
    assert.ok(!row("vocabulary"), "and no setting to read")
    assert.equal(here(), "/settings/bots/bot-1", "the address is the bot's own")
    assert.ok(find("[data-bot-card]"), "and the bot's own page is what is drawn")
  })
})

test("the page draws its rows over one card per owner, with no heading or chevron", async () => {
  await seed(
    "grouped",
    ["dictation", "speech_model"],
    { vocabulary: ["Gots", "Haseeb", "Whisper"] },
    { speech: speech() },
  )
  await mount(editor("/settings/bots/bot-1/speech-to-text"), async () => {
    assert.deepEqual(
      [...(speechPage()?.querySelectorAll("[data-setting]") ?? [])].map(titleOf),
      ["Speech model", "Vocabulary", "Cleanup model"],
      "the model the host has, then Gots's two rows",
    )
    assert.deepEqual(headings(), [], "no group headings: the rows need none")
    assert.deepEqual(chevrons(), [], "and no row draws a chevron")
    assert.equal(
      findAll("[data-bot-dictation] input").length,
      0,
      "no text box sits inside a settings card",
    )
    assert.deepEqual(
      lines(row("vocabulary")),
      ["Vocabulary", "Gots", "The words this bot's speech leans towards", "3 words"],
      "Vocabulary's title and its own mark, its line and its value",
    )
    assert.deepEqual(
      lines(row("cleanup-model")),
      ["Cleanup model", "Gots", "The model that tidies a take's finished words", "Default"],
      "Cleanup model's lines, its value the default",
    )
    assert.deepEqual(
      lines(row("speech-model")),
      ["Speech model", "The model that hears this bot's speech-to-text", "small"],
      "and the speech model the host has in play",
    )
  })
})

test("Vocabulary reads Not set where the bot holds none, and its row drills into the words", async () => {
  await seed("vocabulary-none", ["dictation", "speech_model"], {}, { speech: speech() })
  await mount(editor("/settings/bots/bot-1/speech-to-text"), async () => {
    assert.equal(valueOf(row("vocabulary")), "Not set", "a setting holding nothing says so")
    assert.equal(valueColour(row("vocabulary")), "muted", "muted rather than the accent colour")
    await click(row("vocabulary"))
    assert.equal(
      here(),
      "/settings/bots/bot-1/speech-to-text/vocabulary",
      "the row drills into the words themselves",
    )
    assert.ok(vocabulary(), "and the words are what is drawn")
    assert.ok(!speechPage(), "in place of the page")
  })
})

test("the Vocabulary detail lists the bot's words, each with a way to remove it", async () => {
  await seed("vocabulary-detail", ["dictation"], { vocabulary: ["Gots", "Haseeb"] })
  await mount(editor("/settings/bots/bot-1/speech-to-text/vocabulary"), async () => {
    assert.ok(vocabulary(), "the words are the page's own content")
    const body = vocabulary()?.textContent ?? ""
    assert.match(body, /Gots/, "the bot's first word")
    assert.match(body, /Haseeb/, "and the second")
    assert.ok(removeButton("Haseeb"), "each word has a button that names the word it removes")
    assert.equal(findAll("[data-vocabulary] h2").length, 0, "no heading over the list")
    assert.equal(addField(), null, "and no add field on the list: the header's + opens one")
    assert.doesNotMatch(body, /No words yet\./, "the empty line stays away while words are held")
  })
})

test("the Vocabulary detail says No words yet. as a line of text, not a card", async () => {
  await seed("vocabulary-empty", ["dictation"])
  await mount(editor("/settings/bots/bot-1/speech-to-text/vocabulary"), async () => {
    assert.match(vocabulary()?.textContent ?? "", /No words yet\./, "the empty list says so")
    assert.ok(!removeButton("Gots"), "with no word to remove")
    assert.equal(
      vocabulary()?.querySelector("[data-settings-group]"),
      null,
      "and no card around a list holding nothing",
    )
  })
})

test("the header's + opens the word sheet, and Add writes it into the bot's record", async () => {
  await seed("adding", ["dictation"])
  await mount(routedEditor("/settings/bots/bot-1/speech-to-text/vocabulary"), async () => {
    assert.equal(addField(), null, "no field on the page itself")
    await openAdd()
    assert.equal(
      find('[data-slot="sheet-title"]')?.textContent,
      "Add a word",
      "the sheet says what it adds",
    )
    assert.equal(addButton()?.getAttribute("aria-label"), "Add a word", "and the + names it too")
    assert.equal(
      sheetButton("Add")?.hasAttribute("disabled"),
      true,
      "Add waits for a word",
    )
    await type(addField(), "Gots")
    assert.equal(
      sheetButton("Add")?.hasAttribute("disabled"),
      false,
      "and opens once one is typed",
    )
    await add()
    await until(async () => Boolean(removeButton("Gots")), "the word on the list")
    const saved = await db.profiles.get("bot-1")
    assert.deepEqual(saved?.vocabulary, ["Gots"], "and in the bot's record")
    assert.ok((saved?.updatedAt ?? 0) > 1, "the record is stamped as changed")
    assert.equal(addField(), null, "the sheet closes on the write")
  })
})

test("a word the list already holds is not added again", async () => {
  await seed("repeated", ["dictation"], { vocabulary: ["Gots"] })
  await mount(routedEditor("/settings/bots/bot-1/speech-to-text/vocabulary"), async () => {
    await openAdd()
    await type(addField(), "gots")
    await add()
    assert.equal((await db.profiles.get("bot-1"))?.vocabulary?.length, 1, "the list keeps one")
    assert.ok(!removeButton("gots"), "the spelling it already has stands")
    assert.ok(removeButton("Gots"), "and the word it holds is untouched")
  })
})

test("a word removed from the screen leaves the record", async () => {
  await seed("removing", ["dictation"], { vocabulary: ["Gots", "Haseeb"] })
  await mount(editor("/settings/bots/bot-1/speech-to-text/vocabulary"), async () => {
    await click(removeButton("Haseeb"))
    await until(async () => !removeButton("Haseeb"), "the word to leave the screen")
    assert.deepEqual((await db.profiles.get("bot-1"))?.vocabulary, ["Gots"])
    assert.ok(removeButton("Gots"), "the words beside it stay")
  })
})

/**
 * A drill-in closes the way General's one detail does: the screen's header carries the back, and the
 * page adds no footer button repeating it. Mounted on the app's own route, so the header and its
 * back are the ones a user has.
 */
test("the Vocabulary page has no Done of its own: the screen's back returns to the page", async () => {
  await seed("vocabulary-back", ["dictation"], { vocabulary: ["Gots"] })
  await mount(routedEditor("/settings/bots/bot-1/speech-to-text/vocabulary"), async () => {
    await until(async () => Boolean(vocabulary()), "the words")
    assert.equal(find("h1")?.textContent, "Vocabulary", "the screen is titled with the page")
    assert.equal(doneFooter(), null, "and no Done footer repeats the header's way out")
    await click(find('button[aria-label="Back"]'))
    await until(async () => Boolean(speechPage()), "the page the row sits in")
    assert.equal(here(), "/settings/bots/bot-1/speech-to-text", "the page's own address")
    assert.ok(!vocabulary(), "with the list gone")
  })
})

test("the Speech model row names the model in play, and opens the host's models in a sheet", async () => {
  await seed("speech-picker", ["dictation", "speech_model"], {}, { speech: speech() })
  await mount(editor("/settings/bots/bot-1/speech-to-text"), async () => {
    assert.equal(valueOf(row("speech-model")), "small", "the row names the model in play")
    assert.equal(findAll("#speech-model").length, 0, "no field of its own: the row is the control")
    assert.equal(findAll("[data-pick-list]").length, 0, "with nothing open yet")
    await openSpeech()
    assert.ok(speechSheet(), "the row opens a sheet holding the host's models")
    assert.equal(
      find('[data-slot="sheet-title"]')?.textContent,
      "Speech model",
      "the sheet is titled Speech model",
    )
    assert.equal(
      findAll('[aria-label="Speech models"] input').length,
      0,
      "no search over a list this short",
    )
    assert.equal(speechOptions().length, 3, "one option for each model on the host")
    assert.equal(
      speechInPlay()?.textContent?.startsWith("small"),
      true,
      "the one in play is the one ticked",
    )
    assert.equal(speechInPlay() === speechOption("base"), false, "and no other row wears it")
    assert.match(speechOption("base")?.textContent ?? "", /145 MB/, "the download is named")
    assert.match(
      speechOption("base")?.textContent ?? "",
      /9\.4× realtime/,
      "and the factor this host timed, which is the only one there is (ADR 0075)",
    )
    assert.match(speechOption("small")?.textContent ?? "", /In use/)
    assert.equal(
      speechOption("small")?.querySelector("[data-pick-badge]")?.textContent,
      "Recommended",
      "the row it recommends wears it as a badge beside the name",
    )
    assert.doesNotMatch(
      speechOption("small")?.querySelector(".truncate")?.textContent ?? "",
      /Recommended/,
      "and not again in its line",
    )
    assert.equal(findAll("[data-pick-badge]").length, 1, "and only one row is")
    assert.match(
      speechOption("large-v3")?.textContent ?? "",
      /Not measured/,
      "a row nobody timed says so rather than quoting a factor",
    )
    assert.ok(missing("[data-speech-probe]"), "and a host that owes nothing captions nothing: each row carries its own measurement")
    const clearing = speechOptions().find((option) =>
      /\b(default|none|clear)\b/i.test(option.textContent ?? ""),
    )
    assert.equal(clearing, undefined, "no default or clearing pick: a take always has a model")
  })
})

test("a host that owes a measurement is asked for one as the models open, and its rows state it", async () => {
  const calls = await seed(
    "speech-probe-owed",
    ["dictation", "speech_model", "speech_probe"],
    {},
    { speech: unmeasured(), probed: speech() },
  )
  await mount(editor("/settings/bots/bot-1/speech-to-text"), async () => {
    assert.equal(
      calls.filter((call) => call.path.endsWith("/speech/probe")).length,
      0,
      "a page nobody opened the models on asks for no measurement",
    )
    await openSpeech()
    await until(
      () => calls.filter((call) => call.path.endsWith("/speech/probe")).length === 1,
      "the host is asked to time its own hearing",
    )
    await until(
      () => /9\.4× realtime/.test(speechOption("base")?.textContent ?? ""),
      "and the rows are redrawn from what it measured",
    )
    assert.match(speechOption("small")?.textContent ?? "", /Recommended/)
  })
})

test("a measurement taken on another machine is named, and never drawn as this host's", async () => {
  const foreign = unmeasured({
    probe: {
      owed: true,
      measured: 0,
      recommended: null,
      elsewhere: { name: "somebody-elses-laptop", at: "2026-11-01T09:00:00Z" },
      reason: null,
      at: null,
    },
  })
  await seed(
    "speech-probe-foreign",
    ["dictation", "speech_model", "speech_probe"],
    {},
    { speech: foreign },
  )
  await mount(editor("/settings/bots/bot-1/speech-to-text"), async () => {
    await openSpeech()
    await until(
      () => /not this host/.test(find("[data-speech-probe]")?.textContent ?? ""),
      "the sheet names the machine the measurement came from",
    )
    assert.match(find("[data-speech-probe]")?.textContent ?? "", /somebody-elses-laptop/)
    assert.match(speechOption("base")?.textContent ?? "", /Not measured/)
    assert.equal(
      speechOptions().filter((option) => /Recommended/.test(option.textContent ?? "")).length,
      0,
      "and no row is recommended from a number this machine never took",
    )
  })
})

test("a probe that never reached the host leaves the rows alone and puts no words under them", async () => {
  const calls = await seed(
    "speech-probe-offline",
    ["dictation", "speech_model", "speech_probe"],
    {},
    {
      speech: unmeasured(),
      failProbe: true,
    },
  )
  await mount(editor("/settings/bots/bot-1/speech-to-text"), async () => {
    await openSpeech()
    await until(
      () => calls.some((call) => call.path.endsWith("/speech/probe")),
      "the probe was asked for",
    )
    // A tick for the rejected request to land: nothing about the models may be drawn from it.
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(
      find("[data-speech-probe]")?.textContent ?? "",
      "This host hasn't measured its models yet.",
      "a request that never landed says nothing about the models, so the host's own state is drawn",
    )
  })
})

test("a probe the host refuses says why under the rows, and the pick still stands", async () => {
  await seed(
    "speech-probe-refused",
    ["dictation", "speech_model", "speech_probe"],
    {},
    {
      speech: unmeasured(),
      refuseProbe:
        "This host is hearing a take right now, so it can't time a model without getting in its way.",
    },
  )
  await mount(editor("/settings/bots/bot-1/speech-to-text"), async () => {
    await openSpeech()
    await until(
      () => /hearing a take right now/.test(find("[data-speech-probe]")?.textContent ?? ""),
      "the host's own sentence is what the sheet says",
    )
    assert.equal(speechOptions().length, 3, "and every model is still there to pick")
  })
})

test("a model picked in the sheet is written to the host, and the row says which is in play", async () => {
  const chosen = speech({ model: "base" })
  chosen.models = chosen.models.map((row) => ({
    ...row,
    in_use: row.name === "base",
  }))
  const calls = await seed(
    "speech-pick",
    ["dictation", "speech_model"],
    {},
    { speech: speech(), next: chosen },
  )
  await mount(editor("/settings/bots/bot-1/speech-to-text"), async () => {
    await openSpeech()
    await click(speechOption("base"))
    assert.deepEqual(writes(calls)[0]?.body, { model: "base" }, "one field, the model that moved")
    assert.equal(valueOf(row("speech-model")), "base", "the row names the new model")
    assert.equal(valueColour(row("speech-model")), "accent", "in the accent colour")
    await until(async () => speechOptions().length === 0, "the sheet to close behind the pick")
    assert.equal(findAll("[data-pick-list]").length, 0, "and nothing left open")
  })
})

test("a pick answered without the page's settings leaves every setting where it was", async () => {
  const calls = await seed(
    "speech-pick-keeps-stt",
    ["dictation", "speech_model", "stt_settings"],
    {},
    { speech: speech({ stt: STT() }), next: speech({ model: "base" }) },
  )
  await mount(editor("/settings/bots/bot-1/speech-to-text"), async () => {
    const before = findAll("[data-stt-group]").length
    assert.ok(before > 0, "the page draws the host's settings to begin with")
    await openSpeech()
    await click(speechOption("base"))
    assert.deepEqual(writes(calls)[0]?.body, { model: "base" }, "the pick was written")
    await until(async () => speechOptions().length === 0, "the sheet to close behind the pick")
    assert.equal(valueOf(row("speech-model")), "base", "the row names the new model")
    assert.equal(
      findAll("[data-stt-group]").length,
      before,
      "and the rest of the page is not lost until the next visit",
    )
  })
})

test("while the host times its models the note says so the same way, centered and pulsing", async () => {
  let finish = () => {}
  const held = new Promise<void>((resolve) => {
    finish = resolve
  })
  await seed(
    "speech-probe-measuring",
    ["dictation", "speech_model", "speech_probe"],
    {},
    { speech: unmeasured(), probed: speech(), holdProbe: held },
  )
  await mount(editor("/settings/bots/bot-1/speech-to-text"), async () => {
    await openSpeech()
    await until(
      () => /Timing this host's speech models…/.test(find("[data-speech-probe]")?.textContent ?? ""),
      "the note names the timing while the host works",
    )
    const note = find("[data-speech-probe]")
    assert.match(note?.className ?? "", /text-center/)
    assert.match(note?.className ?? "", /motion-safe:animate-/)
    finish()
    await until(
      () => /9\.4× realtime/.test(speechOption("base")?.textContent ?? ""),
      "the rows are redrawn once it answers",
    )
    assert.doesNotMatch(find("[data-speech-probe]")?.className ?? "", /text-center/)
  })
})

test("a host that lists no models leaves the Speech model row with nothing to open", async () => {
  await seed(
    "speech-nomodels",
    ["dictation", "speech_model"],
    {},
    { speech: speech({ models: [] }) },
  )
  await mount(editor("/settings/bots/bot-1/speech-to-text"), async () => {
    assert.equal(
      valueOf(row("speech-model")),
      "small",
      "the model the host has in play is still read",
    )
    assert.equal(row("speech-model")?.hasAttribute("disabled"), true, "and the row can't be tapped")
    await click(row("speech-model"))
    assert.equal(findAll("[data-pick-list]").length, 0, "so no sheet of nothing opens")
  })
})

test("a model the host refuses leaves the old one in place and shows the host's reason", async () => {
  const calls = await seed(
    "speech-refuse",
    ["dictation", "speech_model"],
    {},
    {
      speech: speech(),
      refuse: "Couldn't write config.yaml: the file is read-only.",
    },
  )
  await mount(editor("/settings/bots/bot-1/speech-to-text"), async () => {
    await openSpeech()
    await click(speechOption("base"))
    assert.deepEqual(writes(calls)[0]?.body, { model: "base" }, "the pick was written")
    assert.equal(valueOf(row("speech-model")), "small", "the old model stays in place")
    assert.equal(
      find('[role="alert"]')?.textContent?.trim(),
      "Couldn't write config.yaml: the file is read-only.",
      "the host's own sentence, in full",
    )
    assert.ok(
      speechPage()?.firstElementChild?.matches('[role="alert"]'),
      "and it leads the page, over both captions it reports for",
    )
    assert.equal(
      labelled('[role="alert"] button', "Try again") === null,
      true,
      "with no control: a write has nothing a retry could re-run",
    )
  })
})

test("a pick the host does not have says it is downloading", async () => {
  await seed(
    "speech-downloads",
    ["dictation", "speech_model"],
    {},
    {
      speech: speech({
        model: "large-v3",
        models: [
          {
            name: "base",
            size_mb: 145,
            measured: { realtime: 9.4, at: "2026-11-02T09:00:00Z" },
            keeps_up: true,
            recommended: false,
            downloaded: true,
            in_use: false,
            downloading: false,
          },
          {
            name: "small",
            size_mb: 484,
            measured: { realtime: 3.2, at: "2026-11-02T09:00:00Z" },
            keeps_up: true,
            recommended: false,
            downloaded: true,
            in_use: false,
            downloading: false,
          },
          {
            name: "large-v3",
            size_mb: 3090,
            measured: null,
            keeps_up: null,
            recommended: false,
            downloaded: false,
            in_use: true,
            downloading: true,
          },
        ],
      }),
    },
  )
  await mount(editor("/settings/bots/bot-1/speech-to-text"), async () => {
    await openSpeech()
    const downloading = speechOptions().find((option) =>
      (option.textContent ?? "").includes("downloads on the next take"),
    )
    assert.ok(downloading, "the option for the pick says it is downloading")
    assert.match(speechOption("large-v3")?.textContent ?? "", /In use · downloads on the next take/)
  })
})

test("Cleanup model reads Default where nothing is picked, and opens the bot's own models", async () => {
  await seed("cleanup-allowed", ["dictation", "speech_model"], {}, { speech: speech() })
  await mount(editor("/settings/bots/bot-1/speech-to-text"), async () => {
    assert.equal(valueOf(row("cleanup-model")), "Default", "nothing picked reads as the default")
    assert.equal(valueColour(row("cleanup-model")), "accent", "and the default is what is in play")
    await openCleanup()
    assert.equal(
      find('[data-slot="sheet-title"]')?.textContent,
      "Cleanup model",
      "the pick's sheet is titled Cleanup model",
    )
    assert.equal(
      modelRow("Default")?.getAttribute("aria-checked"),
      "true",
      "Default is the pick holding nothing means",
    )
    assert.ok(modelRow("Anthropic"), "and the bot's own providers sit under it")
  })
})

test("a cleanup model picked from a provider is written to the host, and the row names it", async () => {
  const calls = await seed(
    "cleanup-pick",
    ["dictation", "speech_model"],
    {},
    {
      speech: speech(),
      next: speech({
        cleanup: {
          model: { provider: "anthropic", model: "claude-x" },
          allowed: true,
          reason: null,
        },
      }),
    },
  )
  await mount(editor("/settings/bots/bot-1/speech-to-text"), async () => {
    await openCleanup()
    await click(modelRow("Anthropic"))
    await until(async () => Boolean(modelRow("claude-x")), "the provider's models")
    await click(modelRow("claude-x"))
    assert.deepEqual(
      writes(calls)[0]?.body,
      { cleanup_model: { provider: "anthropic", model: "claude-x" } },
      "one pick, the cleanup model that moved",
    )
    assert.equal(valueOf(row("cleanup-model")), "anthropic/claude-x", "the row names the pick")
    await until(async () => !modelRow("claude-x"), "the sheet to close behind the pick")
  })
})

test("the pick's Default row clears the cleanup model the bot had", async () => {
  const calls = await seed(
    "cleanup-clear",
    ["dictation", "speech_model"],
    {},
    {
      speech: speech({
        cleanup: {
          model: { provider: "anthropic", model: "claude-x" },
          allowed: true,
          reason: null,
        },
      }),
      next: speech(),
    },
  )
  await mount(editor("/settings/bots/bot-1/speech-to-text"), async () => {
    assert.equal(valueOf(row("cleanup-model")), "anthropic/claude-x", "the pick the bot holds")
    await openCleanup()
    assert.equal(
      modelRow("Default")?.getAttribute("aria-checked"),
      "false",
      "Default is not the one in play",
    )
    await click(modelRow("Default"))
    assert.deepEqual(
      writes(calls)[0]?.body,
      { cleanup_model: null },
      "clearing writes null, and nothing else",
    )
    assert.equal(valueOf(row("cleanup-model")), "Default", "and the row is back to the default")
  })
})

test("a host that withholds the model-override permission says so instead of offering it", async () => {
  const reason =
    "This host doesn't let Gots pick the model. Allow it with `hermes plugins enable gots`."
  await seed(
    "cleanup-denied",
    ["dictation", "speech_model"],
    {},
    { speech: speech({ cleanup: { model: null, allowed: false, reason } }) },
  )
  await mount(editor("/settings/bots/bot-1/speech-to-text"), async () => {
    const refused = row("cleanup-model")
    assert.ok(refused, "the row is still on the page")
    assert.deepEqual(
      lines(refused),
      ["Cleanup model", "Gots", reason, "Default"],
      "its purpose line is the host's own sentence, word for word",
    )
    assert.notEqual(refused?.tagName, "BUTTON", "with no pick behind it: a tap the host ignores")
    await click(refused)
    assert.equal(findAll("[data-pick-list]").length, 0, "so no sheet opens")
  })
})

/** The four cards the level picker draws, and which of them the host says is in play. */
const levelCards = () => findAll("[data-cleanup-level]")
const pressed = (level: string) =>
  findAll(`[data-cleanup-level="${level}"]`)[0]?.getAttribute("aria-pressed")

test("Cleanup level is one row that names the level, and its sheet offers all four", async () => {
  const calls = await seed(
    "cleanup-levels",
    ["dictation", "speech_model", "cleanup_level"],
    {},
    {
      speech: speech(),
      next: speech({ cleanup: { model: null, allowed: true, reason: null, level: "high" } }),
    },
  )
  await mount(editor("/settings/bots/bot-1/speech-to-text"), async () => {
    await until(async () => Boolean(row("cleanup-level")), "the Cleanup level row")
    assert.deepEqual(
      lines(row("cleanup-level")),
      ["Cleanup level", "Gots", "How much the tidying changes in a take", "Light"],
      "a title, its mark, what it decides, and the level in play",
    )
    assert.ok(
      missing("[data-cleanup-level]"),
      "no cards on the page itself: they live in the sheet",
    )
    await click(row("cleanup-level"))
    await until(async () => levelCards().length === 4, "the four levels")
    assert.equal(
      find('[data-slot="sheet-title"]')?.textContent,
      "Cleanup level",
      "the sheet is titled for the row it opened from",
    )
    assert.deepEqual(
      levelCards().map((card) => card.getAttribute("data-cleanup-level")),
      ["none", "light", "medium", "high"],
      "every level, weakest first",
    )
    assert.equal(pressed("light"), "true", "the one in play is marked")
    assert.equal(pressed("high"), "false", "and only one card is")
    assert.ok(
      levelCards().every((card) => (card.textContent ?? "").length > 40),
      "each card says what it changes and shows the same sentence at its level",
    )
    await click(find('[data-cleanup-level="high"]'))
    assert.deepEqual(writes(calls)[0]?.body, { cleanup_level: "high" }, "one level, written to the host")
    await until(
      async () => lines(row("cleanup-level"))[3] === "High",
      "the row naming the level the host now runs",
    )
    assert.ok(missing("[data-cleanup-level]"), "and the sheet closed behind the pick")
  })
})

test("the Hearing prompt row is not offered until Developer is on", async () => {
  await seed(
    "hearing-hidden",
    ["dictation", "speech_model", "cleanup_level", "hearing_prompt"],
    {},
    { speech: speech() },
  )
  await mount(editor("/settings/bots/bot-1/speech-to-text"), async () => {
    assert.equal(row("hearing-prompt"), null, "no Developer switch, no experimental row")
    assert.ok(row("cleanup-model"), "while the cleanup's own row is still there")
  })
})

test("a host that takes a level but not a Hearing prompt draws the level alone", async () => {
  await seed(
    "hearing-absent",
    ["dictation", "speech_model", "cleanup_level"],
    {},
    { speech: speech() },
  )
  await db.settings.update("settings", { developer: true })
  await mount(editor("/settings/bots/bot-1/speech-to-text"), async () => {
    assert.ok(row("cleanup-level"), "the level the host does take is offered")
    await until(async () => Boolean(row("cleanup-model")), "the cleanup's own rows")
    assert.equal(row("hearing-prompt"), null, "and no switch for the prompt it never took")
  })
})

test("a Developer's Hearing prompt switch is written to the host and read back", async () => {
  const calls = await seed(
    "hearing-shown",
    ["dictation", "speech_model", "cleanup_level", "hearing_prompt"],
    {},
    { speech: speech(), next: speech({ hearing: { sent: true } }) },
  )
  await db.settings.update("settings", { developer: true })
  await mount(editor("/settings/bots/bot-1/speech-to-text"), async () => {
    // The switch waits on the device's own read of the Developer flag, so it lands after the rows.
    await until(async () => Boolean(switchIn("hearing-prompt")), "the Hearing prompt switch")
    assert.ok(row("hearing-prompt"), "Developer on draws the row")
    assert.equal(
      switchIn("hearing-prompt")?.getAttribute("aria-checked"),
      "false",
      "a bot hears its takes unprompted until it says otherwise",
    )
    await click(switchIn("hearing-prompt"))
    assert.deepEqual(writes(calls)[0]?.body, { hearing_prompt: true }, "one switch, written to the host")
    await until(
      async () => switchIn("hearing-prompt")?.getAttribute("aria-checked") === "true",
      "the switch reading back on",
    )
    // The host answered the block it now holds, so this device's copy moves with it: the page a user
    // opens next draws the switch they set rather than the one before it.
    const profile = await db.profiles.get("bot-1")
    assert.ok(profile)
    await until(
      async () => (await db.speechCache.get(connectionKey(profile)))?.speech.hearing.sent === true,
      "the write kept on this device",
    )
  })
})

test("a host too old to take a level offers the cleanup model alone", async () => {
  await seed("levels-absent", ["dictation", "speech_model"], {}, { speech: speech() })
  await mount(editor("/settings/bots/bot-1/speech-to-text"), async () => {
    assert.ok(row("cleanup-model"), "the model's row is still there")
    assert.equal(row("cleanup-level"), null, "and no level the host would refuse to store")
  })
})

test("a provider pick is followed by the route it moved to, and Cleanup shuts at once", async () => {
  const written = STT({
    values: { "stt.provider": "groq" },
    provider: { name: "groq", explicit: "groq", reason: null },
  })
  await seed(
    "provider-cloud",
    ["dictation", "speech_model", "stt_settings", "cleanup_level"],
    {},
    {
      speech: speech({ stt: STT() }),
      nextStt: written,
      afterStt: speech({
        stt: written,
        provider: { name: "groq", backend: null, cloud: true },
      }),
    },
  )
  await mount(editor("/settings/bots/bot-1/speech-to-text"), async () => {
    await until(async () => Boolean(row("cleanup-level")), "the cleanup's card")
    assert.equal(off(row("cleanup-level")), false, "a local route keeps Cleanup live")
    await click(row("stt.provider"))
    const groq = findAll('[data-pick-list="Provider"] li > button').find((one) =>
      (one.textContent ?? "").includes("Groq"),
    )
    assert.ok(groq, "the Provider row offers the vendor")
    await click(groq)
    // The `stt` block a write answers with carries no route: the page reads again, and the card
    // shuts on the provider the bot has just moved to rather than on the one it left.
    await until(async () => off(row("cleanup-level")), "the card shut once the route moved")
    assert.equal(off(row("cleanup-level")), true, "and its level takes no taps")
  })
})

test("a host that hears takes elsewhere says where, in the provider's own name", async () => {
  await seed(
    "heard-by-vendor",
    ["dictation", "speech_model"],
    {},
    { speech: speech({ provider: { name: "groq", backend: null, cloud: true } }) },
  )
  await mount(editor("/settings/bots/bot-1/speech-to-text"), async () => {
    await until(async () => Boolean(row("heard-by")), "the row naming who hears a take")
    const drawn = lines(row("heard-by"))
    assert.equal(drawn[0], "Heard by", "the row names what it is about")
    assert.match(
      drawn.join(" "),
      /uploaded to this provider/,
      "and that the take goes off the host",
    )
    assert.equal(drawn.at(-1), "Groq", "with the provider the host resolves as its value")
  })
})

test("a host hearing takes on its own model draws no line about it", async () => {
  await seed(
    "heard-by-local",
    ["dictation", "speech_model"],
    {},
    { speech: speech({ provider: { name: "local", backend: "local", cloud: false } }) },
  )
  await mount(editor("/settings/bots/bot-1/speech-to-text"), async () => {
    await until(async () => Boolean(row("speech-model")), "the model row the page always draws")
    assert.equal(row("heard-by"), null, "the model row already says where takes are heard")
  })
})

test("the page opens on the last answer this device read, every row muted until a fresh one lands", async () => {
  const calls = await seed(
    "cached-page",
    ["dictation", "speech_model", "stt_settings", "cleanup_level"],
    {},
    { speech: speech({ stt: STT() }), stallSpeech: true },
  )
  await seedCache({ model: "base", stt: STT() })
  await mount(editor("/settings/bots/bot-1/speech-to-text"), async () => {
    await until(async () => Boolean(row("speech-model")), "the rows the cached copy holds")
    assert.equal(loading(), null, "rows rather than a loader")
    assert.equal(valueOf(row("speech-model")), "base", "the model this device last read")
    assert.equal(
      valueColour(row("speech-model")),
      "muted",
      "drawn muted: no fresh read confirms it",
    )
    for (const name of ["speech-model", "cleanup-level", "cleanup-model"])
      assert.equal(off(row(name)), true, `${name} takes no taps until the host answers`)
    await click(row("cleanup-level"))
    assert.equal(findAll("[data-cleanup-levels]").length, 0, "so a tap on it opens nothing")
    assert.deepEqual(writes(calls), [], "and nothing is written from a value that may be stale")
  })
})

test("a fresh answer replaces the cached copy and unlocks the page", async () => {
  await seed(
    "cached-fresh",
    ["dictation", "speech_model", "stt_settings", "cleanup_level"],
    {},
    { speech: speech({ model: "small", stt: STT() }) },
  )
  await seedCache({ model: "base", stt: STT() })
  await mount(editor("/settings/bots/bot-1/speech-to-text"), async () => {
    await until(async () => valueOf(row("speech-model")) === "small", "the fresh answer")
    assert.equal(off(row("speech-model")), false, "the row takes taps again")
    assert.equal(valueColour(row("speech-model")), "accent", "and reads as the value it holds")
    await click(row("cleanup-level"))
    await until(async () => Boolean(find("[data-cleanup-levels]")), "the level's own cards")
  })
})

test("a bot this device never read shows a loader in place of its rows", async () => {
  await seed(
    "cold-page",
    ["dictation", "speech_model", "stt_settings", "cleanup_level"],
    {},
    { speech: speech({ stt: STT() }), stallSpeech: true },
  )
  await mount(editor("/settings/bots/bot-1/speech-to-text"), async () => {
    assert.ok(loading(), "a page-level loader")
    assert.equal(row("speech-model"), null, "and no rows to read as an answer")
    assert.equal(row("cleanup-level"), null, "none of them")
  })
})

test("a failed read leaves the cached copy muted, under the host's own sentence", async () => {
  await seed(
    "cached-failed",
    ["dictation", "speech_model", "stt_settings"],
    {},
    { refuseSpeech: "Speech-to-text is turned off on this host." },
  )
  await seedCache({ model: "base", stt: STT() })
  await mount(editor("/settings/bots/bot-1/speech-to-text"), async () => {
    await until(async () => Boolean(find('[role="alert"]')), "the host's own sentence")
    assert.match(
      find('[role="alert"]')?.textContent ?? "",
      /turned off on this host/,
      "the reason the copy may be old",
    )
    assert.equal(valueOf(row("speech-model")), "base", "the cached answer stays under it")
    assert.equal(off(row("speech-model")), true, "muted, not trusted")
  })
})

test("a read the host refused says so, with a way to ask again, and the tap draws the page", async () => {
  const calls = await seed(
    "refused-read",
    ["dictation", "speech_model"],
    {},
    { speech: speech(), speechRefusals: 1 },
  )

  await mount(editor("/settings/bots/bot-1/speech-to-text"), async () => {
    const notice = '[data-bot-dictation] [role="alert"]'
    await until(async () => Boolean(find(notice)), "the refusal to be said")
    assert.equal(
      wordsOf(find(notice)),
      "Speech-to-text is turned off on this host.",
      "the notice holds the host's own sentence",
    )

    const retry = labelled(`${notice} button`, "Try again")
    assert.ok(retry, "and one control offering to ask the same read again")
    assert.equal(
      retry.getAttribute("title"),
      "Try again",
      "an icon, so the words it is named are what a reader hears",
    )
    assert.equal(wordsOf(retry), "", "and no label is drawn beside it")
    assert.equal(speechReads(calls).length, 1, "the page asked its speech read once, and was refused")

    await click(retry)
    await until(async () => valueOf(row("speech-model")) === "small", "the host's own answer")

    assert.equal(speechReads(calls).length, 2, "the tap asked the same route again, once")
    assert.ok(missing(notice), "the notice goes with it")
  })
})

test("a provider's page waits for the host rather than answering for it", async () => {
  await seed(
    "cold-provider",
    ["dictation", "speech_model", "stt_settings"],
    {},
    { speech: speech({ stt: STT() }), stallSpeech: true },
  )
  await mount(editor("/settings/bots/bot-1/speech-to-text/providers/groq"), async () => {
    assert.ok(loading(), "the page-level loader, as on the page it came from")
    assert.equal(
      find("[data-stt-provider]")?.textContent?.includes("doesn't declare"),
      false,
      "and no sentence about the host before it has answered",
    )
  })
})

test("a muted page's rows take no taps, so no measurement starts", async () => {
  const calls = await seed(
    "cached-probe",
    ["dictation", "speech_model", "speech_probe"],
    {},
    { speech: unmeasured(), stallSpeech: true },
  )
  await seedCache({ probe: unmeasured().probe })
  await mount(editor("/settings/bots/bot-1/speech-to-text"), async () => {
    await until(async () => Boolean(row("speech-model")), "the cached rows")
    await click(row("speech-model"))
    assert.equal(
      calls.filter((call) => call.path.endsWith("/speech/probe")).length,
      0,
      "a stale block puts the host to no work",
    )
  })
})

test("a bot whose takes leave the host greys Cleanup's rows and says nothing about it", async () => {
  const calls = await seed(
    "cleanup-cloud",
    ["dictation", "speech_model", "cleanup_level", "hearing_prompt"],
    {},
    {
      speech: speech({
        provider: { name: "groq", backend: null, cloud: true },
        hearing: { sent: false },
      }),
    },
  )
  await db.settings.update("settings", { developer: true })
  await mount(editor("/settings/bots/bot-1/speech-to-text"), async () => {
    await until(async () => Boolean(row("hearing-prompt")), "the cleanup's card")
    for (const name of ["cleanup-level", "cleanup-model"])
      assert.equal(off(row(name)), true, `the card is drawn as shut, ${name} takes no taps`)
    // The card's own words, read off the rows it draws: the greying is the whole of it.
    const card = row("cleanup-level")?.closest("[data-settings-group]")
    assert.equal(
      /only available|local models/i.test(card?.textContent ?? ""),
      false,
      "and no sentence explains the greying",
    )
    assert.equal(off(switchIn("hearing-prompt")), true, "nor the Hearing prompt's switch")
    await click(row("cleanup-level"))
    assert.equal(findAll("[data-cleanup-levels]").length, 0, "so nothing opens under it")
    assert.deepEqual(writes(calls), [], "and the row's value is not written")
  })
})

test("a bot that hears on its own host keeps Cleanup live", async () => {
  await seed(
    "cleanup-local",
    ["dictation", "speech_model", "cleanup_level"],
    {},
    { speech: speech({ provider: { name: "local", backend: "local", cloud: false } }) },
  )
  await mount(editor("/settings/bots/bot-1/speech-to-text"), async () => {
    await until(async () => Boolean(row("cleanup-level")), "the cleanup's card")
    assert.equal(off(row("cleanup-level")), false, "the level takes taps")
    assert.equal(off(row("cleanup-model")), false, "and so does the model")
    await click(row("cleanup-level"))
    await until(async () => Boolean(find("[data-cleanup-levels]")), "the level's own cards")
  })
})

test("a host that carries no level keeps the page it had, cloud route or not", async () => {
  await seed(
    "cleanup-old-host",
    ["dictation", "speech_model"],
    {},
    { speech: speech({ provider: { name: "groq", backend: null, cloud: true } }) },
  )
  await mount(editor("/settings/bots/bot-1/speech-to-text"), async () => {
    await until(async () => Boolean(row("cleanup-model")), "the cleanup's card")
    assert.equal(off(row("cleanup-model")), false, "and the model row stays as it was")
  })
})
