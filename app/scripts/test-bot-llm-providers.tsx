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
import { MemoryRouter, Route, Routes, useNavigate } from "react-router"

import { SettingsPage } from "@/routes/settings"
import { db } from "@/lib/db"
import { holdsUnsavedChanges } from "@/lib/unsaved"
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
  text,
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
    <BackStep />
    <Routes>
      <Route path="/settings/:section?/:botId?/:tab?/:sub?/:leaf?" element={<SettingsPage />} />
    </Routes>
  </MemoryRouter>
)

/**
 * The browser's own back, as a press: the entry before this one, its state and all. A page the app
 * pushes over this one is entered by a row's press, so this is the walk back to it.
 */
function BackStep() {
  const navigate = useNavigate()
  return (
    <button type="button" data-back onClick={() => void navigate(-1)}>
      Back
    </button>
  )
}
const back = () => find("[data-back]")

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
 * The endpoint this fake host's model runs on, and the sentence it refuses to remove it with
 * (`llm_providers.remove_endpoint`): the endpoint by name, and the one thing that would let the
 * removal through. The plugin's own sentence, so the page is drawn exactly what a host sends.
 */
const RUNNING_ON = "local-llama"
const IN_USE = "This bot's model runs on Local Llama. Switch the model first."

/**
 * What the page says of a write whose answer carried no block: the write may have landed, but this
 * screen can't say so, so it says that instead of emptying the form over the old mask.
 */
const UNREAD_ANSWER =
  "This host's answer couldn't be read, so nothing here can say the write landed."

/**
 * A bot of this test's own over a faked host: what a connection's plugin answered is remembered for
 * the page, so each case names its own host and no answer leaks into the next. A key write lands on
 * the block that host answers next, an endpoint's removal takes its row off it, and every request is
 * recorded.
 */
async function seed(
  name: string,
  features: string[],
  block: Block = BLOCK,
  runningOn = RUNNING_ON,
) {
  await seedSettings()
  await db.profiles.clear()
  await db.profiles.put(botProfile(name))
  const asks: Asked[] = []
  // The refusals this host answered, by the status and the code it sent: the endpoint its model
  // runs on is the plan's 409 under `endpoint_in_use`, and the page draws its sentence anyway.
  const refusals: { status: number; code: string }[] = []
  let current = structuredClone(block)
  // Whether a write answers with the block at all: a host that answers `{object}` alone is what the
  // page must not read as a write that landed.
  let carriesBlock = true
  /** A write's answer: the block, or — where a case says so — an answer carrying none. */
  const answered = (next: Block) =>
    carriesBlock
      ? json({ object: "gots.llm_providers", llm: next })
      : json({ object: "gots.llm_providers" })
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
      return answered(current)
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
      return answered(current)
    }
    if (pathname.endsWith("/plugins/gots/llm-providers") && method === "GET")
      return json({ object: "gots.llm_providers", llm: current })
    const endpointRemoval = pathname.match(/\/plugins\/gots\/llm-providers\/endpoints\/([^/]+)$/)
    if (endpointRemoval && method === "DELETE") {
      // A custom endpoint removed (plugin/llm_providers.py): the address names it, and the model
      // the bot runs on is the one refusal — deleting it would unpick the bot's model, so the
      // sentence says what to do first and nothing is deleted. Any other goes, key and all, and the
      // answer is the fresh block without its row.
      const id = decodeURIComponent(endpointRemoval[1])
      const held = current.endpoints.find((one) => one.id === id)
      if (!held)
        return json({ error: { message: `${id} isn't a custom endpoint this Hermes knows.` } }, 400)
      if (id === runningOn) {
        refusals.push({ status: 409, code: "endpoint_in_use" })
        return json({ error: { message: IN_USE, code: "endpoint_in_use" } }, 409)
      }
      current = { ...current, endpoints: current.endpoints.filter((one) => one.id !== id) }
      return answered(current)
    }
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
      return answered({ ...current, endpoints: [...current.endpoints, added] })
    }
    return json({}, 404)
  }) as typeof fetch
  return {
    asks,
    refusals,
    block: () => current,
    /** Every write answers `{object}` alone: an answer the page must not read as one that landed. */
    answersNoBlock: () => void (carriesBlock = false),
    /** The host's own state, changed out from under the page: what a fresh read now answers. */
    set: (next: Block) => void (current = next),
  }
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
/**
 * The key field: the app's own `EditForm`, whose field's id is its label's — `New key` — so the
 * form the page uses is the one with the show/hide toggle and the unsaved-changes guard.
 */
