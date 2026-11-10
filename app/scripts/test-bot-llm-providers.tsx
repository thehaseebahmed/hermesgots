/**
 * The LLM Providers page: the API-key providers this bot's Hermes knows and the custom endpoints it
 * holds, each row saying which one it is and, as its value, the key the host masked itself — or
 * *Not set* where there is none. The value is the host's mask and never a key: the page is handed
 * `sk-o...c123` and draws it as it arrived, so nothing here derives, reveals or compares a key.
 *
 * A row opens one form for the whole slot. A provider's form holds its API key alone, and the mask
 * the row drew is the field's **placeholder**: an empty field keeps the key that is there, and only
 * something typed over it is written — so the mask never rides a write, and `Save` is dead until
 * there is something to send. An endpoint's form holds every setting the host keeps for it — name,
 * base URL, model, transport, the session-affinity header and the key — filled with the values the
 * row holds, and it posts the fields that differ plus the endpoint's id.
 *
 * The actions stand at the screen's foot on a phone: `Delete` / `Delete` on the left,
 * because the row holds something to delete, and `Cancel` in its place on a provider that holds no
 * key — where the back arrow is the only way out. `Delete` asks first; the answer is the host's
 * fresh block, or the host's own sentence when it refuses.
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

type Provider = {
  slug: string
  label: string
  description: string
  /** The variable its key is written to — the form's field label. */
  env: string
  masked: string | null
}
/** One custom endpoint, as the host's list answers it: every setting a form can change. */
type Endpoint = {
  id: string
  name: string
  base_url: string
  model: string
  /** The transport it pins (`api_mode` on the host), `""` for Automatic. */
  transport: string
  /** The header a proxy carries the conversation on, `""` for none. */
  affinity: string
  /** The variable its key is held in — the form's key field label. */
  key_env: string
  masked: string | null
}
type Block = { providers: Provider[]; endpoints: Endpoint[] }

/** What `GET llm-providers` answers: two providers, one with a key and one without. */
const BLOCK: Block = {
  providers: [
    {
      slug: "openai",
      label: "OpenAI",
      description: "GPT models, straight from OpenAI.",
      env: "OPENAI_API_KEY",
      masked: "sk-o...c123",
    },
    {
      slug: "groq",
      label: "Groq",
      description: "Fast inference on Groq's hardware.",
      env: "GROQ_API_KEY",
      masked: null,
    },
  ],
  endpoints: [],
}

/**
 * The custom endpoints a host holds: one with a key and a transport, one without either but with a
 * session-affinity header. They draw under their own caption, and either one's row opens the form
 * that holds the whole setting.
 */
