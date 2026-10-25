import assert from "node:assert/strict"
import test from "node:test"
import { useLiveQuery } from "dexie-react-hooks"
import { MemoryRouter, Route, Routes, useLocation, useParams } from "react-router"

import { BotSettingsList, BotSettingsPage } from "@/components/bot-settings"
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

function host(
  features: string[],
  options: {
    speech?: Speech
    next?: Speech
    refuse?: string
    writers?: { model: boolean; provider: boolean }
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
  const { tab } = useParams()
  const profile = useLiveQuery(() => db.profiles.get("bot-1"), [])
  if (!profile) return null
  return (
    <>
      <BotSettingsList profile={profile} />
      <BotSettingsPage key={profile.id} profile={profile} tab={botTabOf(tab) ?? "general"} />
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
      <Route path="/settings/bots/:botId/:tab?" element={<LiveEditor />} />
    </Routes>
  </MemoryRouter>
)

const here = () => find("[data-here]")?.textContent
/** The page itself, and its row in the list beside it. */
const speechPage = () => find("[data-bot-dictation]")
const speechRow = () => find('[data-bot-page="speech-to-text"]')
const chip = (word: string) => find(`[aria-label="Remove ${word}"]`)
const add = () => click(findAll("button").find((one) => one.textContent?.trim() === "Add") ?? null)

/** The field a setting's own title sits over, and the line under that title. */
const fieldOf = (title: string) => {
  const label = findAll("[data-bot-dictation] [data-slot='field-label']").find(
    (node) => node.textContent?.trim() === title,
  )
  return label?.closest("[data-slot='field']") ?? null
}
const subtitleOf = (title: string) =>
  fieldOf(title)?.querySelector("[data-slot='field-description']")?.textContent
const headings = () => findAll("[data-bot-dictation] h2").map((node) => node.textContent?.trim())
const titlesIn = (name: string) =>
  findAll(`[data-bot-group="${name}"] [data-slot='field-label']`).map((node) =>
    node.textContent?.trim(),
  )

/** The one speech-model field, and the host's models it opens. */
const speechField = () => find("#speech-model")
const speechOptions = () => findAll('[aria-label="Speech models"] button')
const speechOption = (name: string) =>
  speechOptions().find((option) => option.textContent?.trim().startsWith(name)) ?? null
const openSpeech = async () => {
  await click(speechField())
  await until(async () => speechOptions().length > 0, "the host's speech models")
}

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

test("a host that can hear speech has a Speech-to-text page, and it holds the bot's words", async () => {
  await seed("dictating", ["dictation"], { vocabulary: ["Haseeb"] })
  await mount(editor("/settings/bots/bot-1/speech-to-text"), async () => {
    assert.ok(speechRow(), "the Speech-to-text row is in the list beside the page")
    assert.ok(speechPage(), "and the page is the one drawn")
    assert.ok(chip("Haseeb"), "the bot's word is on it")
    assert.equal(here(), "/settings/bots/bot-1/speech-to-text", "the address is the page's own")
  })
})

test("a host that can't hear speech has no Speech-to-text page, and its address lands on General", async () => {
  await seed("no-dictation", ["speech_model"])
  await mount(editor("/settings/bots/bot-1/speech-to-text"), async () => {
    assert.equal(speechRow(), null, "no Speech-to-text row")
    assert.equal(speechPage(), null, "no Speech-to-text page")
    assert.equal(here(), "/settings/bots/bot-1/general", "the address is General's")
    assert.match(text(), /Test connection/, "General is what is drawn")
  })
})

test("a word added on the screen is written into the bot's record", async () => {
  await seed("adding", ["dictation"])
  await mount(editor("/settings/bots/bot-1/speech-to-text"), async () => {
    await type(find("#vocabulary-word"), "Gots")
    await add()
    assert.ok(chip("Gots"), "the word is on the tab")
    const saved = await db.profiles.get("bot-1")
    assert.deepEqual(saved?.vocabulary, ["Gots"])
    assert.ok((saved?.updatedAt ?? 0) > 1, "the record is stamped as changed")
    assert.equal(find("#vocabulary-word")?.getAttribute("value") ?? "", "", "the field is empty")
  })
})

test("a word the list already holds is not added again", async () => {
  await seed("repeated", ["dictation"], { vocabulary: ["Gots"] })
  await mount(editor("/settings/bots/bot-1/speech-to-text"), async () => {
    await type(find("#vocabulary-word"), "gots")
    await add()
    assert.equal((await db.profiles.get("bot-1"))?.vocabulary?.length, 1)
    assert.equal(chip("gots"), null, "the spelling it already has stands")
  })
})

test("a word removed from the tab leaves the record", async () => {
  await seed("removing", ["dictation"], { vocabulary: ["Gots", "Haseeb"] })
  await mount(editor("/settings/bots/bot-1/speech-to-text"), async () => {
    await click(chip("Haseeb"))
    assert.equal(chip("Haseeb"), null, "the word is gone from the tab")
    assert.deepEqual((await db.profiles.get("bot-1"))?.vocabulary, ["Gots"])
    assert.ok(chip("Gots"), "the words beside it stay")
  })
})

test("the page splits into Gots's settings and Hermes's, in that order", async () => {
  await seed("grouped", ["dictation", "speech_model"], {}, { speech: speech() })
  await mount(editor("/settings/bots/bot-1/speech-to-text"), async () => {
    assert.deepEqual(
      headings(),
      ["Gots Specific Settings", "Hermes Settings"],
      "the two ownership headings, Gots's first",
    )
    assert.deepEqual(
      titlesIn("gots"),
      ["Vocabulary", "Cleanup model"],
      "the bot's own speech settings under Gots's heading",
    )
    assert.deepEqual(titlesIn("hermes"), ["Speech model"], "the host's model under Hermes's")
    assert.equal(
      subtitleOf("Vocabulary"),
      "The words this bot's speech leans towards",
      "Vocabulary's line",
    )
    assert.equal(
      subtitleOf("Cleanup model"),
      "The model that tidies a take's finished words",
      "Cleanup model's line",
    )
    assert.equal(
      subtitleOf("Speech model"),
      "The model that hears this bot's speech-to-text",
      "Speech model's line",
    )
  })
})

test("the Vocabulary title sits over the word input and its chips", async () => {
  await seed(
    "vocabulary-field",
    ["dictation", "speech_model"],
    { vocabulary: ["Haseeb"] },
    { speech: speech() },
  )
  await mount(editor("/settings/bots/bot-1/speech-to-text"), async () => {
    const field = fieldOf("Vocabulary")
    assert.ok(field?.querySelector("#vocabulary-word"), "the word input is inside the field")
    assert.ok(field?.contains(chip("Haseeb")), "and so are the words already there")
    assert.equal(
      field?.querySelector('[aria-label="Words"]')?.tagName,
      "UL",
      "the list of words is the field's own",
    )
  })
})

test("the speech model is one field naming the model in play, over the host's own models", async () => {
  await seed("speech-picker", ["dictation", "speech_model"], {}, { speech: speech() })
  await mount(editor("/settings/bots/bot-1/speech-to-text"), async () => {
    assert.equal(findAll("#speech-model").length, 1, "one control rather than a row per model")
    assert.equal(
      speechField()?.getAttribute("aria-label"),
      "Speech model: small",
      "it names the model in play",
    )
    await openSpeech()
    assert.equal(
      findAll('[aria-label="Speech models"] input').length,
      0,
      "no search over a list this short",
    )
    assert.equal(speechOptions().length, 3, "one option for each model on the host")
    assert.equal(speechOption("small")?.getAttribute("aria-pressed"), "true", "the one in play")
    assert.equal(speechOption("base")?.getAttribute("aria-pressed"), "false")
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

test("a model picked in the list is written to the host, and the field says which is in play", async () => {
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
    assert.equal(
      speechField()?.getAttribute("aria-label"),
      "Speech model: base",
      "the field names the new model",
    )
    await until(async () => speechOptions().length === 0, "the list to close behind the pick")
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
    assert.deepEqual(calls[0]?.body, { model: "base" })
    assert.equal(
      speechField()?.getAttribute("aria-label"),
      "Speech model: small",
      "the old model stays",
    )
    assert.match(find('[role="alert"]')?.textContent ?? "", /read-only/, "the host's own sentence")
    assert.ok(
      find("[data-bot-dictation]")?.firstElementChild?.querySelector('[role="alert"]'),
      "and it leads the page, over both groups it reports for",
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
    const row = speechOptions().find((option) =>
      (option.textContent ?? "").includes("downloads on the next take"),
    )
    assert.ok(row, "the option for the pick says it is downloading")
  })
})

test("cleanup's model is offered where the host allows it, and explained where it doesn't", async () => {
  await seed("cleanup-allowed", ["dictation", "speech_model"], {}, { speech: speech() })
  await mount(editor("/settings/bots/bot-1/speech-to-text"), async () => {
    assert.ok(find("#cleanup-model"), "the one-line override is on the tab")
    assert.match(find("#cleanup-model")?.textContent ?? "", /Default/)
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
    assert.equal(find("#cleanup-model"), null, "a pick the host would ignore is not offered")
    assert.match(text(), /doesn't let Gots pick the model/)
    assert.match(text(), /hermes plugins enable memento/)
  })
})
