import assert from "node:assert/strict"
import test from "node:test"

import {
  speech,
  editor,
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
  modelRow,
  openCleanup,
  vocabulary,
  removeButton,
  addField,
  detailButton,
  add,
  draft,
  seed,
  switchIn,
} from "./dictation-page-kit.tsx"
import { click, find, findAll, mount, text, type, until } from "./component-kit.tsx"
import { db } from "@/lib/db"

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

test("a host that can't hear speech has no Speech-to-text page, and its address lands on General", async () => {
  await seed("no-dictation", ["speech_model"])
  await mount(editor("/settings/bots/bot-1/speech-to-text"), async () => {
    assert.ok(!speechRow(), "no Speech-to-text row")
    assert.ok(!speechPage(), "no Speech-to-text page")
    assert.ok(!row("vocabulary"), "and no setting to read")
    assert.equal(here(), "/settings/bots/bot-1/general", "the address is General's")
    assert.match(text(), /Test connection/, "General is what is drawn")
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
    assert.ok(addField(), "and the field to add a word is on the screen")
    assert.doesNotMatch(body, /No words yet\./, "the empty line stays away while words are held")
  })
})

test("the Vocabulary detail says No words yet. where the bot holds none", async () => {
  await seed("vocabulary-empty", ["dictation"])
  await mount(editor("/settings/bots/bot-1/speech-to-text/vocabulary"), async () => {
    assert.match(vocabulary()?.textContent ?? "", /No words yet\./, "the empty list says so")
    assert.ok(!removeButton("Gots"), "with no word to remove")
    assert.equal(detailButton("Add")?.hasAttribute("disabled"), true, "and nothing to add yet")
  })
})

test("a word added on the screen is written into the bot's record", async () => {
  await seed("adding", ["dictation"])
  await mount(editor("/settings/bots/bot-1/speech-to-text/vocabulary"), async () => {
    assert.equal(detailButton("Add")?.hasAttribute("disabled"), true, "Add waits for a word")
    await type(addField(), "Gots")
    assert.equal(
      detailButton("Add")?.hasAttribute("disabled"),
      false,
      "and opens once one is typed",
    )
    await add()
    assert.ok(removeButton("Gots"), "the word is on the screen")
    const saved = await db.profiles.get("bot-1")
    assert.deepEqual(saved?.vocabulary, ["Gots"], "and in the bot's record")
    assert.ok((saved?.updatedAt ?? 0) > 1, "the record is stamped as changed")
    assert.equal(draft(), "", "the field is empty again")
  })
})

test("a word the list already holds is not added again", async () => {
  await seed("repeated", ["dictation"], { vocabulary: ["Gots"] })
  await mount(editor("/settings/bots/bot-1/speech-to-text/vocabulary"), async () => {
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
    assert.ok(!removeButton("Haseeb"), "the word is gone from the screen")
    assert.deepEqual((await db.profiles.get("bot-1"))?.vocabulary, ["Gots"])
    assert.ok(removeButton("Gots"), "the words beside it stay")
  })
})

test("the Vocabulary detail's Done takes the page back over the list", async () => {
  await seed("vocabulary-done", ["dictation"], { vocabulary: ["Gots"] })
  await mount(editor("/settings/bots/bot-1/speech-to-text/vocabulary"), async () => {
    await click(detailButton("Done"))
    assert.equal(here(), "/settings/bots/bot-1/speech-to-text", "the page's own address")
    assert.ok(speechPage(), "and the page is drawn again")
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
      /16× realtime/,
      "and the speed it is weighed on",
    )
    assert.match(speechOption("small")?.textContent ?? "", /In use/)
    assert.match(speechOption("large-v3")?.textContent ?? "", /Too slow on a CPU/)
    assert.match(speechOption("large-v3")?.textContent ?? "", /Not on this host/)
    const clearing = speechOptions().find((option) =>
      /\b(default|none|clear)\b/i.test(option.textContent ?? ""),
    )
    assert.equal(clearing, undefined, "no default or clearing pick: a take always has a model")
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
    assert.deepEqual(calls[0]?.body, { model: "base" }, "one field, the model that moved")
    assert.equal(valueOf(row("speech-model")), "base", "the row names the new model")
    assert.equal(valueColour(row("speech-model")), "accent", "in the accent colour")
    await until(async () => speechOptions().length === 0, "the sheet to close behind the pick")
    assert.equal(findAll("[data-pick-list]").length, 0, "and nothing left open")
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
    assert.deepEqual(calls[0]?.body, { model: "base" }, "the pick was written")
    assert.equal(valueOf(row("speech-model")), "small", "the old model stays in place")
    assert.equal(
      find('[role="alert"]')?.textContent?.trim(),
      "Couldn't write config.yaml: the file is read-only.",
      "the host's own sentence, in full",
    )
    assert.ok(
      speechPage()?.firstElementChild?.querySelector('[role="alert"]'),
      "and it leads the page, over both captions it reports for",
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
            downloaded: true,
            in_use: false,
            downloading: false,
          },
          {
            name: "large-v3",
            size_mb: 3090,
            speed: 0.6,
            slow_on_cpu: true,
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
      modelRow("Default")?.getAttribute("aria-pressed"),
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
      calls[0]?.body,
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
      modelRow("Default")?.getAttribute("aria-pressed"),
      "false",
      "Default is not the one in play",
    )
    await click(modelRow("Default"))
    assert.deepEqual(
      calls[0]?.body,
      { cleanup_model: null },
      "clearing writes null, and nothing else",
    )
    assert.equal(valueOf(row("cleanup-model")), "Default", "and the row is back to the default")
  })
})

test("a host that withholds the model-override permission says so instead of offering it", async () => {
  const reason =
    "This host doesn't let Gots pick the model. Allow it with `hermes plugins enable memento`."
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
    assert.deepEqual(levelCards(), [], "no cards on the page itself: they live in the sheet")
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
    assert.deepEqual(calls[0]?.body, { cleanup_level: "high" }, "one level, written to the host")
    await until(async () => lines(row("cleanup-level"))[3] === "High", "the row naming the level the host now runs")
    assert.deepEqual(levelCards(), [], "and the sheet closed behind the pick")
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
  await seed("hearing-absent", ["dictation", "speech_model", "cleanup_level"], {}, { speech: speech() })
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
    assert.deepEqual(calls[0]?.body, { hearing_prompt: true }, "one switch, written to the host")
    await until(
      async () => switchIn("hearing-prompt")?.getAttribute("aria-checked") === "true",
      "the switch reading back on",
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
    assert.match(drawn.join(" "), /uploaded to this provider/, "and that the take goes off the host")
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