const ENDPOINTS: Endpoint[] = [
  {
    id: "local-llama",
    name: "Local Llama",
    base_url: "http://127.0.0.1:8080/v1",
    model: "llama-3.1-8b",
    transport: "chat_completions",
    affinity: "",
    key_env: "HERMES_CUSTOM_LOCAL_LLAMA_API_KEY",
    masked: "llam...0a1f",
  },
  {
    id: "work-gateway",
    name: "Work gateway",
    base_url: "https://llm.example.com/v1",
    model: "gpt-4o-mini",
    transport: "",
    affinity: "x-litellm-session-id",
    key_env: "HERMES_CUSTOM_WORK_GATEWAY_API_KEY",
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
 * the block that host answers next, an endpoint's write lands on its row, and every request is
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
      // A custom endpoint written (plugin/llm_providers.py): with an `id` the body is a patch on
      // the row that id names — what it carries is written and what it leaves out is kept — and
      // without one the host adds the row it slugs from the name. Either way a key rides only when
      // one was typed, and the answer is the block with the row as the write left it.
      const words = (field: string, fallback: string) => {
        const sent = body?.[field]
        return typeof sent === "string" && sent.trim() ? sent.trim() : fallback
      }
      const typed = typeof body?.key === "string" ? body.key.trim() : ""
      const id = typeof body?.id === "string" ? body.id : ""
      if (id) {
        const held = current.endpoints.find((one) => one.id === id)
        if (!held)
          return json({ error: { message: `${id} isn't a custom endpoint this Hermes knows.` } }, 400)
        const next: Endpoint = {
          ...held,
          name: words("name", held.name),
          base_url: words("base_url", held.base_url),
          model: words("model", held.model),
          transport: "transport" in (body ?? {}) ? String(body?.transport ?? "") : held.transport,
          affinity: "affinity" in (body ?? {}) ? String(body?.affinity ?? "") : held.affinity,
          masked: typed ? maskOf(typed) : held.masked,
        }
        current = {
          ...current,
          endpoints: current.endpoints.map((one) => (one.id === id ? next : one)),
        }
        return answered(current)
      }
      const name = String(body?.name ?? "").trim()
      const added: Endpoint = {
        id: slugOf(name),
        name,
        base_url: String(body?.base_url ?? ""),
        model: String(body?.model ?? ""),
        transport: typeof body?.transport === "string" ? body.transport : "",
        affinity: typeof body?.affinity === "string" ? body.affinity : "",
        masked: typed ? maskOf(typed) : null,
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

/** The page itself, one provider's row on it, and the slot screens a row opens. */
const page = () => find("[data-bot-llm-providers]")
const providerRow = (slug: string) => find(`[data-setting="llm-provider-${slug}"]`)
const endpointRow = (id: string) => find(`[data-setting="llm-endpoint-${id}"]`)
const slot = () => find("[data-llm-provider-slot]")
/** The endpoint's form, which holds every setting the row does. */
const endpointForm = () => find("[data-llm-endpoint-form]")
/**
 * The provider's key field: the app's own `EditForm`, whose field is the only input on a key
 * screen. Its label names the provider, so the screen says whose key it is under a title that says
 * what the screen does.
 */
const keyField = () =>
  find("[data-llm-provider-slot] input[type=password]") as HTMLInputElement | null
/** An endpoint's fields, by the setting each holds. */
const field = (name: string) => find(`[data-llm-endpoint-${name}]`) as HTMLInputElement | null
/** The transport, a pick: the control shows the choice it holds and opens the list. */
const transportField = () => find("[data-llm-endpoint-transport]")
const pick = (label: string) => findText("[data-pick-list] button", label)
/** The page's own `+`, and the form it opens: one field per thing a new endpoint needs. */
const addButton = () => find("[data-llm-add-endpoint]")
const addForm = () => find("[data-llm-endpoint-add]")
const nameField = () => find("[data-llm-endpoint-name]") as HTMLInputElement | null
const urlField = () => find("[data-llm-endpoint-base-url]") as HTMLInputElement | null
/** The form's actions: one bar, its left action and its Save. */
const saveButton = () =>
  findAll("[data-form-actions] button").find((one) => one.textContent?.trim() === "Save") ?? null
const leftAction = () =>
  findAll("[data-form-actions] button")
    .map((one) => one.textContent?.trim() ?? "")
    .find((label) => label !== "Save") ?? ""
const bar = () => find("[data-form-actions]")
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

// (a)
test("a provider's form holds its key alone, its mask as the placeholder, and no Save yet", async () => {
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
    assert.equal(
      findAll("h1").map((heading) => heading.textContent).at(-1),
      "Edit OpenAI",
      "the screen's heading carries the verb and names whose key it is",
    )
    // The mask is the field's own placeholder: what is there is what the field says, and typing
    // over it is the only way to replace it.
    assert.equal(keyField()?.value, "", "the field starts empty")
    assert.equal(
      keyField()?.getAttribute("placeholder"),
      "sk-o...c123",
      "and its placeholder is the key the host holds, masked",
    )
    assert.equal(
      find("[data-llm-provider-slot] label")?.textContent?.trim(),
      "OPENAI_API_KEY",
      "the field is labelled with the variable the key is written to",
    )
    assert.equal(saveButton()?.disabled, true, "Save is dead until something is typed over it")
    // The app's own edit form, so the field carries what every secret the app edits carries.
    assert.ok(find('[aria-label="Show key"]'), "a show/hide toggle, because the form is `EditForm`")
    // The shape the last one had, and the new one hasn't: a mask row above the form and a caption
    // over it both went with the form that holds the whole setting.
    assert.ok(missing('[data-setting="llm-provider-mask"]'), "no mask row stands above the form")
    assert.ok(!text().includes("Replace key"), "and no caption over it")
    assert.ok(!text().includes("New key"), "and no `New key` label")
  })
})

// (b)
test("a typed key is posted and the row reads the mask the host makes of it", async () => {
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
      async () => keyField()?.getAttribute("placeholder") === "new-...zyxw",
      "the field to read the mask the write answered",
    )
    assert.equal(keyField()?.value, "", "and the field is empty again, holding no key")
    assert.equal(saveButton()?.disabled, true, "with nothing to send until the next key is typed")
    assert.equal(leftAction(), "Delete", "and the key it just set is the one that can be deleted")
  })
})

