/**
 * The Speech-to-text page over a seeded device database and a faked host, as ADR 0055 draws it: the
 * page only where the host hears speech; its groups as cards under the captions "Gots" and "Hermes",
 * with no heading anywhere; each setting a value row whose title, purpose line and value a user
 * reads, the value in the accent colour and "Not set" muted where it holds nothing; the Vocabulary
 * row drilling into the words themselves, adding and removing them; the speech model picking from
 * the host's models in a bottom sheet; the cleanup model picking through the composer's own picker,
 * where "Default" clears it; a host's refusal leaving the model that was in play, and its sentence
 * leading the page; a model the host is downloading saying so in its notes; and cleanup being
 * explained, not offered, where the host disallows it.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { useLiveQuery } from "dexie-react-hooks"
import { MemoryRouter, Route, Routes, useLocation, useParams } from "react-router"

import { BotSettingsList, BotSettingsPage } from "@/components/bot-settings"
import { botSubOf } from "@/lib/bot-subs"
import { botTabOf } from "@/lib/bot-tabs"
import { db } from "@/lib/db"
import {
  botProfile,
  click,
  find,
  findAll,
  json,
  mount,
  seedSettings,
  text,
  type,
  until,
} from "./component-kit.tsx"

const speech = (patch: Record<string, unknown> = {}) => ({
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
      downloaded: true,
      in_use: true,
      downloading: false,
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
  cleanup: { model: null, allowed: true, reason: null },
  ...patch,
})

type Speech = ReturnType<typeof speech>

/** The bot's Hermes models, as `/api/model/options` answers them: two providers to pick between. */
const BOT_MODELS = {
  model: "test/model",
  provider: "openrouter",
  providers: [
    {
      slug: "openrouter",
      name: "OpenRouter",
      authenticated: true,
      models: ["openrouter/one", "openrouter/two"],
    },
    { slug: "anthropic", name: "Anthropic", authenticated: true, models: ["claude-x"] },
  ],
}

function host(
  features: string[],
  options: {
    speech?: Speech
    next?: Speech
    refuse?: string
    writers?: { model: boolean; provider: boolean }
    /** The bot's models, as the cleanup pick's own picker reads them. */
    models?: unknown
  } = {},
) {
  const calls: { path: string; method: string; body: unknown }[] = []
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    const method = init?.method ?? "GET"
    if (path.endsWith("/api/plugins/memento/info"))
      return json({
        features,
        research: { writers: options.writers ?? { model: true, provider: true } },
      })
    // The bot's Hermes, which the cleanup pick's own picker lists: two providers, so the picker
    // offers its "Default" row over them rather than drilling into the only one it has.
    if (path.endsWith("/api/model/options")) return json(options.models ?? BOT_MODELS)
    if (path.endsWith("/api/plugins/memento/speech")) {
      if (method === "POST") {
        const body = init?.body ? JSON.parse(String(init.body)) : undefined
        calls.push({ path, method, body })
        if (options.refuse) return json({ error: { message: options.refuse } }, 400)
        return json({ speech: options.next ?? options.speech })
      }
      if (!options.speech) return json({}, 404)
      return json({ speech: options.speech })
    }
    return json({}, 404)
  }
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls }
}

function LiveEditor() {
  const { tab, sub } = useParams()
  const profile = useLiveQuery(() => db.profiles.get("bot-1"), [])
  if (!profile) return null
  const botTab = botTabOf(tab) ?? "general"
  // The fourth segment names a page's own sub-screen, as the settings route resolves it.
  const botSub = tab && sub ? botSubOf(botTab, sub) : undefined
  return (
    <>
      <BotSettingsList profile={profile} />
      <BotSettingsPage key={profile.id} profile={profile} tab={botTab} sub={botSub} />
    </>
  )
}

function Where() {
  const location = useLocation()
  return <span data-here>{location.pathname}</span>
}

const editor = (path: string) => (
  <MemoryRouter initialEntries={[path]}>
    <Where />
    <Routes>
      <Route path="/settings/bots/:botId/:tab?/:sub?" element={<LiveEditor />} />
    </Routes>
  </MemoryRouter>
)

const here = () => find("[data-here]")?.textContent
/** The page itself, and its row in the list beside it. */
const speechPage = () => find("[data-bot-dictation]")
const speechRow = () => find('[data-bot-page="speech-to-text"]')
/** A setting's value row, by the name its page gives it. */
const row = (name: string) => find(`[data-setting="${name}"]`)

/**
 * The lines a row draws, top to bottom: its title, the purpose line where it has one, and its value.
 * Each is a leaf, so this reads what a user reads rather than the spans it is wrapped in.
 */
const lines = (element: Element | null) =>
  [...(element?.querySelectorAll("span") ?? [])]
    .filter((span) => !span.querySelector("*"))
    .map((span) => span.textContent?.trim() ?? "")
