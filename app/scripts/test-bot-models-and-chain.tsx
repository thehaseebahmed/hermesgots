/**
 * A bot's models, over a seeded device database and a faked host (ADR 0055, ADR 0104): the Models
 * page's model a chat runs, the Delegation page's subagent model, and — on General, where Hermes's
 * Dashboard keeps them — the host's main model and the chain it falls back on, the chain drilling
 * into a screen of its own. Every setting is a title over the line saying what it is for and the
 * value it holds in the accent colour, each value opening its pick as a bottom sheet — or applying
 * the one model its host offers, without opening one at all.
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
  missing,
  mount,
  path,
  hostModelRead,
  seedSettings,
  settle,
  until,
  watchSheets,
  wordsOf,
} from "./component-kit.tsx"

type Choice = { provider: string; model: string }
type Sent = { method: string; path: string; body: Record<string, unknown> | null }

/** The host's Delegation block, as its schema offers it: one key, so the page draws its own rows. */
const DELEGATION = {
  fields: [{ key: "delegation.backend", kind: "string" as const, section: "" }],
  values: {},
  defaults: { "delegation.backend": "default" },
}

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

/** The models a host lists when a test doesn't say otherwise: two, so a pick has a choice to offer. */
const TWO_MODELS = ["own-model", "cheap-model"]

/**
 * A host answering the plugin's `info` (its features and version), the fallback route, its model
 * list and the write that makes a model its main one — and recording every request, so a test can
 * read what a pick wrote.
 */
function host({
  features = ["general_page", "fallbacks", "host_model"],
  models = TWO_MODELS,
  fallbacks = [] as Choice[],
}: {
  features?: string[]
  /** The models the bot's Hermes lists; `null` is a host whose read failed. */
  models?: string[] | null
  fallbacks?: Choice[]
} = {}) {
  const calls: Sent[] = []
  let chain = fallbacks
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = (init?.method ?? "GET").toUpperCase()
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ method, path: url.pathname, body })
    if (url.pathname.endsWith("/plugins/gots/info"))
      return json({
        name: "gots",
        version: "0.81.0",
        features,
      })
    // The Delegation page's own schema, and the subagent model its row picks.
    if (url.pathname.endsWith("/plugins/gots/delegation-settings"))
      return json({ object: "gots.delegation_settings", delegation: DELEGATION })
    if (url.pathname.endsWith("/plugins/gots/delegation"))
      return json({ delegation: method === "POST" && body ? body.delegation : null })
    if (url.pathname.endsWith("/plugins/gots/fallbacks")) {
      if (method === "POST") chain = body?.fallbacks ?? []
      return json({ fallbacks: chain })
    }
    if (url.pathname.endsWith("/api/model/options")) {
      if (!models) return json({}, 404)
      return json({
        model: models[0],
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
    }
    if (url.pathname.endsWith("/models"))
      return json({ data: (models ?? []).map((id) => ({ id })) })
    return json({})
  }
  return { calls, fetch: fetch as unknown as typeof globalThis.fetch, chain: () => chain }
}

/** A bot of this test's own: its connection names a host, so no other test's answers are read. */
async function seed(name: string, options: Parameters<typeof host>[0] = {}) {
  await seedSettings({})
  await db.profiles.clear()
  await db.profiles.put(botProfile(name))
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
  findAll("[role=radio]").find((one) => wordsOf(one) === name) ?? null
/** Opens a setting's pick, and waits for the sheet it opens. */
async function openPick(id: string) {
  await click(row(id))
  await until(async () => Boolean(find("[role=radiogroup]")), "the model pick")
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
/**
 * The header's add, once the host has answered with the providers a pick needs: it is disabled
 * until then, and a click on a disabled button is nothing, so a test that clicked as soon as the
 * screen drew passed or failed on whether an earlier test had warmed the model info cache.
 */
async function addReady() {
  await until(async () => {
    const button = addFallback()
    return Boolean(button && !(button as HTMLButtonElement).disabled)
  }, "the add button, once the host's providers are in")
  return addFallback()
}

test("the Models page is the model a chat runs, under the bot's Hermes", async () => {
  await seed("chat-groups")
  await mount(page("/settings/bots/bot-1/models"), async () => {
    assert.deepEqual(headings(), [], "no headings: the caption names the card")
    assert.equal(
      caption("Hermes")?.textContent?.trim(),
      "Hermes",
      "the bot's Hermes owns the page's one card",
    )
    assert.deepEqual(rows(), ["model"], "every setting it draws, the model a chat runs")
    assert.doesNotMatch(
      wordsOf(root()),
      /Subagent model/,
      "Subagent model is General's, not this page's",
    )
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
      modelOption("own-model")?.getAttribute("aria-checked"),
      "true",
      "the pick ticks the row the page is already running",
    )
    assert.equal(
      modelOption("cheap-model")?.getAttribute("aria-checked"),
      "false",
      "and marks no other row",
    )
  })
})

test("a host without the fallback route leaves the chain's row off General", async () => {
  await seed("chat-no-fallbacks", { features: ["general_page", "host_model"] })
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
    await click(await addReady())
    await until(async () => Boolean(find("[role=radiogroup]")), "the model pick")
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
    await until(async () => !find("[role=radiogroup]"), "the sheet to close behind the pick")
    assert.equal(accent("model"), "cheap-model", "and the row shows the model it now runs")
  })
})