// (c)
test("an endpoint's form holds every setting with the values the row does", async () => {
  await seed("endpoint-form", ["llm_providers"], { ...BLOCK, endpoints: ENDPOINTS })
  await mount(settings("/settings/bots/bot-1/llm-providers"), async () => {
    await until(async () => Boolean(endpointRow("local-llama")), "the host's custom endpoints")
    await click(endpointRow("local-llama"))
    await until(async () => Boolean(endpointForm()), "the endpoint's form")

    assert.equal(
      path(),
      "/settings/bots/bot-1/llm-providers/key/custom%3Alocal-llama",
      "the address still names the endpoint's slot",
    )
    assert.equal(
      findAll("h1").map((heading) => heading.textContent).at(-1),
      "Edit Custom Provider",
      "and the heading carries the verb over the endpoint's whole shape",
    )
    assert.equal(field("name")?.value, "Local Llama", "its name")
    assert.equal(field("base-url")?.value, "http://127.0.0.1:8080/v1", "the base URL it runs on")
    assert.equal(field("model")?.value, "llama-3.1-8b", "the model it serves")
    assert.equal(
      transportField()?.textContent?.trim(),
      "Chat completions",
      "the transport it pins, in words",
    )
    assert.equal(field("affinity")?.value, "", "the session-affinity header it carries, if any")
    assert.equal(field("key")?.value, "", "the key field starts empty")
    assert.equal(
      field("key")?.getAttribute("placeholder"),
      "llam...0a1f",
      "and its placeholder is the mask the host holds",
    )
    assert.equal(saveButton()?.disabled, true, "Save is dead until one of them changes")

    await type(field("model"), "llama-3.1-70b")
    await until(async () => saveButton()?.disabled === false, "Save to wake for a changed field")
  })
})

// (d)
test("saving an endpoint posts the fields that changed and its id, and no key", async () => {
  const host = await seed("endpoint-save", ["llm_providers"], { ...BLOCK, endpoints: ENDPOINTS })
  await mount(settings("/settings/bots/bot-1/llm-providers"), async () => {
    await until(async () => Boolean(endpointRow("local-llama")), "the host's custom endpoints")
    await click(endpointRow("local-llama"))
    await until(async () => Boolean(endpointForm()), "the endpoint's form")

    await type(field("model"), "llama-3.1-70b")
    await until(async () => saveButton()?.disabled === false, "Save to wake for a changed model")
    await click(saveButton())
    await until(async () => host.asks.some((one) => one.method === "POST"), "the write")

    const write = host.asks.find((one) => one.method === "POST")
    assert.deepEqual(
      write?.body,
      { id: "local-llama", model: "llama-3.1-70b" },
      "the one field that differs, under the id of the row it edits — and no key at all",
    )
    assert.equal(
      field("model")?.value,
      "llama-3.1-70b",
      "the form reads the block the write answered, its model as the host now holds it",
    )
    await until(async () => saveButton()?.disabled === true, "and Save is dead again")
  })
})