const titleOf = (element: Element | null) => lines(element)[0] ?? ""
const valueOf = (element: Element | null) => lines(element).at(-1) ?? ""
/** Whether a row's value wears the accent colour, or is muted because it holds nothing. */
const valueColour = (element: Element | null) => {
  const leaf = [...(element?.querySelectorAll("span") ?? [])].filter(
    (span) => !span.querySelector("*"),
  )
  const className = leaf.at(-1)?.getAttribute("class") ?? ""
  if (className.includes("text-primary")) return "accent"
  return className.includes("text-muted-foreground") ? "muted" : "neither"
}

/** The captions the page draws over its cards, in the order it draws them. */
const captions = () =>
  findAll("[data-bot-dictation] > p").map((node) => node.textContent?.trim() ?? "")

/** Which settings sit under which caption, in drawing order: a page's cards, as a user sees them. */
function captioned() {
  const found: Record<string, string[]> = {}
  let caption = ""
  for (const block of [...(speechPage()?.children ?? [])]) {
    if (block.tagName === "P") {
      caption = block.textContent?.trim() ?? ""
      found[caption] = []
      continue
    }
    for (const setting of [...block.querySelectorAll("[data-setting]")])
      if (caption) (found[caption] ??= []).push(titleOf(setting))
  }
  return found
}

const headings = () => findAll("[data-bot-dictation] h2").map((node) => node.textContent?.trim())
/** The chevrons ADR 0055 took off every row: nothing on the page draws one. */
const chevrons = () =>
  findAll("[data-bot-dictation] svg").filter((svg) =>
    (svg.getAttribute("class") ?? "").includes("chevron"),
  )

/** The sheet the Speech model row opens, and the options it lists. */
const speechSheet = () => find('[data-pick-list="Speech models"]')
const speechOptions = () => findAll('[data-pick-list="Speech models"] > button')
/** The option wearing the tick: the model the host has in play. */
const speechInPlay = () => speechOptions().find((option) => option.querySelector("svg")) ?? null
const speechOption = (name: string) =>
  speechOptions().find((option) => (option.textContent ?? "").trim().startsWith(name)) ?? null
const openSpeech = async () => {
  await click(row("speech-model"))
  await until(async () => speechOptions().length > 0, "the host's speech models")
}

/** A row the cleanup pick's own picker draws, by the name it starts with. */
const modelRow = (label: string) =>
  findAll("button").find((button) => (button.textContent ?? "").startsWith(label)) ?? null
const openCleanup = async () => {
  await click(row("cleanup-model"))
  await until(async () => Boolean(modelRow("Default")), "the bot's own models")
}

/** The Vocabulary detail's own pieces: a word's remove button, the add field, and the buttons. */
const vocabulary = () => find("[data-vocabulary]")
const removeButton = (word: string) => find(`[aria-label="Remove ${word}"]`)
const addField = () => find('[aria-label="Add a word"]')
const detailButton = (label: string) =>
  findAll("[data-vocabulary] button").find((one) => one.textContent?.trim() === label) ?? null
const add = () => click(detailButton("Add"))
/** What the add field holds now, as the user reads it. */
const draft = () => (addField() as HTMLInputElement | null)?.value ?? null

async function seed(
  name: string,
  features: string[],
  patch = {},
  options: Parameters<typeof host>[1] = {},
) {
  await seedSettings()
  await db.profiles.clear()
  await db.profiles.put(botProfile(name, patch))
  const server = host(features, options)
  globalThis.fetch = server.fetch
  return server.calls
}

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

test("the page is captioned Gots and Hermes, its rows under them, with no heading or chevron", async () => {
  await seed(
    "grouped",
    ["dictation", "speech_model"],
    { vocabulary: ["Gots", "Haseeb", "Whisper"] },
    { speech: speech() },
  )
  await mount(editor("/settings/bots/bot-1/speech-to-text"), async () => {
    assert.deepEqual(captions(), ["Gots", "Hermes"], "one muted caption over each owner's card")
    assert.deepEqual(
      captioned(),
      { Gots: ["Vocabulary", "Cleanup model"], Hermes: ["Speech model"] },
      "each setting under the caption of the owner it belongs to",
    )
    assert.deepEqual(headings(), [], "no group headings: the captions took their place")
    assert.deepEqual(chevrons(), [], "and no row draws a chevron")
    assert.equal(
      findAll("[data-bot-dictation] input").length,
      0,
      "no text box sits inside a settings card",
    )
    assert.deepEqual(
      lines(row("vocabulary")),
      ["Vocabulary", "The words this bot's speech leans towards", "3 words"],
      "Vocabulary's title, its line and its value",
    )
    assert.deepEqual(
      lines(row("cleanup-model")),
      ["Cleanup model", "The model that tidies a take's finished words", "Default"],
      "Cleanup model's three lines, its value the default",
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
      ["Cleanup model", reason, "Default"],
      "its purpose line is the host's own sentence, word for word",
    )
    assert.notEqual(refused?.tagName, "BUTTON", "with no pick behind it: a tap the host ignores")
    await click(refused)
    assert.equal(findAll("[data-pick-list]").length, 0, "so no sheet opens")
  })
})
