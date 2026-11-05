/**
 * A bot's models, over a seeded device database and a faked host (ADR 0055, ADR 0104): the Models
 * page's Gots triage row and its own model pick, and — on General, where Hermes's Dashboard keeps
 * them — the host's main model and the chain it falls back on, the chain drilling into a screen of
 * its own. Every setting is a title over the line saying what it is for and the value it holds in
 * the accent colour, each value opening its pick as a bottom sheet.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { useLiveQuery } from "dexie-react-hooks"
import { MemoryRouter, Route, Routes, useParams } from "react-router"

import { BotSettingsPage } from "@/components/bot-settings"
import { Screen } from "@/components/settings-chrome"
import { botPageOf } from "@/lib/bot-tabs"
import { botSubOf } from "@/lib/bot-subs"
import { botTabOf } from "@/lib/bot-tabs"
import { db } from "@/lib/db"
import {
  Path,
  absent,
  botProfile,
  click,
  find,
  findAll,
  json,
  mount,
  path,
  seedSettings,
  until,
  wordsOf,
} from "./component-kit.tsx"

/** The triage row's purpose line, as the page words it. */
const TRIAGE = "Whether a message from Main starts a new thread or continues one"

type Choice = { provider: string; model: string }
type Sent = { method: string; path: string; body: Record<string, unknown> | null }

function LivePage() {
  const { tab, sub } = useParams()
  const profile = useLiveQuery(() => db.profiles.get("bot-1"), [])
  if (!profile) return null
  const shown = botTabOf(tab) ?? "general"
  const own = botSubOf(shown, sub)
  // The screen a page wears, so a page's own header action — the chain's add — is drawn where it is
  // in the app: at the header's right edge, over the page.
  return (
    <Screen title={own?.title ?? botPageOf(shown).title}>
      <BotSettingsPage key={profile.id} profile={profile} tab={shown} sub={own} />
    </Screen>
  )
}

/** The page at a bot's address, as the settings route mounts it. */
const page = (entry: string) => (
  <MemoryRouter initialEntries={[entry]}>
    <Path />
    <Routes>
      <Route path="/settings/bots/:botId/:tab?/:sub?" element={<LivePage />} />
    </Routes>
  </MemoryRouter>
)

/**
 * A host answering the plugin's `info` (its features, version, and whether it lets Gots pick the
 * model), the triage and fallback routes, its model list and the write that makes a model its main
 * one — and recording every request, so a test can read what a pick wrote.
 */
function host({
  features = ["general_page", "triage_model", "fallbacks", "host_model"],
  writers = true,
  models = ["own-model", "cheap-model"],
  triage = null as Choice | null,
  fallbacks = [] as Choice[],
}: {
  features?: string[]
  /** Whether the host lets Gots pick the model: its `research.writers` answer. */
  writers?: boolean
  models?: string[]
  triage?: Choice | null
  fallbacks?: Choice[]
} = {}) {
  const calls: Sent[] = []
  let pick = triage
  let chain = fallbacks
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = (init?.method ?? "GET").toUpperCase()
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ method, path: url.pathname, body })
    if (url.pathname.endsWith("/plugins/memento/info"))
      return json({
        name: "memento",
        version: "0.81.0",
        features,
        research: { writers: { model: writers, provider: writers } },
      })
    if (url.pathname.endsWith("/plugins/memento/triage-model")) {
      if (method === "POST") pick = body?.triage_model ?? null
      return json({ triage_model: pick })
    }
    if (url.pathname.endsWith("/plugins/memento/fallbacks")) {
      if (method === "POST") chain = body?.fallbacks ?? []
      return json({ fallbacks: chain })
    }
    if (url.pathname.endsWith("/api/model/options"))
      return json({
        model: "own-model",
        provider: "openrouter",
        providers: [
          {
            slug: "openrouter",
            name: "OpenRouter",
            is_current: true,
            authenticated: true,
            models,
          },
        ],
      })
    if (url.pathname.endsWith("/models")) return json({ data: models.map((id) => ({ id })) })
    return json({})
  }
  return { calls, fetch: fetch as unknown as typeof globalThis.fetch, chain: () => chain }
}

/** A bot of this test's own: its connection names a host, so no other test's answers are read. */
async function seed(name: string, options: Parameters<typeof host>[0] = {}, patch = {}) {
  await seedSettings()
  await db.profiles.clear()
  await db.profiles.put(botProfile(name, patch))
  const server = host(options)
  globalThis.fetch = server.fetch
  return server.calls
}