// (e)
test("a typed key rides the endpoint's own write, and the row reads its new mask", async () => {
  const host = await seed("endpoint-key", ["llm_providers"], { ...BLOCK, endpoints: ENDPOINTS })
  await mount(settings("/settings/bots/bot-1/llm-providers"), async () => {
    await until(async () => Boolean(endpointRow("local-llama")), "the host's custom endpoints")
    await click(endpointRow("local-llama"))
    await until(async () => Boolean(endpointForm()), "the endpoint's form")

    // The transport is a pick, and picking one is a change the form would write.
    await click(transportField())
    await until(async () => Boolean(pick("Anthropic messages")), "the transport's choices")
    await click(pick("Anthropic messages"))
    assert.equal(transportField()?.textContent?.trim(), "Anthropic messages", "the pick it took")

    await type(field("key"), "endpoint-key-0000-0a1f")
    await until(async () => saveButton()?.disabled === false, "Save to wake for a typed key")
    await click(saveButton())
    await until(async () => host.asks.some((one) => one.method === "POST"), "the write")

    const write = host.asks.find((one) => one.method === "POST")
    assert.deepEqual(
      write?.body,
      {
        id: "local-llama",
        transport: "anthropic_messages",
        key: "endpoint-key-0000-0a1f",
      },
      "the transport that changed, the key that was typed, and the id — and no field that didn't",
    )
    await until(
      async () => field("key")?.getAttribute("placeholder") === "endp...0a1f",
      "the key field to read the mask the write answered",
    )
    assert.equal(field("key")?.value, "", "and to hold no key afterwards")

    await click(back())
    await until(async () => Boolean(page()), "the page again")
    await until(
      async () => valueOf(endpointRow("local-llama")) === "endp...0a1f",
      "the row to read the mask the host made",
    )
  })
})

// (f)
test("Delete stands where the slot holds something to delete, and asks before it goes", async () => {
  const host = await seed("delete", ["llm_providers"], { ...BLOCK, endpoints: ENDPOINTS })
  await mount(settings("/settings/bots/bot-1/llm-providers"), async () => {
    await until(async () => Boolean(providerRow("openai")), "the host's providers")

    // A provider holding a key: the bar's left action is the key's removal, and the way out is the
    // back arrow — so no Cancel is offered beside it.
    await click(providerRow("openai"))
    await until(async () => Boolean(keyField()), "the key's field")
    assert.equal(leftAction(), "Delete", "Delete leads the bar")
    assert.ok(
      !findAll("[data-form-actions] button").some((one) => one.textContent?.trim() === "Cancel"),
      "and no Cancel stands beside it",
    )
    assert.ok(bar()?.closest("form"), "the bar is inside the form whose Save it presses")

    const asked = host.asks.length
    await click(findText("[data-form-actions] button", "Delete"))
    await until(async () => Boolean(dialog()), "the question")
    assert.equal(dialogTitle(), "Remove OpenAI's key?", "which names the provider")
    await click(inDialog("Cancel"))
    await until(async () => !dialog(), "the question to shut")
    assert.equal(host.asks.length, asked, "and canceling it makes no request at all")
    assert.equal(
      keyField()?.getAttribute("placeholder"),
      "sk-o...c123",
      "the key is still the one that was there",
    )

    await click(findText("[data-form-actions] button", "Delete"))
    await until(async () => Boolean(dialog()), "the question again")
    await click(inDialog("Remove"))
    await until(
      async () => keyField()?.getAttribute("placeholder") === "Paste the key",
      "the answered block, where the row holds no key",
    )
    const deletes = host.asks.filter((one) => one.method === "DELETE")
    assert.equal(deletes.length, 1, "exactly one removal")
    assert.equal(deletes[0].path, "/api/plugins/gots/llm-providers/key/openai", "for that provider")
    assert.equal(deletes[0].body, null, "and no body: the address names what is removed")
    assert.equal(leftAction(), "Cancel", "and with nothing left to delete the bar offers Cancel")

    // An endpoint's form: the slot holds the endpoint and its key together, so Delete is
    // the left action wherever the endpoint is, and the back arrow is the way out.
    await click(back())
    await until(async () => Boolean(page()), "the page again")
    await click(endpointRow("work-gateway"))
    await until(async () => Boolean(endpointForm()), "the endpoint's form")
    assert.equal(leftAction(), "Delete", "Delete leads the bar")
    assert.ok(
      !findAll("[data-form-actions] button").some((one) => one.textContent?.trim() === "Cancel"),
      "and no Cancel beside it",
    )
    await click(findText("[data-form-actions] button", "Delete"))
    await until(async () => Boolean(dialog()), "the question")
    assert.equal(dialogTitle(), "Remove Work gateway?", "naming the endpoint it removes")
    await click(inDialog("Remove"))
    await until(async () => Boolean(page()), "the page the removal answers")

    assert.equal(path(), "/settings/bots/bot-1/llm-providers", "the screen is left behind")
    assert.ok(missing(endpointRow("work-gateway")), "the endpoint that went draws no row")
    assert.ok(endpointRow("local-llama"), "and the one that stayed still does")
  })
})