const keyField = () => find("#edit-new-key") as HTMLInputElement | null
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
/** An endpoint's own removal, on its slot screen, and the question that names it. */
const removeEndpoint = () => find("[data-llm-remove-endpoint]")
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
    // The app's own edit form, so the field carries what every secret the app edits carries.
    assert.ok(find('[aria-label="Show key"]'), "a show/hide toggle, because the form is `EditForm`")
    assert.ok(
      !text().includes("Saved on this bot's Hermes"),
      "and no footnote explaining the field: a setting's subtitle is the only place it says",
    )
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
    assert.ok(
      !text().includes("Saved on this bot's Hermes"),
      "and no footnote under the key: the field's label is what it says",
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

test("removing the endpoint the model runs on is refused and deletes nothing", async () => {
  const host = await seed("remove-endpoint", ["llm_providers"], { ...BLOCK, endpoints: ENDPOINTS })
  await mount(settings("/settings/bots/bot-1/llm-providers"), async () => {
    await until(async () => Boolean(endpointRow("local-llama")), "the host's custom endpoints")
    await click(endpointRow("local-llama"))
    await until(async () => Boolean(removeEndpoint()), "the Remove endpoint action")

    // A question, not a write: the endpoint is named, and the way out of it sends nothing at all.
    await click(removeEndpoint())
    assert.ok(dialog(), "Remove endpoint asks first")
    assert.equal(dialogTitle(), "Remove Local Llama?", "and the question names the endpoint")
    const asked = host.asks.length
    await click(inDialog("Cancel"))
    await until(async () => !dialog(), "the question to shut")
    assert.equal(host.asks.length, asked, "Cancel makes no request at all")

    await click(removeEndpoint())
    await until(async () => Boolean(dialog()), "the question again")
    await click(inDialog("Remove"))
    await until(async () => text().includes(IN_USE), "the host's sentence")

    assert.deepEqual(
      host.refusals,
      [{ status: 409, code: "endpoint_in_use" }],
      "the host refused under the plan's own status and code, and the page drew its sentence",
    )

    // The one removal, and the answer to it is the host's own words rather than the app's. Nothing
    // was deleted, so the screen and the row it draws are exactly what they were.
    const deletes = host.asks.filter((one) => one.method === "DELETE")
    assert.equal(deletes.length, 1, "exactly one removal asked")
    assert.equal(
      deletes[0].path,
      "/api/plugins/gots/llm-providers/endpoints/local-llama",
      "for that endpoint, by its id",
    )
    assert.equal(deletes[0].body, null, "and no body: the address names what is removed")
    assert.ok(!dialog(), "the question is done — a retry can't succeed from this screen")
    assert.equal(
      path(),
      "/settings/bots/bot-1/llm-providers/key/custom%3Alocal-llama",
      "the screen stays where it was",
    )
    assert.deepEqual(
      lines(maskRow()),
      ["Local Llama", "llam...0a1f"],
      "and the endpoint's row is still drawn, key and all",
    )
    assert.ok(
      host.block().endpoints.some((one) => one.id === "local-llama"),
      "nothing was deleted on the host either",
    )
  })
})

test("removing another endpoint takes its row off the page", async () => {
  const host = await seed("remove-endpoint-other", ["llm_providers"], {
    ...BLOCK,
    endpoints: ENDPOINTS,
  })
  await mount(settings("/settings/bots/bot-1/llm-providers"), async () => {
    await until(async () => Boolean(endpointRow("work-gateway")), "the host's custom endpoints")
    await click(endpointRow("work-gateway"))
    await until(async () => Boolean(removeEndpoint()), "the Remove endpoint action")

    await click(removeEndpoint())
    await until(async () => Boolean(dialog()), "the question")
    assert.equal(dialogTitle(), "Remove Work gateway?", "naming the endpoint it removes")
    await click(inDialog("Remove"))
    await until(async () => Boolean(page()), "the page the removal answers")

    // The page here is the block the removal answered, drawn once: no read stands between the write
    // and the rows it left, and the endpoint that stayed is still one of them.
    assert.equal(path(), "/settings/bots/bot-1/llm-providers", "and the screen is left behind")
    assert.ok(missing(endpointRow("work-gateway")), "the endpoint that went draws no row")
    assert.ok(endpointRow("local-llama"), "and the one that stayed still does")
    const removedAt = host.asks.findIndex((one) => one.method === "DELETE")
    assert.ok(removedAt >= 0, "the removal was asked")
    assert.ok(
      !host.asks.slice(removedAt + 1).some((one) => one.method === "GET"),
      "and the page asked nothing after it: the block the removal answered is what it drew",
    )
  })
})

test("a mask pasted into the key field keeps Save dead and asks nothing", async () => {
  const host = await seed("pasted-mask", ["llm_providers"])
  await mount(settings("/settings/bots/bot-1/llm-providers"), async () => {
    await until(async () => Boolean(providerRow("openai")), "the host's providers")
    await click(providerRow("openai"))
    await until(async () => Boolean(keyField()), "the key's field")

    // Every shape a mask arrives in, pasted whole: an elision with any length at either end, the
    // ellipsis a copy carries, the sentinel with its » lost, a redaction marker, and dots with a
    // space either side. None of them is a key, so none of them wakes Save.
    for (const shape of [
      "sk-abcd...123456",
      "sk-o\u2026c123",
      "\u00abredacted",
      "[redacted]",
      "sk-o ... c123",
    ]) {
      await type(keyField(), shape)
      assert.equal(saveButton()?.disabled, true, `${shape} is a mask's shape, not a key`)
    }
    // And the very string the row drew, pasted back, is refused as that string.
    const drawn = valueOf(maskRow())
    await type(keyField(), drawn)
    assert.equal(saveButton()?.disabled, true, `the mask the row drew (${drawn}) is never a key`)
    assert.ok(!host.asks.some((one) => one.method === "POST"), "and no write was ever asked")
  })
})

test("a write the host answers without its block is refused in place, keeping the key", async () => {
  const host = await seed("no-block", ["llm_providers"])
  host.answersNoBlock()
  await mount(settings("/settings/bots/bot-1/llm-providers"), async () => {
    await until(async () => Boolean(providerRow("openai")), "the host's providers")
    await click(providerRow("openai"))
    await until(async () => Boolean(keyField()), "the key's field")

    await type(keyField(), "new-key-0000-zyxw")
    await until(async () => saveButton()?.disabled === false, "Save to wake for a typed key")
    await click(saveButton())
    await until(async () => text().includes(UNREAD_ANSWER), "the sentence that it couldn't be read")

    // The answer held no block, so this screen can't say the write landed: the field keeps what was
    // typed, the mask under it is still the one the host last sent, and nothing is claimed.
    assert.equal(keyField()?.value, "new-key-0000-zyxw", "the typed key stays in the field")
    assert.equal(valueOf(maskRow()), "sk-o...c123", "and the key it drew is still the one it drew")
    assert.equal(host.asks.filter((one) => one.method === "POST").length, 1, "one write, no retry")
  })
})

test("a removal the host answers without its block keeps its question up", async () => {
  const host = await seed("no-block-remove", ["llm_providers"])
  await mount(settings("/settings/bots/bot-1/llm-providers"), async () => {
    await until(async () => Boolean(providerRow("openai")), "the host's providers")
    await click(providerRow("openai"))
    await until(async () => Boolean(removeKey()), "the Remove key action")

    host.answersNoBlock()
    await click(removeKey())
    await until(async () => Boolean(dialog()), "the question")
    await click(inDialog("Remove"))
    await until(async () => text().includes(UNREAD_ANSWER), "the sentence that it couldn't be read")

    assert.ok(dialog(), "the question stays up rather than reporting a removal it can't read")
    assert.equal(valueOf(maskRow()), "sk-o...c123", "and the key is still drawn as it was")
  })
})

test("an endpoint removal the host answers without its block stays on the screen", async () => {
  const host = await seed("no-block-endpoint", ["llm_providers"], {
    ...BLOCK,
    endpoints: ENDPOINTS,
  })
  await mount(settings("/settings/bots/bot-1/llm-providers"), async () => {
    await until(async () => Boolean(endpointRow("work-gateway")), "the host's custom endpoints")
    await click(endpointRow("work-gateway"))
    await until(async () => Boolean(removeEndpoint()), "the Remove endpoint action")

    host.answersNoBlock()
    await click(removeEndpoint())
    await until(async () => Boolean(dialog()), "the question")
    await click(inDialog("Remove"))
    await until(async () => text().includes(UNREAD_ANSWER), "the sentence that it couldn't be read")

    // Leaving for the page would say the endpoint is gone; it isn't known to be, so the screen stays
    // with the sentence and the endpoint still drawn.
    assert.equal(
      path(),
      "/settings/bots/bot-1/llm-providers/key/custom%3Awork-gateway",
      "the screen stays where it was",
    )
    assert.equal(titleOf(maskRow()), "Work gateway", "and the endpoint is still drawn")
    assert.ok(!dialog(), "the question is done, since a retry asks the same thing")
  })
})

test("a page returned to reads for itself rather than drawing the block a write left", async () => {
  const host = await seed("stale-block", ["llm_providers"])
  await mount(settings("/settings/bots/bot-1/llm-providers"), async () => {
    await until(async () => Boolean(providerRow("openai")), "the host's providers")

    // A write answers the page: the add form's block rides the navigation back to it.
    await click(addButton())
    await until(async () => Boolean(addForm()), "the add form")
    await type(nameField(), "Home box")
    await type(urlField(), "http://10.0.0.5:8080/v1")
    await type(endpointModelField(), "qwen2.5")
    await type(newKeyField(), "home-box-key-0000-abcd")
    await until(async () => saveButton()?.disabled === false, "Save to wake for a whole endpoint")
    await click(saveButton())
    await until(async () => Boolean(endpointRow("home-box")), "the row the write answered")

    // The page is left, and the host answers differently: its key for OpenAI was replaced somewhere
    // else, and it holds the endpoint the add made.
    await click(providerRow("openai"))
    await until(async () => Boolean(slot()), "the provider's screen")
    host.set({
      providers: host
        .block()
        .providers.map((one) => (one.slug === "openai" ? { ...one, masked: "else...9876" } : one)),
      endpoints: [
        {
          id: "home-box",
          name: "Home box",
          base_url: "http://10.0.0.5:8080/v1",
          model: "qwen2.5",
          masked: "home...abcd",
        },
      ],
    })
    const asked = host.asks.length
    await click(back())
    await until(async () => Boolean(page()), "the page again")

    assert.equal(path(), "/settings/bots/bot-1/llm-providers", "back lands on the page")
    await until(
      async () => valueOf(providerRow("openai")) === "else...9876",
      "the page to read for itself",
    )
    assert.ok(host.asks.length > asked, "it asked the host rather than drawing the block it kept")
    assert.equal(
      valueOf(endpointRow("home-box")),
      "home...abcd",
      "and the endpoint it drew is the host's, not the one the write left behind",
    )
  })
})

test("the add form holds a typed draft, as every other Settings form does", async () => {
  await seed("add-draft", ["llm_providers"])
  await mount(settings("/settings/bots/bot-1/llm-providers"), async () => {
    await until(async () => Boolean(providerRow("openai")), "the host's providers")
    await click(addButton())
    await until(async () => Boolean(addForm()), "the add form")

    assert.equal(holdsUnsavedChanges(), false, "an empty form holds nothing a back would lose")
    await type(nameField(), "Home box")
    await until(async () => holdsUnsavedChanges(), "the draft to be held")
    assert.equal(holdsUnsavedChanges(), true, "a typed field is a draft the back would throw away")
  })
})
