/**
 * The LLM Providers page: the API-key providers this bot's Hermes knows, each row saying which
 * provider it is and, as its value, the key the host masked itself — or *Not set* where there is
 * none. The value is the host's mask and never a key: the page is handed `sk-o...c123` and draws it
 * as it arrived, so nothing here derives, reveals or compares a key. Endpoints and the slot screens
 * are later steps; this page's rows open nothing yet.
 *
 * A host on an older plugin advertises no `llm_providers`, so the page draws no row and its address
 * lands on the bot's own page — the gate every page over a host's own feature wears.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter, Route, Routes } from "react-router"

import { SettingsPage } from "@/routes/settings"
import { db } from "@/lib/db"
import {
  Path,
  botProfile,
  find,
  findAll,
  json,
  missing,
  mount,
  path,
  seedSettings,
  until,
} from "./component-kit.tsx"

/** What `GET llm-providers` answers: two providers, one with a key and one without. */
const BLOCK = {
  providers: [
    {
      slug: "openai",
      label: "OpenAI",
      description: "GPT models, straight from OpenAI.",
      masked: "sk-o...c123",
    },
    {
      slug: "groq",
      label: "Groq",
      description: "Fast inference on Groq's hardware.",
      masked: null,
    },
  ],
  endpoints: [],
}

/** The settings route, as the app draws it: the list, the page, and the address on screen. */
const settings = (entry: string) => (
  <MemoryRouter initialEntries={[entry]}>
    <Path />
    <Routes>
      <Route path="/settings/:section?/:botId?/:tab?/:sub?" element={<SettingsPage />} />
    </Routes>
  </MemoryRouter>
)

/**
 * A bot of this test's own over a faked host: what a connection's plugin answered is remembered for
 * the page, so each case names its own host and no answer leaks into the next.
 */
async function seed(name: string, features: string[], block: unknown = BLOCK) {
  await seedSettings()
  await db.profiles.clear()
  await db.profiles.put(botProfile(name))
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const pathname = new URL(String(input)).pathname
    if (pathname.endsWith("/plugins/gots/info")) return json({ name: "gots", features })
    if (pathname.endsWith("/plugins/gots/llm-providers"))
      return json({ object: "gots.llm_providers", llm: block })
    return json({}, 404)
  }) as typeof fetch
}

/** The page itself, and one provider's row on it. */
const page = () => find("[data-bot-llm-providers]")
const providerRow = (slug: string) => find(`[data-setting="llm-provider-${slug}"]`)

/** A row's leaves, top to bottom: its title, its purpose line where it has one, and its value. */
const leaves = (element: Element | null) =>
  [...(element?.querySelectorAll("span") ?? [])].filter((span) => !span.querySelector("*"))
const lines = (element: Element | null) => leaves(element).map((span) => span.textContent?.trim() ?? "")
const titleOf = (element: Element | null) => lines(element)[0] ?? ""
const valueOf = (element: Element | null) => lines(element).at(-1) ?? ""

test("a provider with a key shows its first and last four, one without shows Not set", async () => {
  await seed("providers", ["llm_providers"])
  await mount(settings("/settings/bots/bot-1/llm-providers"), async () => {
    await until(async () => Boolean(providerRow("openai")), "the host's providers")

    assert.ok(page(), "the LLM Providers page is what is drawn")
    assert.deepEqual(
      findAll("[data-bot-llm-providers] > p").map((one) => one.textContent?.trim()),
      ["Providers"],
      "one caption over the providers card",
    )
    assert.deepEqual(
      [...findAll("[data-bot-llm-providers] [data-setting]")].map(titleOf),
      ["OpenAI", "Groq"],
      "a row per provider, titled with its label, in the host's order",
    )
    assert.equal(
      valueOf(providerRow("openai")),
      "sk-o...c123",
      "the key exactly as the host masked it: its first and last four",
    )
    assert.equal(valueOf(providerRow("groq")), "Not set", "a provider holding no key says so")
    assert.deepEqual(
      lines(providerRow("openai")),
      ["OpenAI", "GPT models, straight from OpenAI.", "sk-o...c123"],
      "a row is its label, the host's line about it, and the mask — nothing else",
    )
    assert.deepEqual(
      lines(providerRow("groq")),
      ["Groq", "Fast inference on Groq's hardware.", "Not set"],
      "and a provider with no key keeps its line, saying there is none",
    )
  })
})

test("an older plugin draws no LLM Providers row", async () => {
  // A host that predates the page: its `info` advertises every other gate and not this one.
  await seed("older-plugin", ["general_page", "dictation", "mcps"])
  await mount(settings("/settings/bots/bot-1/llm-providers"), async () => {
    assert.ok(missing('[data-bot-page="llm-providers"]'), "no LLM Providers row in the list")
    assert.ok(!page(), "and no page behind it")
    assert.equal(path(), "/settings/bots/bot-1", "the address lands on the bot's own page")
    assert.ok(find("[data-bot-card]"), "which is what is drawn")
  })
})
