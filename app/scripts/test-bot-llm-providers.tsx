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
 * Its other write is a removal: *Remove key* asks first, in a question naming the provider, and
 * Cancel sends nothing at all. Confirm sends one DELETE for that target and the screen draws the
 * answered block again, where the row reads *Not set*. Nothing of either write is a key: the only
 * key the page ever holds is the typed one, in the field it was typed in.
 *
 * The page's `+` adds an endpoint: the form asks for a name, a base URL, a model and a key, its Save
 * waits until it holds all four, and one POST carries exactly what was typed while the page then
 * draws the block the write answered — the new row, with the key as the host masked it.
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
  findText,
  json,
  missing,
  mount,
  path,
  seedSettings,
  type,
  until,
} from "./component-kit.tsx"

type Provider = { slug: string; label: string; description: string; masked: string | null }
type Endpoint = { id: string; name: string; base_url: string; model: string; masked: string | null }
type Block = { providers: Provider[]; endpoints: Endpoint[] }

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

/**
 * The custom endpoints a host holds: one with a key, one without. They draw under their own caption,
 * and either one's slot screen is the same Replace-key form a provider's is.
 */
const ENDPOINTS: Endpoint[] = [
  {
    id: "local-llama",
    name: "Local Llama",
    base_url: "http://127.0.0.1:8080/v1",
    model: "llama-3.1-8b",
    masked: "llam...0a1f",
  },
  {
    id: "work-gateway",
    name: "Work gateway",
    base_url: "https://llm.example.com/v1",
    model: "gpt-4o-mini",
    masked: null,
  },
]

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

/** The id the host slugs from an endpoint's name: lower case, a run of spaces as one `-`. */
const slugOf = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

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
    // A provider's key removed: the answer is the fresh block, that row unset — the same block the
    // read gives, which is what the screen draws again.
    const removal = pathname.match(/\/plugins\/gots\/llm-providers\/key\/([^/]+)$/)
    if (removal && method === "DELETE") {
      const target = decodeURIComponent(removal[1])
      current = {
        ...current,
        providers: current.providers.map((one) =>
          one.slug === target ? { ...one, masked: null } : one,
        ),
      }
      return json({ object: "gots.llm_providers", llm: current })
    }
    if (pathname.endsWith("/plugins/gots/llm-providers/key") && method === "POST") {
      const target = String(body?.target ?? "")
      const masked = maskOf(String(body?.key ?? ""))
      // One route, one target: `custom:<id>` names an endpoint's key, anything else a provider's.
      current = target.startsWith("custom:")
        ? {
            ...current,
            endpoints: current.endpoints.map((one) =>
              one.id === target.slice("custom:".length) ? { ...one, masked } : one,
            ),
          }
        : {
            ...current,
            providers: current.providers.map((one) =>
              one.slug === target ? { ...one, masked } : one,
            ),
          }
      return json({ object: "gots.llm_providers", llm: current })
    }
    if (pathname.endsWith("/plugins/gots/llm-providers") && method === "GET")
      return json({ object: "gots.llm_providers", llm: current })
    if (pathname.endsWith("/plugins/gots/llm-providers/endpoints") && method === "POST") {
      // A custom endpoint added (plugin/llm_providers.py): the host slugs the id, keeps the key as
      // the mask it makes, and answers the block with the new row in it. The read above keeps
      // answering what this host held *before* the write, deliberately: a page that asked again
      // instead of drawing the block the write answered would show no new row at all.
      const name = String(body?.name ?? "").trim()
      const id = slugOf(name)
      const added: Endpoint = {
        id,
        name,
        base_url: String(body?.base_url ?? ""),
        model: String(body?.model ?? ""),
        masked: maskOf(String(body?.key ?? "")),
      }
      return json({
        object: "gots.llm_providers",
        llm: { ...current, endpoints: [...current.endpoints, added] },
      })
    }
    return json({}, 404)
  }) as typeof fetch
  return { asks, block: () => current }
}