// (g)
test("a provider holding no key leads with Cancel, which leaves without a request", async () => {
  const host = await seed("cancel", ["llm_providers"])
  await mount(settings("/settings/bots/bot-1/llm-providers"), async () => {
    await until(async () => Boolean(providerRow("groq")), "the host's providers")
    await click(providerRow("groq"))
    await until(async () => Boolean(keyField()), "the key's field")

    assert.equal(leftAction(), "Cancel", "nothing here can be deleted, so Cancel leads the bar")
    const asked = host.asks.length
    await click(findText("[data-form-actions] button", "Cancel"))
    await until(async () => Boolean(page()), "the page again")
    assert.equal(path(), "/settings/bots/bot-1/llm-providers", "Cancel leaves the screen")
    // The page it lands on reads for itself — that is the page's business — but Cancel itself wrote
    // nothing: no write was ever asked, here or on the way out.
    assert.equal(host.asks.filter((one) => one.method !== "GET").length, 0, "no write was ever asked")
    assert.ok(
      host.asks.slice(asked).every((one) => one.method === "GET"),
      "and only the page's own read followed it",
    )
  })
})

// (h)
test("the actions stand in the form's foot, which fills the screen above them", async () => {
  await seed("foot", ["llm_providers"], { ...BLOCK, endpoints: ENDPOINTS })
  await mount(settings("/settings/bots/bot-1/llm-providers"), async () => {
    await until(async () => Boolean(endpointRow("local-llama")), "the host's custom endpoints")
    // The endpoint's form is the tallest one, so it is the one whose actions have to stay reachable.
    await click(endpointRow("local-llama"))
    await until(async () => Boolean(endpointForm()), "the endpoint's form")

    const form = endpointForm()!
    const foot = find("[data-form-foot]")
    assert.ok(foot, "the actions stand in a foot of the form's own")
    assert.equal(foot.parentElement, form, "inside the form")
    assert.equal(foot, form.lastElementChild, "as its last row, under every field")
    assert.ok(
      foot.className.includes("sticky") && foot.className.includes("bottom-0"),
      "stuck to the bottom of the screen the form is scrolled in",
    )
    assert.ok(
      form.className.includes("min-h-[calc(100dvh"),
      "and the form takes the screen's height, so the foot lands on its floor",
    )
    // jsdom lays nothing out — every box is 0×0 — so "inside the viewport at 390×844" cannot be
    // measured here (ADR 0019 sends geometry to the sweep). What this holds is the structure; the
    // screenshots at 390×844 are what show the bar on the screen's floor.
    assert.equal(
      document.documentElement.getBoundingClientRect().height,
      0,
      "jsdom gives no layout, so the geometry is proved by the sweep's screenshots",
    )
  })
})

