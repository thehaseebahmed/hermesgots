/**
 * A bot's General page: the settings on its own Hermes, drawn from the host's own schema (ADR 0055's
 * rows, ADR 0063's "the same knob, named as Hermes names it"). No headings: a caption per section
 * the host files its keys under, and nothing over the page's own card. A switch writes as it flips,
 * a value opens its edit — its value, the host's default behind it as the placeholder, and a reset
 * where the file holds one — a pick opens its sheet, a key the host only opens at startup says so,
 * and a read that fails says what the host said instead of drawing the host's defaults as values.
 */
import { toast } from "sonner"
import assert from "node:assert/strict"
import test from "node:test"
import { useLiveQuery } from "dexie-react-hooks"
import { MemoryRouter, Route, Routes, useParams } from "react-router"

import { BotSettingsPage } from "@/components/bot-settings"
import { botSubOf } from "@/lib/bot-subs"
import { botTabOf } from "@/lib/bot-tabs"
import { db } from "@/lib/db"
import {
  GENERAL,
  Path,
  botProfile,
  click,
  find,
  findAll,
  json,
  mount,
  path,
  seedSettings,
  type,
  until,
  wordsOf,
} from "./component-kit.tsx"

type Sent = { method: string; path: string; body: Record<string, unknown> | null }
type Block = typeof GENERAL

function LivePage() {
  const { tab, sub } = useParams()
  const profile = useLiveQuery(() => db.profiles.get("bot-1"), [])
  if (!profile) return null
  const shown = botTabOf(tab) ?? "general"
  return (
    <div data-general-page>
      <BotSettingsPage key={profile.id} profile={profile} tab={shown} sub={botSubOf(shown, sub)} />
    </div>
  )
}

const page = (entry = "/settings/bots/bot-1/general") => (
  <MemoryRouter initialEntries={[entry]}>
    <Path />
    <Routes>
      <Route path="/settings/bots/:botId/:tab?/:sub?" element={<LivePage />} />
    </Routes>
  </MemoryRouter>
)

/**
 * A host answering its plugin's `info` and its General route: a read of `block`, and a write that
 * applies one key to it the way the host's own writer does — a value set, or the key removed — and
 * answers the fresh block. Every request is recorded.
 */
function host({
  block = GENERAL,
  features = ["general_page"],
  away = false,
  refuse,
}: {
  block?: Block | null
  features?: string[]
  /** A host that didn't answer at all. */
  away?: boolean
  /** A key this host refuses to write, in its own words. */
  refuse?: { key: string; message: string }
} = {}) {
  const calls: Sent[] = []
  let held = structuredClone(block)
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = (init?.method ?? "GET").toUpperCase()
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ method, path: url.pathname, body })
    if (url.pathname.endsWith("/plugins/gots/info"))
      return away
        ? json({ error: { message: "Not home." } }, 503)
        : json({ name: "gots", features })
    if (url.pathname.endsWith("/plugins/gots/general")) {
      if (method === "POST" && body) {
        if (refuse && body.key === refuse.key)
          return json({ error: { message: refuse.message } }, 400)
        const key = String(body.key)
        held = {
          ...held,
          values: { ...held.values },
        } as Block
        if (body.value === null) delete (held.values as Record<string, unknown>)[key]
        else (held.values as Record<string, unknown>)[key] = body.value
      }
      return json({ object: "gots.general", general: held })
    }
    return json({}, 404)
  }
  return { calls, fetch: fetch as unknown as typeof globalThis.fetch, block: () => held }
}

async function seed(name: string, options: Parameters<typeof host>[0] = {}) {
  await seedSettings()
  await db.profiles.clear()
  await db.profiles.put(botProfile(name, { hostId: "host-1" }))
  const server = host(options)
  globalThis.fetch = server.fetch
  return server
}

const row = (key: string) => find(`[data-setting="${key}"]`)
const rowText = (key: string) => wordsOf(row(key))
/** A caption: the muted line standing over a card of its own. */
const caption = (title: string) =>
  findAll("[data-general-page] p").find((one) => wordsOf(one) === title) ?? null