/** The page itself, one provider's row on it, and the slot screen a row opens. */
const page = () => find("[data-bot-llm-providers]")
const providerRow = (slug: string) => find(`[data-setting="llm-provider-${slug}"]`)
const endpointRow = (id: string) => find(`[data-setting="llm-endpoint-${id}"]`)
const slot = () => find("[data-llm-provider-slot]")
const maskRow = () => find('[data-setting="llm-provider-mask"]')
/** An endpoint's facts on its slot screen: the base URL and the model, neither of them ours. */
const baseUrlRow = () => find('[data-setting="llm-endpoint-base-url"]')
const modelRow = () => find('[data-setting="llm-endpoint-model"]')
const keyField = () => find("[data-llm-key-field]") as HTMLInputElement | null
/** The page's own `+`, and the form it opens: one field per thing a new endpoint needs. */
const addButton = () => find("[data-llm-add-endpoint]")
const addForm = () => find("[data-llm-endpoint-add]")
const nameField = () => find("[data-llm-endpoint-name]") as HTMLInputElement | null
const urlField = () => find("[data-llm-endpoint-base-url]") as HTMLInputElement | null
const endpointModelField = () => find("[data-llm-endpoint-model]") as HTMLInputElement | null
const newKeyField = () => find("[data-llm-endpoint-key]") as HTMLInputElement | null
const saveButton = () =>
  findAll("[data-form-actions] button").find((one) => one.textContent?.trim() === "Save") ?? null
/** The slot screen's own way to remove the key, and the question it asks first. */
const removeKey = () => find("[data-llm-remove-key]")
const dialog = () => find('[role="alertdialog"]')
const dialogTitle = () => find('[data-slot="alert-dialog-title"]')?.textContent?.trim() ?? ""
const inDialog = (label: string) => findText('[role="alertdialog"] button', label)

/** A row's leaves, top to bottom: its title, its purpose line where it has one, and its value. */
const leaves = (element: Element | null) =>
  [...(element?.querySelectorAll("span") ?? [])].filter((span) => !span.querySelector("*"))
const lines = (element: Element | null) =>
  leaves(element).map((span) => span.textContent?.trim() ?? "")
const titleOf = (element: Element | null) => lines(element)[0] ?? ""
const valueOf = (element: Element | null) => lines(element).at(-1) ?? ""
/** The class a row's value is drawn with: muted where the value is not the page's to claim. */
const valueClass = (element: Element | null) => leaves(element).at(-1)?.className ?? ""

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

test("removing a key asks first, and the row reads Not set", async () => {
  const host = await seed("remove", ["llm_providers"])
  await mount(settings("/settings/bots/bot-1/llm-providers"), async () => {
    await until(async () => Boolean(providerRow("openai")), "the host's providers")
    await click(providerRow("openai"))
    await until(async () => Boolean(removeKey()), "the Remove key action")

    // A question, not a write: the provider is named, and the way out of it sends nothing at all.
    await click(removeKey())
    assert.ok(dialog(), "Remove asks first")
    assert.equal(dialogTitle(), "Remove OpenAI's key?", "and the question names the provider")
    const asked = host.asks.length
    await click(inDialog("Cancel"))
    await until(async () => !dialog(), "the question to shut")
    assert.equal(host.asks.length, asked, "Cancel makes no request at all")
    assert.equal(valueOf(maskRow()), "sk-o...c123", "and the key is still the one that was there")

    await click(removeKey())
    await until(async () => Boolean(dialog()), "the question again")
    await click(inDialog("Remove"))
    await until(
      async () => valueOf(maskRow()) === "Not set",
      "the row to read the block the removal answered",
    )

    const deletes = host.asks.filter((one) => one.method === "DELETE")
    assert.equal(deletes.length, 1, "exactly one removal")
    assert.equal(deletes[0].path, "/api/plugins/gots/llm-providers/key/openai", "for that provider")
    assert.equal(deletes[0].body, null, "and no body: the address names what is removed")
    assert.ok(missing("[data-llm-remove-key]"), "the action goes with the key it removed")
  })
})

