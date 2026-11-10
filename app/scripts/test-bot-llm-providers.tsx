/**
 * The LLM Providers page: the API-key providers this bot's Hermes knows, each row saying which
 * provider it is and, as its value, the key the host masked itself — or *Not set* where there is
 * none. The value is the host's mask and never a key: the page is handed `sk-o...c123` and draws it
 * as it arrived, so nothing here derives, reveals or compares a key.
 *
 * A row opens its slot screen, whose one write is a key: the field starts empty (a mask is never
 * offered back as a key), Save is dead until the field holds something a key could be, and the POST
 * carries `{target, key}` — the typed key, never the mask that was on the screen — and the screen
 * then draws the block that write answered.
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
  click,
  find,
  findAll,
  json,
  missing,
  mount,
  path,
  seedSettings,
  type,
  until,
} from "./component-kit.tsx"

type Provider = { slug: string; label: string; description: string; masked: string | null }
type Block = { providers: Provider[]; endpoints: unknown[] }

/** What `GET llm-providers` answers: two providers, one with a key and one without. */
const BLOCK: Block = {
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
      <Route path="/settings/:section?/:botId?/:tab?/:sub?/:leaf?" element={<SettingsPage />} />
    </Routes>
  </MemoryRouter>
)

/** One request the fake host was sent, so a write's body can be read back. */
type Asked = { method: string; path: string; body: Record<string, unknown> | null }

/**
 * The mask this fake host makes of a key, the way `mask_secret` does: the first four and last four
 * characters, and `***` under its twelve-character floor. Made here because a mask is the host's.
 */
const maskOf = (key: string) => (key.length < 12 ? "***" : `${key.slice(0, 4)}...${key.slice(-4)}`)

/**
 * A bot of this test's own over a faked host: what a connection's plugin answered is remembered for
 * the page, so each case names its own host and no answer leaks into the next. A key write lands on
 * the block that host answers next, and every request is recorded.
 */
async function seed(name: string, features: string[], block: Block = BLOCK) {
  await seedSettings()
  await db.profiles.clear()
  await db.profiles.put(botProfile(name))
  const asks: Asked[] = []
  let current = structuredClone(block)
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const pathname = new URL(String(input)).pathname
    const method = (init?.method ?? "GET").toUpperCase()
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
    asks.push({ method, path: pathname, body })
    if (pathname.endsWith("/plugins/gots/info")) return json({ name: "gots", features })
    if (pathname.endsWith("/plugins/gots/llm-providers/key") && method === "POST") {
      const target = String(body?.target ?? "")
      current = {
        ...current,
        providers: current.providers.map((one) =>
          one.slug === target ? { ...one, masked: maskOf(String(body?.key ?? "")) } : one,
        ),
      }
      return json({ object: "gots.llm_providers", llm: current })
    }
    if (pathname.endsWith("/plugins/gots/llm-providers"))
      return json({ object: "gots.llm_providers", llm: current })
    return json({}, 404)
  }) as typeof fetch
  return { asks, block: () => current }
}

/** The page itself, one provider's row on it, and the slot screen a row opens. */
const page = () => find("[data-bot-llm-providers]")
const providerRow = (slug: string) => find(`[data-setting="llm-provider-${slug}"]`)
const slot = () => find("[data-llm-provider-slot]")
const maskRow = () => find('[data-setting="llm-provider-mask"]')
const keyField = () => find("[data-llm-key-field]") as HTMLInputElement | null
const saveButton = () =>
  findAll("[data-form-actions] button").find((one) => one.textContent?.trim() === "Save") ?? null

/** A row's leaves, top to bottom: its title, its purpose line where it has one, and its value. */
const leaves = (element: Element | null) =>
  [...(element?.querySelectorAll("span") ?? [])].filter((span) => !span.querySelector("*"))
const lines = (element: Element | null) =>
  leaves(element).map((span) => span.textContent?.trim() ?? "")
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

test("a row opens its slot screen: the provider's line, its mask, and a Save that waits", async () => {
  await seed("slot", ["llm_providers"])
  await mount(settings("/settings/bots/bot-1/llm-providers"), async () => {
    await until(async () => Boolean(providerRow("openai")), "the host's providers")
    await click(providerRow("openai"))
    await until(async () => Boolean(slot()), "the provider's screen")

    assert.equal(
      path(),
      "/settings/bots/bot-1/llm-providers/key/openai",
      "the slot screen has an address of its own",
    )
    assert.deepEqual(
      lines(maskRow()),
      ["OpenAI", "GPT models, straight from OpenAI.", "sk-o...c123"],
      "the provider's label and line, and its key as the host masked it",
    )
    assert.equal(keyField()?.value, "", "the field starts empty: a mask is never offered as a key")
    assert.equal(saveButton()?.disabled, true, "and Save waits for something typed")
  })
})

test("replacing posts the typed key, never the mask on screen, and reads the host's new mask", async () => {
  const host = await seed("replace", ["llm_providers"])
  await mount(settings("/settings/bots/bot-1/llm-providers"), async () => {
    await until(async () => Boolean(providerRow("openai")), "the host's providers")
    await click(providerRow("openai"))
    await until(async () => Boolean(keyField()), "the key's field")

    await type(keyField(), "new-key-0000-zyxw")
    await until(async () => saveButton()?.disabled === false, "Save to wake for a typed key")
    await click(saveButton())
    await until(async () => host.asks.some((one) => one.method === "POST"), "the write")

    const write = host.asks.find((one) => one.method === "POST")
    assert.deepEqual(
      write?.body,
      { target: "openai", key: "new-key-0000-zyxw" },
      "one target, one typed key — and nothing else",
    )
    assert.ok(
      !JSON.stringify(write?.body).includes("sk-o...c123"),
      "the mask that was on screen never rides the write",
    )
    await until(
      async () => valueOf(maskRow()) === "new-...zyxw",
      "the screen to read the block the write answered",
    )
    assert.equal(keyField()?.value, "", "and the field is empty again, holding no key")
  })
})