test("picking General's Model makes it the host's main model", async () => {
  const calls = await seed("chat-default-pick")
  await mount(page("/settings/bots/bot-1/general"), async () => {
    await drawn()
    await openPick("model")
    await click(modelOption("cheap-model"))

    const write = calls.find(
      (one) => one.method === "POST" && one.path.endsWith("/plugins/gots/model"),
    )
    assert.deepEqual(
      write?.body,
      { provider: "openrouter", model: "cheap-model" },
      "the host is told which model to run everywhere",
    )
  })
})

test("a one-model host applies it from the Models page's row, and draws no sheet", async () => {
  const calls = await seed("models-one-model", { models: ["own-model"] })
  await mount(page("/settings/bots/bot-1/models"), async () => {
    await hostModelRead()
    const sheets = watchSheets()
    try {
      await click(row("model"))
    } finally {
      sheets.stop()
    }
    assert.deepEqual(sheets.drawn, [], "no sheet was drawn, not even for a frame")
    // The row draws the bot's own model and a tap writes it, so the only model the host offers is
    // written there — the state a tap on the one row of the sheet would have left.
    await until(
      async () => (await db.profiles.get("bot-1"))?.model === "own-model",
      "the bot's own model to take the host's one model",
    )
  })
})

test("a one-model host leaves its row quiet when the bot already runs that model", async () => {
  await seed("models-one-model-in-force", { models: ["own-model"] })
  // What the row draws, and what its tap writes: the bot's own model, already the host's one.
  await db.profiles.update("bot-1", { model: "own-model" })
  await mount(page("/settings/bots/bot-1/models"), async () => {
    await hostModelRead()
    const before = await db.profiles.get("bot-1")
    const sheets = watchSheets()
    try {
      await click(row("model"))
    } finally {
      sheets.stop()
    }
    assert.deepEqual(sheets.drawn, [], "no sheet was drawn, not even for a frame")
    // The write this row makes is the device's own, so its clock is what says nothing happened.
    assert.equal(
      (await db.profiles.get("bot-1"))?.updatedAt,
      before?.updatedAt,
      "and nothing was written: the row already held the host's one model",
    )
  })
})

test("a host offering two models opens the Models page's sheet, with its rows", async () => {
  await seed("models-two-models")
  await mount(page("/settings/bots/bot-1/models"), async () => {
    await hostModelRead()
    await openPick("model")
    assert.ok(modelOption("own-model"), "the model in force")
    assert.ok(modelOption("cheap-model"), "and the one beside it, since there is a choice to make")
  })
})

test("a host offering no models says so in the sheet, and writes nothing", async () => {
  const calls = await seed("models-none", { models: [] })
  await mount(page("/settings/bots/bot-1/models"), async () => {
    // No host model is recorded for a host with nothing to offer, so the row's presence and a settle
    // are what say the read has landed.
    await until(async () => Boolean(row("model")), "the row")
    await settle()
    await click(row("model"))
    await until(async () => Boolean(find("[data-popup-form]")), "the sheet")
    await until(
      async () => /offers no models/.test(wordsOf(find("[data-popup-form]"))),
      "the sheet's empty sentence",
    )
    assert.match(
      wordsOf(find("[data-popup-form]")),
      /This bot's host offers no models\./,
      "an empty list says it is empty, rather than reading as a failed one",
    )
    assert.deepEqual(
      calls.filter((one) => one.method === "POST"),
      [],
      "and writes nothing",
    )
  })
})

test("a host whose model read failed opens the Model sheet with its sentence, and writes nothing", async () => {
  const calls = await seed("models-read-failed", { models: null })
  await mount(page("/settings/bots/bot-1/models"), async () => {
    await until(async () => Boolean(row("model")), "the row")
    // The read's refusal has to have landed, or the tap would catch the list still out.
    await settle()
    await click(row("model"))
    await until(async () => Boolean(find("[data-popup-form]")), "the sheet")
    assert.match(
      wordsOf(find("[data-popup-form]")),
      /Couldn't read this bot's models\./,
      "the sheet says what failed rather than drawing rows it never read",
    )
    assert.deepEqual(
      calls.filter((one) => one.method === "POST"),
      [],
      "and writes nothing",
    )
  })
})

test("a one-model host writes the Delegation row's model through the host, and draws no sheet", async () => {
  const calls = await seed("delegation-one-model", {
    models: ["own-model"],
    features: ["general_page", "delegation_model", "delegation_page"],
  })
  // The Delegation page draws its own block, so its row is read off the document rather than the
  // Models page's or General's.
  const subagent = () => find("[data-bot-delegation] [data-setting='subagent-model']")
  const shown = () => subagent()?.querySelector(".text-primary")?.textContent ?? null
  await mount(page("/settings/bots/bot-1/delegation"), async () => {
    await until(async () => Boolean(subagent()), "the Delegation page's model row")
    await hostModelRead()
    const sheets = watchSheets()
    try {
      await click(subagent())
    } finally {
      sheets.stop()
    }
    assert.deepEqual(sheets.drawn, [], "no sheet was drawn, not even for a frame")
    const write = calls.find(
      (one) => one.method === "POST" && one.path.endsWith("/plugins/gots/delegation"),
    )
    assert.deepEqual(
      write?.body,
      { delegation: { provider: "openrouter", model: "own-model" } },
      "the one model, through the write a row's tap makes",
    )
    await until(async () => shown() === "openrouter/own-model", "the row the write left")
  })
})
