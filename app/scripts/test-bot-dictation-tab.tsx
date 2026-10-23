import assert from "node:assert/strict"
import test from "node:test"
import { useLiveQuery } from "dexie-react-hooks"
import { MemoryRouter, Route, Routes, useLocation, useParams } from "react-router"

import { BotEditor } from "@/components/bot-settings"
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
} from "./component-kit.tsx"

const speech = (patch: Record<string, unknown> = {}) => ({
  model: "small",
  models: [
    { name: "base", size_mb: 145, speed: 16, slow_on_cpu: false, downloaded: true, in_use: false, downloading: false },
    { name: "small", size_mb: 484, speed: 6, slow_on_cpu: false, downloaded: true, in_use: true, downloading: false },
    { name: "large-v3", size_mb: 3090, speed: 0.6, slow_on_cpu: true, downloaded: false, in_use: false, downloading: false },
  ],
  cleanup: { model: null, allowed: true, reason: null },
  ...patch,
})

type Speech = ReturnType<typeof speech>

function host(
  features: string[],
  options: { speech?: Speech; next?: Speech; refuse?: string; writers?: { model: boolean; provider: boolean } } = {},
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
  return <BotEditor key={profile.id} profile={profile} tab={botTabOf(tab) ?? "general"} />
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
const dictationTab = () =>
  findAll('[role="tab"]').find((tab) => tab.textContent?.trim() === "Dictation") ?? null
const chip = (word: string) => find(`[aria-label="Remove ${word}"]`)
const add = () => click(findAll("button").find((one) => one.textContent?.trim() === "Add") ?? null)

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

const modelRow = (name: string) =>
  findAll('[aria-label="Speech models"] button').find((row) =>
    row.textContent?.trim().startsWith(name),
  ) ?? null

test("a host that streams a take has a Dictation tab, and it holds the bot's words", async () => {
  await seed("streaming", ["dictation", "dictation_stream"], { vocabulary: ["Haseeb"] })
  await mount(editor("/settings/bots/bot-1/dictation"), async () => {
    assert.ok(dictationTab(), "the Dictation tab is on the editor")
    assert.ok(chip("Haseeb"), "the bot's word is on it")
    assert.equal(here(), "/settings/bots/bot-1/dictation", "the address is the tab's own")
  })
})

test("a host that can't stream has no Dictation tab, and its address lands on General", async () => {
  await seed("no-stream", ["dictation"])
  await mount(editor("/settings/bots/bot-1/dictation"), async () => {
    assert.equal(dictationTab(), null, "no Dictation tab")
    assert.equal(here(), "/settings/bots/bot-1", "the address is the bot's own")
    assert.match(text(), /Test connection/, "General is what is drawn")
  })
})

test("a word added on the screen is written into the bot's record", async () => {
  await seed("adding", ["dictation_stream"])
  await mount(editor("/settings/bots/bot-1/dictation"), async () => {
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
  await seed("repeated", ["dictation_stream"], { vocabulary: ["Gots"] })
  await mount(editor("/settings/bots/bot-1/dictation"), async () => {
    await type(find("#vocabulary-word"), "gots")
    await add()
    assert.equal((await db.profiles.get("bot-1"))?.vocabulary?.length, 1)
    assert.equal(chip("gots"), null, "the spelling it already has stands")
  })
})

test("a word removed from the tab leaves the record", async () => {
  await seed("removing", ["dictation_stream"], { vocabulary: ["Gots", "Haseeb"] })
  await mount(editor("/settings/bots/bot-1/dictation"), async () => {
    await click(chip("Haseeb"))
    assert.equal(chip("Haseeb"), null, "the word is gone from the tab")
    assert.deepEqual((await db.profiles.get("bot-1"))?.vocabulary, ["Gots"])
    assert.ok(chip("Gots"), "the words beside it stay")
  })
})

test("the tab lists the host's speech models with their size, speed and which is in use", async () => {
  await seed("speech-list", ["dictation_stream", "speech_model"], {}, { speech: speech() })
  await mount(editor("/settings/bots/bot-1/dictation"), async () => {
    const base = modelRow("base")
    assert.match(base?.textContent ?? "", /145 MB/, "the download is named")
    assert.match(base?.textContent ?? "", /16× realtime/, "and the speed it is weighed on")
    assert.equal(base?.getAttribute("aria-pressed"), "false")
    assert.match(modelRow("small")?.textContent ?? "", /In use/)
    assert.equal(modelRow("small")?.getAttribute("aria-pressed"), "true", "the one in play reads as chosen")
    assert.match(modelRow("large-v3")?.textContent ?? "", /Too slow on a CPU/)
    assert.match(modelRow("large-v3")?.textContent ?? "", /Not on this host/)
  })
})

test("a model picked on the tab is written to the host, and the list says which is in use", async () => {
  const chosen = speech({ model: "base" })
  chosen.models = chosen.models.map((row) => ({
    ...row,
    in_use: row.name === "base",
  }))
  const calls = await seed(
    "speech-pick",
    ["dictation_stream", "speech_model"],
    {},
    { speech: speech(), next: chosen },
  )
  await mount(editor("/settings/bots/bot-1/dictation"), async () => {
    await click(modelRow("base"))
    assert.deepEqual(calls[0]?.body, { model: "base" }, "one field, the model that moved")
    assert.equal(modelRow("base")?.getAttribute("aria-pressed"), "true")
    assert.match(modelRow("base")?.textContent ?? "", /In use/)
    assert.equal(modelRow("small")?.getAttribute("aria-pressed"), "false")
  })
})

test("a model the host refuses leaves the old one in place and shows the host's reason", async () => {
  const calls = await seed(
    "speech-refuse",
    ["dictation_stream", "speech_model"],
    {},
    {
      speech: speech(),
      refuse: "Couldn't write config.yaml: the file is read-only.",
    },
  )
  await mount(editor("/settings/bots/bot-1/dictation"), async () => {
    await click(modelRow("base"))
    assert.deepEqual(calls[0]?.body, { model: "base" })
    assert.equal(modelRow("small")?.getAttribute("aria-pressed"), "true", "the old model stays")
    assert.match(find("[role=\"alert\"]")?.textContent ?? "", /read-only/, "the host's own sentence")
  })
})

test("a pick the host does not have says it is downloading", async () => {
  await seed(
    "speech-downloads",
    ["dictation_stream", "speech_model"],
    {},
    {
      speech: speech({
        model: "large-v3",
        models: [
          { name: "base", size_mb: 145, speed: 16, slow_on_cpu: false, downloaded: true, in_use: false, downloading: false },
          { name: "small", size_mb: 484, speed: 6, slow_on_cpu: false, downloaded: true, in_use: false, downloading: false },
          { name: "large-v3", size_mb: 3090, speed: 0.6, slow_on_cpu: true, downloaded: false, in_use: true, downloading: true },
        ],
      }),
    },
  )
  await mount(editor("/settings/bots/bot-1/dictation"), async () => {
    const row = findAll("div").find((node) =>
      node.textContent?.includes("downloads on the next take"),
    )
    assert.ok(row, "the row says the pick is downloading")
  })
})

test("cleanup's model is offered where the host allows it, and explained where it doesn't", async () => {
  await seed("cleanup-allowed", ["dictation_stream", "speech_model"], {}, { speech: speech() })
  await mount(editor("/settings/bots/bot-1/dictation"), async () => {
    assert.ok(find("#cleanup-model"), "the one-line override is on the tab")
    assert.match(find("#cleanup-model")?.textContent ?? "", /Default/)
  })
})

test("a host that withholds the model-override permission says so instead of offering it", async () => {
  const reason = "This host doesn't let Gots pick the model. Allow it with `hermes plugins enable memento`."
  await seed(
    "cleanup-denied",
    ["dictation_stream", "speech_model"],
    {},
    { speech: speech({ cleanup: { model: null, allowed: false, reason } }) },
  )
  await mount(editor("/settings/bots/bot-1/dictation"), async () => {
    assert.equal(find("#cleanup-model"), null, "a pick the host would ignore is not offered")
    assert.match(text(), /doesn't let Gots pick the model/)
    assert.match(text(), /hermes plugins enable memento/)
  })
})