test("an endpoint row shows its base URL and its key masked, and its key can be replaced", async () => {
  const host = await seed("endpoints", ["llm_providers"], { ...BLOCK, endpoints: ENDPOINTS })
  await mount(settings("/settings/bots/bot-1/llm-providers"), async () => {
    await until(async () => Boolean(endpointRow("local-llama")), "the host's custom endpoints")

    // Both lists are one page: the providers' caption, then the endpoints' — the second one only
    // because there are endpoints to draw under it.
    assert.deepEqual(
      findAll("[data-bot-llm-providers] > p").map((one) => one.textContent?.trim()),
      ["Providers", "Custom endpoints"],
      "a second caption over the endpoints' rows",
    )
    assert.deepEqual(
      lines(endpointRow("local-llama")),
      ["Local Llama", "http://127.0.0.1:8080/v1 · llama-3.1-8b", "llam...0a1f"],
      "its name, the base URL and model it runs, and its key as the host masked it",
    )
    assert.equal(
      valueOf(endpointRow("work-gateway")),
      "Not set",
      "an endpoint holding no key says so the way every row does",
    )

    await click(endpointRow("local-llama"))
    await until(async () => Boolean(slot()), "the endpoint's screen")

    assert.equal(
      path(),
      "/settings/bots/bot-1/llm-providers/key/custom%3Alocal-llama",
      "the address names the endpoint's key, spelled custom:<id>",
    )
    assert.deepEqual(
      lines(maskRow()),
      ["Local Llama", "llam...0a1f"],
      "the endpoint's name over its key, as the host masked it",
    )
    assert.deepEqual(
      lines(baseUrlRow()),
      ["Base URL", "http://127.0.0.1:8080/v1"],
      "and the base URL it was configured with",
    )
    assert.deepEqual(lines(modelRow()), ["Model", "llama-3.1-8b"], "and the model")
    // Neither is the page's to claim: they are what the host holds, so they read muted.
    for (const row of [baseUrlRow(), modelRow()])
      assert.ok(
        valueClass(row).includes("text-muted-foreground") &&
          !valueClass(row).includes("text-primary"),
        "a value the page doesn't own reads muted",
      )

    await type(keyField(), "endpoint-key-0000-0a1f")
    await until(async () => saveButton()?.disabled === false, "Save to wake for a typed key")
    await click(saveButton())
    await until(async () => host.asks.some((one) => one.method === "POST"), "the write")

    const write = host.asks.find((one) => one.method === "POST")
    assert.deepEqual(
      write?.body,
      { target: "custom:local-llama", key: "endpoint-key-0000-0a1f" },
      "the endpoint's key under its custom: target, and nothing else",
    )
    assert.ok(
      !JSON.stringify(write?.body).includes("llam...0a1f"),
      "the mask that was on screen never rides the write",
    )
    await until(
      async () => valueOf(maskRow()) === "endp...0a1f",
      "the screen to read the block the write answered",
    )
  })
})

test("the plus opens a form and the endpoint lands as a row", async () => {
  const host = await seed("add", ["llm_providers"])
  await mount(settings("/settings/bots/bot-1/llm-providers"), async () => {
    await until(async () => Boolean(providerRow("openai")), "the host's providers")

    // The page's own way in: one `+` in the header, which opens the form as a sub-screen of its own.
    await click(addButton())
    await until(async () => Boolean(addForm()), "the add form")
    assert.equal(
      path(),
      "/settings/bots/bot-1/llm-providers/add",
      "the form has an address of its own",
    )
    assert.ok(
      findAll("h1").some((heading) => heading.textContent === "Add custom endpoint"),
      "and a title saying what it does",
    )

    // Save is dead until the form holds a whole endpoint: a name, a base URL, a model and a key.
    assert.equal(saveButton()?.disabled, true, "Save waits for a whole endpoint")
    await type(nameField(), "Home box")
    assert.equal(saveButton()?.disabled, true, "a name alone is no endpoint")
    await type(urlField(), "http://10.0.0.5:8080/v1")
    assert.equal(saveButton()?.disabled, true, "nor is a name and a URL")
    await type(endpointModelField(), "qwen2.5")
    assert.equal(saveButton()?.disabled, true, "and nothing is saved without a key")
    await type(newKeyField(), "home-box-key-0000-abcd")
    await until(async () => saveButton()?.disabled === false, "Save to wake for a whole endpoint")

    await click(saveButton())
    await until(async () => Boolean(endpointRow("home-box")), "the new endpoint's row")

    const posts = host.asks.filter((one) => one.method === "POST")
    assert.equal(posts.length, 1, "one write, and no second")
    assert.deepEqual(
      posts[0].body,
      {
        name: "Home box",
        base_url: "http://10.0.0.5:8080/v1",
        model: "qwen2.5",
        key: "home-box-key-0000-abcd",
      },
      "the four fields the form holds, and nothing else",
    )
    // The row is the block the write answered: this host's read still answers the page as it was
    // before the write, so a page that asked again rather than drawing that block would show no row.
    assert.equal(
      host.asks.filter(
        (one) => one.method === "GET" && one.path.endsWith("/plugins/gots/llm-providers"),
      ).length,
      1,
      "the page asked nothing more: the block the write answered is what it drew",
    )
    assert.equal(path(), "/settings/bots/bot-1/llm-providers", "and the form is left behind")
    assert.ok(missing("[data-llm-endpoint-add]"), "nothing of it is on the screen")
    assert.deepEqual(
      lines(endpointRow("home-box")),
      ["Home box", "http://10.0.0.5:8080/v1 · qwen2.5", "home...abcd"],
      "the new row: its name, the URL and model it runs, and its key as the host masked it",
    )
  })
})