test("removing the endpoint the model runs on is refused and deletes nothing", async () => {
  const host = await seed("remove-endpoint", ["llm_providers"], { ...BLOCK, endpoints: ENDPOINTS })
  await mount(settings("/settings/bots/bot-1/llm-providers"), async () => {
    await until(async () => Boolean(endpointRow("local-llama")), "the host's custom endpoints")
    await click(endpointRow("local-llama"))
    await until(async () => Boolean(endpointForm()), "the endpoint's form")

    await click(findText("[data-form-actions] button", "Delete"))
    await until(async () => Boolean(dialog()), "the question")
    assert.equal(dialogTitle(), "Remove Local Llama?", "and the question names the endpoint")
    await click(inDialog("Remove"))
    await until(async () => text().includes(IN_USE), "the host's sentence")

    assert.deepEqual(
      host.refusals,
      [{ status: 409, code: "endpoint_in_use" }],
      "the host refused under the plan's own status and code, and the page drew its sentence",
    )
    // The one removal, and the answer to it is the host's own words rather than the app's. Nothing
    // was deleted, so the screen and the fields it draws are exactly what they were.
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
    assert.equal(field("name")?.value, "Local Llama", "and the endpoint is still drawn, whole")
    assert.ok(
      host.block().endpoints.some((one) => one.id === "local-llama"),
      "nothing was deleted on the host either",
    )
  })
})

test("the plus opens a form that adds an endpoint's whole shape", async () => {
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
      findAll("h1").some((heading) => heading.textContent === "Add Custom Provider"),
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
    await type(field("model"), "qwen2.5")
    assert.equal(saveButton()?.disabled, true, "and nothing is saved without a key")
    await type(field("key"), "home-box-key-0000-abcd")
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
      "the four fields the form holds, and nothing else: no transport and no header it wasn't given",
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

test("a mask pasted into a key field keeps Save dead and asks nothing", async () => {
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
    const drawn = keyField()?.getAttribute("placeholder") ?? ""
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
    // typed, and the mask it drew is still the one it drew.
    assert.equal(keyField()?.value, "new-key-0000-zyxw", "the typed key stays in the field")
    assert.equal(
      keyField()?.getAttribute("placeholder"),
      "sk-o...c123",
      "and the key it drew is still the one it drew",
    )
    assert.equal(host.asks.filter((one) => one.method === "POST").length, 1, "one write, no retry")
  })
})

test("a removal the host answers without its block keeps its question up", async () => {
  const host = await seed("no-block-remove", ["llm_providers"])
  await mount(settings("/settings/bots/bot-1/llm-providers"), async () => {
    await until(async () => Boolean(providerRow("openai")), "the host's providers")
    await click(providerRow("openai"))
    await until(async () => Boolean(keyField()), "the key's field")

    host.answersNoBlock()
    await click(findText("[data-form-actions] button", "Delete"))
    await until(async () => Boolean(dialog()), "the question")
    await click(inDialog("Remove"))
    await until(async () => text().includes(UNREAD_ANSWER), "the sentence that it couldn't be read")

    assert.ok(dialog(), "the question stays up rather than reporting a removal it can't read")
    assert.equal(
      keyField()?.getAttribute("placeholder"),
      "sk-o...c123",
      "and the key is still drawn as it was",
    )
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
    await until(async () => Boolean(endpointForm()), "the endpoint's form")

    host.answersNoBlock()
    await click(findText("[data-form-actions] button", "Delete"))
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
    assert.equal(field("name")?.value, "Work gateway", "and the endpoint is still drawn")
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
    await type(field("model"), "qwen2.5")
    await type(field("key"), "home-box-key-0000-abcd")
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
          transport: "",
          affinity: "",
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