/** What a user reads on an element, with its spacing flattened. */
/** The page this test mounted: Models' block, or General's. */
const root = () => find("[data-bot-models]") ?? find("[data-bot-general]")
/** Waits for what this screen draws: a General read lands after the screen does, and the chain is a
 * screen of its own. */
const drawn = () => until(async () => Boolean(root() ?? chain()), "the page")
/** Any heading the page still draws: the captions replaced them. */
const headings = () =>
  [...(root()?.querySelectorAll("h1, h2, h3") ?? [])].map((one) => one.textContent?.trim())
/** A caption: the muted line standing over a card of its own. */
const caption = (title: string) =>
  [...(root()?.querySelectorAll("p") ?? [])].find((one) => wordsOf(one) === title) ?? null
/** The settings the page draws, in the order it draws them. */
const rows = () =>
  [...(root()?.querySelectorAll("[data-setting]") ?? [])].map((one) =>
    one.getAttribute("data-setting"),
  )
/** A setting's row, what a user reads on it, and the value it holds in the accent colour. */
const row = (id: string) =>
  [...(root()?.querySelectorAll("[data-setting]") ?? [])].find(
    (one) => one.getAttribute("data-setting") === id,
  ) ?? null
const rowText = (id: string) => wordsOf(row(id))
const accent = (id: string) => row(id)?.querySelector(".text-primary")?.textContent ?? null
/** A model a model pick offers, in the sheet it opened. */
const modelOption = (name: string) =>
  findAll("[aria-pressed]").find((one) => wordsOf(one) === name) ?? null
/** Opens a setting's pick, and waits for the sheet it opens. */
async function openPick(id: string) {
  await click(row(id))
  await until(async () => Boolean(find("[aria-pressed]")), "the model pick")
}
/** The chain's own screen: its rows, the button that removes one, and the way to add one. */
const chain = () => find("[data-fallbacks]")
const chainRows = () =>
  findAll("[data-fallbacks] [data-fallback]").map((one) => one.getAttribute("data-fallback"))
const chainRow = (place: number) => find(`[data-fallbacks] [data-fallback="${place}"]`)
const chainValue = (place: number) =>
  chainRow(place)?.querySelector(".text-primary")?.textContent ?? null
const remove = (place: number) => find(`[aria-label="Remove fallback ${place}"]`)
/** Adding is the screen's header action, at a phone width as much as a wide one. */
const addFallback = () => find('[aria-label="Add fallback"]')

test("the Models page is the Gots triage row and the model a chat runs", async () => {
  await seed("chat-groups")
  await mount(page("/settings/bots/bot-1/models"), async () => {
    assert.deepEqual(headings(), [], "no headings: the captions name the cards")
    assert.equal(
      caption("Gots")?.textContent?.trim(),
      "Gots",
      "the triage pick is Gots's, under its own caption",
    )
    assert.equal(
      caption("Hermes")?.textContent?.trim(),
      "Hermes",
      "the rest are the bot's Hermes's",
    )
    assert.deepEqual(
      rows(),
      ["triage-model", "model"],
      "every setting, in the order the page draws them, under the owner it belongs to",
    )
    assert.ok(
      wordsOf(root()).indexOf("Gots") < wordsOf(root()).indexOf("Hermes"),
      "Gots's caption comes before the Hermes card it does not name",
    )
    assert.doesNotMatch(
      wordsOf(root()),
      /Subagent model/,
      "Subagent model is General's, not this page's",
    )
  })
})

test("the triage row says what the model decides, and no pop-up explains it", async () => {
  await seed("chat-triage-copy")
  await mount(page("/settings/bots/bot-1/models"), async () => {
    assert.equal(
      rowText("triage-model"),
      `Triage model${TRIAGE}Default model`,
      "the explanation is the row's own line, word for word, over the value it holds",
    )
    assert.equal(accent("triage-model"), "Default model")
    assert.equal(find('[aria-label^="About the"]'), null, "and nothing explains it in a pop-up")
  })
})

test("General's fallback row is Fallback providers, saying what the chain is for", async () => {
  await seed("chat-fallbacks", { fallbacks: [{ provider: "openrouter", model: "cheap-model" }] })
  await mount(page("/settings/bots/bot-1/general"), async () => {
    await drawn()
    assert.equal(
      rowText("fallback_providers"),
      "Fallback providersThe chain Hermes tries after the main model1 provider",
      "the name a user reads, the line under it, and the chain's length",
    )
    assert.doesNotMatch(wordsOf(root()), /Fallback models/, "the old name is nowhere on the page")
  })
})