/** The card a caption names: what follows it. */
const card = (title: string) => caption(title)?.nextElementSibling ?? null
/** The rows of a card, in the order it draws them. */
const rowsIn = (title: string) =>
  [...(card(title)?.querySelectorAll("[data-setting]") ?? [])].map((one) =>
    one.getAttribute("data-setting"),
  )
const headings = () =>
  findAll("[data-general-page] h1, [data-general-page] h2, [data-general-page] h3").map((one) =>
    one.textContent?.trim(),
  )

test("General is the host's own keys, a card per section and nothing over its own", async () => {
  await seed("general-rows")
  await mount(page(), async () => {
    await until(async () => Boolean(find("[data-bot-general]")), "the page")
    assert.deepEqual(headings(), [], "no headings: a caption names a card, and none is a heading")
    assert.equal(caption("General"), null, "and the page's own card carries no caption")
    assert.deepEqual(
      [...(findAll("[data-bot-general] > div")[0]?.querySelectorAll("[data-setting]") ?? [])].map(
        (one) => one.getAttribute("data-setting"),
      ),
      ["model", "toolsets", "max_concurrent_sessions"],
      "the model Hermes's tab leads with, then the keys it filed under no section",
    )
    assert.deepEqual(
      rowsIn("Session"),
      ["session.terminal_continue", "timezone"],
      "then the session's",
    )
    assert.deepEqual(
      rowsIn("Updates"),
      ["updates.check", "updates.pre_update_backup"],
      "then updates",
    )
  })
})

test("the model's window is the host's key, and its zero is Hermes's own detect it", async () => {
  const lead = {
    ...GENERAL,
    fields: [
      ...GENERAL.fields,
      {
        key: "model_context_length",
        kind: "number" as const,
        note: "Context window override (0 = auto-detect from model metadata)",
      },
    ],
    values: { ...GENERAL.values, model_context_length: 0 },
    defaults: { ...GENERAL.defaults, model_context_length: 0 },
  }
  await seed("general-window", { block: lead })
  await mount(page(), async () => {
    await until(async () => Boolean(find('[data-setting="model_context_length"]')), "the window")
    assert.match(
      rowText("model_context_length"),
      /^Model context lengthContext window override \(0 = auto-detect from model metadata\)/,
      "a bare 0 would read as a broken setting, so the row carries the host's sentence about it",
    )
  })
})

test("a row reads the value the file holds, or the host's default muted", async () => {
  await seed("general-values")
  await mount(page(), async () => {
    await until(async () => Boolean(find("[data-bot-general]")), "the page")
    assert.match(rowText("timezone"), /Europe\/London/, "a key the file holds reads what it holds")
    assert.equal(
      row("timezone")?.querySelector(".text-primary")?.textContent,
      "Europe/London",
      "in the accent colour, because this device's host wrote it",
    )
    assert.match(
      rowText("max_concurrent_sessions"),
      /Not set/,
      "a key at its default holds nothing",
    )
    assert.equal(
      row("max_concurrent_sessions")?.querySelector(".text-primary"),
      null,
      "so its value is muted rather than accented",
    )
    assert.match(rowText("toolsets"), /hermes-cli/, "a list reads as its entries")
    assert.match(rowText("updates.pre_update_backup"), /Quick/, "and a pick reads in its own words")
  })
})

test("a switch writes as it flips, and the row follows the host's answer", async () => {
  const server = await seed("general-switch")
  await mount(page(), async () => {
    await until(async () => Boolean(find('[data-setting="updates.check"]')), "the row")
    const control = find('[data-setting="updates.check"]')
    assert.ok(control, "the switch is its own row")
    await click(control)
    await until(async () => server.calls.some((one) => one.method === "POST"), "the write")
    const write = server.calls.find((one) => one.method === "POST")
    assert.deepEqual(write?.body, { key: "updates.check", value: true }, "one key, one value")
    await until(
      async () => (server.block().values as Record<string, unknown>)["updates.check"] === true,
      "the host's fresh answer",
    )
  })
})