test("the chain's length is what the row says, and None when it holds nothing", async () => {
  await seed("chat-chain-none")
  await mount(page("/settings/bots/bot-1/general"), async () => {
    await drawn()
    assert.equal(accent("fallback_providers"), "None", "an empty chain says None")
  })

  await seed("chat-chain-two", {
    fallbacks: [
      { provider: "openrouter", model: "cheap-model" },
      { provider: "openrouter", model: "own-model" },
    ],
  })
  await mount(page("/settings/bots/bot-1/general"), async () => {
    await drawn()
    assert.equal(accent("fallback_providers"), "2 providers", "and two of them say 2 providers")
  })
})

test("the Models page's model row says what it is for, and the value it holds", async () => {
  await seed("chat-subtitles")
  await mount(page("/settings/bots/bot-1/models"), async () => {
    assert.equal(
      rowText("model"),
      "ModelThe model a chat runs when it has no pick of its owntest/model",
      "the model a chat runs, and the model it holds",
    )
  })
})

test("General's model row is the host's main model, named as Hermes names it", async () => {
  await seed("general-model-row")
  await mount(page("/settings/bots/bot-1/general"), async () => {
    await drawn()
    assert.equal(
      rowText("model"),
      "ModelThe host's main model, on every surfaceopenrouter/own-model",
      "the same knob the Dashboard shows, with the model the host runs",
    )
  })
})

test("the model pick marks the model the page already shows as the value", async () => {
  await seed("chat-model-marked")
  await mount(page("/settings/bots/bot-1/general"), async () => {
    await drawn()
    assert.equal(
      accent("model"),
      "openrouter/own-model",
      "the model in force, as the page shows it",
    )
    await openPick("model")
    assert.equal(
      modelOption("own-model")?.getAttribute("aria-pressed"),
      "true",
      "the pick ticks the row the page is already running",
    )
    assert.equal(
      modelOption("cheap-model")?.getAttribute("aria-pressed"),
      "false",
      "and marks no other row",
    )
  })
})

test("a host that withholds the model keeps the triage row and its words", async () => {
  await seed("chat-withheld", { writers: false })
  await mount(page("/settings/bots/bot-1/models"), async () => {
    assert.ok(row("triage-model"), "the triage row is still there")
    assert.ok(rowText("triage-model").includes(TRIAGE), "and its line is unchanged")
    assert.equal(accent("triage-model"), "Default model", "over the value it holds")
  })
})

test("a host without the triage route draws no Gots caption, and its Hermes card alone", async () => {
  await seed("chat-no-triage", { features: ["fallbacks", "host_model"] })
  await mount(page("/settings/bots/bot-1/models"), async () => {
    assert.ok(headings().length === 0, "no heading over an empty card either")
    assert.ok(!caption("Gots"), "no caption over a card with no row in it")
    assert.ok(caption("Hermes"), "the Hermes card is the page's own")
    absent('[data-setting="triage-model"]', "and no triage row")
    assert.deepEqual(rows(), ["model"], "and the model a chat runs is still there")
  })
})

test("a host without the fallback route leaves the chain's row off General", async () => {
  await seed("chat-no-fallbacks", { features: ["general_page", "triage_model", "host_model"] })
  await mount(page("/settings/bots/bot-1/general"), async () => {
    await drawn()
    assert.deepEqual(rows(), ["model"], "and the model stays")
  })
})

test("tapping Fallback providers opens the chain's own screen", async () => {
  await seed("chat-fallbacks-drill", {
    fallbacks: [{ provider: "openrouter", model: "cheap-model" }],
  })
  await mount(page("/settings/bots/bot-1/general"), async () => {
    await drawn()
    await click(row("fallback_providers"))
    assert.equal(
      path(),
      "/settings/bots/bot-1/general/fallback_providers",
      "the chain has an address of its own",
    )
    assert.ok(chain(), "and a screen of its own")
    assert.ok(!root(), "the page under it is not drawn")
  })
})