test("a value opens its edit: the host's default behind it, and a Reset that clears the key", async () => {
  const server = await seed("general-edit")
  await mount(page("/settings/bots/bot-1/general/timezone"), async () => {
    const field = find("#edit-timezone") as HTMLInputElement | null
    assert.ok(field, "the key's own field, at an address of its own")
    assert.equal(field?.value, "Europe/London", "holding what the file holds")
    assert.deepEqual(
      findAll("[data-form-actions] button").map((one) => wordsOf(one)),
      ["Reset", "Save"],
      "two actions: Reset clears the key, and going back is what cancels",
    )
    await type(field, "UTC")
    await click(
      findAll("[data-form-actions] button").find((one) => wordsOf(one) === "Save") ?? null,
    )
    await until(async () => server.calls.some((one) => one.method === "POST"), "the write")
    assert.deepEqual(
      server.calls.find((one) => one.method === "POST")?.body,
      { key: "timezone", value: "UTC" },
      "the value the field was left holding",
    )
  })
})

test("a pick opens its sheet, searchable where the host says the list is long", async () => {
  const server = await seed("general-pick")
  await mount(page(), async () => {
    await until(async () => Boolean(find('[data-setting="timezone"]')), "the row")
    await click(row("timezone"))
    await until(async () => Boolean(find('[data-pick-list="Timezone"]')), "the pick's sheet")
    assert.ok(find('[aria-label="Search timezone"]'), "a long list is searched, never typed")
    const utc = findAll('[data-pick-list="Timezone"] > button').find(
      (one) => wordsOf(one) === "UTC",
    )
    await click(utc ?? null)
    await until(async () => server.calls.some((one) => one.method === "POST"), "the write")
    assert.deepEqual(
      server.calls.find((one) => one.method === "POST")?.body,
      { key: "timezone", value: "UTC" },
      "the choice, written",
    )
  })
})

test("a key the host only opens at startup says so where it is edited", async () => {
  await seed("general-restart")
  await mount(page("/settings/bots/bot-1/general/max_concurrent_sessions"), async () => {
    assert.match(
      wordsOf(find("[data-general-page]")),
      /Applies when this bot's Hermes restarts\./,
      "the edit carries the note",
    )
  })
})

test("a refused write says the host's sentence and leaves the row as it was", async () => {
  const server = await seed("general-refused", {
    refuse: { key: "updates.check", message: "updates.check is managed by the host." },
  })
  const said: string[] = []
  const real = toast.error
  toast.error = (message) => {
    said.push(String(message))
    return ""
  }
  try {
    await mount(page(), async () => {
      await until(async () => Boolean(find('[data-setting="updates.check"]')), "the row")
      await click(find('[data-setting="updates.check"]'))
      await until(async () => said.length > 0, "the refusal")
      assert.deepEqual(said, ["updates.check is managed by the host."])
      assert.equal(
        (server.block().values as Record<string, unknown>)["updates.check"],
        false,
        "the key is where it was",
      )
    })
  } finally {
    toast.error = real
  }
})

test("a read the host refuses says so, and draws no host row over it", async () => {
  await seed("general-away", { block: null })
  await mount(page(), async () => {
    await until(
      async () =>
        /This host doesn't carry its General settings\./.test(wordsOf(find("[data-bot-general]"))),
      "the banner",
    )
    assert.deepEqual(
      findAll("[data-bot-general] [data-setting]").map((one) => one.getAttribute("data-setting")),
      ["model"],
      "and no host row to write from a read nobody made — only the model, which needs no schema",
    )
  })
})

test("a host without the page lands on the bot's own page, which needs nothing new", async () => {
  await seed("general-absent", { features: [] })
  await mount(page("/settings/bots/bot-1/general"), async () => {
    await until(async () => path() === "/settings/bots/bot-1", "the fallback")
    assert.ok(find("[data-bot-card]"), "the bot's own page")
  })
})