test("the chain's screen lists what the host holds, each with a way to remove it", async () => {
  await seed("chat-chain-rows", {
    fallbacks: [
      { provider: "openrouter", model: "cheap-model" },
      { provider: "openrouter", model: "own-model" },
    ],
  })
  await mount(page("/settings/bots/bot-1/general/fallback_providers"), async () => {
    await drawn()
    assert.deepEqual(chainRows(), ["1", "2"], "one row per fallback, in the order it is tried")
    assert.equal(wordsOf(chainRow(1)), "Fallback 1openrouter/cheap-model", "the first by its place")
    assert.equal(chainValue(1), "openrouter/cheap-model", "with its model in the accent colour")
    assert.equal(chainValue(2), "openrouter/own-model", "and the second's own")
    assert.ok(remove(1), "each row can be removed")
    assert.ok(remove(2))
    assert.equal(
      (addFallback() as HTMLButtonElement | null)?.disabled,
      true,
      "and a full chain's add is off, Hermes holding two",
    )
  })
})

test("an empty chain says so, and the header holds the way to add one", async () => {
  await seed("chat-chain-add")
  await mount(page("/settings/bots/bot-1/general/fallback_providers"), async () => {
    await drawn()
    assert.deepEqual(chainRows(), [], "no fallbacks yet")
    assert.match(wordsOf(find("[data-fallbacks]")), /No fallbacks/, "and the screen says so")
    assert.ok(addFallback(), "with the header holding the way to add the first")
  })
})

test("picking a model for a new fallback writes the chain", async () => {
  const calls = await seed("chat-chain-pick")
  await mount(page("/settings/bots/bot-1/general/fallback_providers"), async () => {
    await drawn()
    await click(addFallback())
    await until(async () => Boolean(find("[aria-pressed]")), "the model pick")
    assert.ok(modelOption("cheap-model"), "the host's models, in a sheet")
    await click(modelOption("cheap-model"))

    const write = calls.find((one) => one.method === "POST" && one.path.endsWith("/fallbacks"))
    assert.deepEqual(
      write?.body,
      { fallbacks: [{ provider: "openrouter", model: "cheap-model" }] },
      "the chain the host is sent",
    )
    assert.equal(chainValue(1), "openrouter/cheap-model", "and the row the chain now holds")
  })
})

test("removing a fallback writes the chain without it", async () => {
  const calls = await seed("chat-chain-remove", {
    fallbacks: [
      { provider: "openrouter", model: "cheap-model" },
      { provider: "openrouter", model: "own-model" },
    ],
  })
  await mount(page("/settings/bots/bot-1/general/fallback_providers"), async () => {
    await drawn()
    await click(remove(1))
    const write = calls.find((one) => one.method === "POST" && one.path.endsWith("/fallbacks"))
    assert.deepEqual(
      write?.body,
      { fallbacks: [{ provider: "openrouter", model: "own-model" }] },
      "the chain keeps the fallback that was under it",
    )
    assert.equal(
      wordsOf(chainRow(1)),
      "Fallback 1openrouter/own-model",
      "and the row behind it moves up",
    )
  })
})

test("picking a model on the Models page writes it to the bot", async () => {
  await seed("chat-model-pick")
  await mount(page("/settings/bots/bot-1/models"), async () => {
    assert.equal(accent("model"), "test/model", "the model the bot runs now")

    await openPick("model")
    assert.ok(modelOption("cheap-model"), "the host's models, in a sheet")
    await click(modelOption("cheap-model"))

    assert.equal(
      (await db.profiles.get("bot-1"))?.model,
      "cheap-model",
      "the pick lands on the bot",
    )
    await until(async () => !find("[aria-pressed]"), "the sheet to close behind the pick")
    assert.equal(accent("model"), "cheap-model", "and the row shows the model it now runs")
  })
})

test("picking a triage model writes it to the host", async () => {
  const calls = await seed("chat-triage-pick")
  await mount(page("/settings/bots/bot-1/models"), async () => {
    await openPick("triage-model")
    await click(modelOption("cheap-model"))

    const write = calls.find(
      (one) => one.method === "POST" && one.path.endsWith("/plugins/memento/triage-model"),
    )
    assert.deepEqual(
      write?.body,
      { triage_model: { provider: "openrouter", model: "cheap-model" } },
      "the triage model the host is sent",
    )
    assert.equal(accent("triage-model"), "openrouter/cheap-model", "and the row the pick set")
  })
})

test("picking General's Model makes it the host's main model", async () => {
  const calls = await seed("chat-default-pick")
  await mount(page("/settings/bots/bot-1/general"), async () => {
    await drawn()
    await openPick("model")
    await click(modelOption("cheap-model"))

    const write = calls.find(
      (one) => one.method === "POST" && one.path.endsWith("/plugins/memento/model"),
    )
    assert.deepEqual(
      write?.body,
      { provider: "openrouter", model: "cheap-model" },
      "the host is told which model to run everywhere",
    )
  })
})
