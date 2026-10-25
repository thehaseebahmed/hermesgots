/**
 * A bot's Chat page, over a seeded device database and a faked host: the Gots plugin's triage model
 * under one ownership heading and the bot's Hermes's model, its default and the chain after it under
 * the other, in that order; the triage explanation as the row's subtitle with no info icon left; the
 * fallback field renamed Fallback providers; a host that withholds the model saying so under the
 * subtitle; Subagent model gone to General; and a group whose card would hold no row drawing no
 * heading at all, on this page and on General.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { useLiveQuery } from "dexie-react-hooks"
import { MemoryRouter, Route, Routes, useParams } from "react-router"

import { BotSettingsPage } from "@/components/bot-settings"
import { botTabOf } from "@/lib/bot-tabs"
import { db } from "@/lib/db"
import { botProfile, find, findAll, json, mount, seedSettings, text } from "./component-kit.tsx"

/** The triage explanation, which was the info icon's tooltip and is now the row's subtitle. */
const TRIAGE =
  "Decides whether a message sent from Main stays there, continues a thread or starts a new one. It only makes that call, so a small, fast model is enough. Default model uses the bot's own."

function LivePage() {
  const { tab } = useParams()
  const profile = useLiveQuery(() => db.profiles.get("bot-1"), [])
  if (!profile) return null
  return <BotSettingsPage key={profile.id} profile={profile} tab={botTabOf(tab) ?? "general"} />
}

/** The page at a bot's address, as the settings route mounts it. */
const page = (path: string) => (
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/settings/bots/:botId/:tab" element={<LivePage />} />
    </Routes>
  </MemoryRouter>
)

/** The headings the page itself draws, in the order it draws them. */
const headings = (scope = "") => findAll(`${scope} h2`).map((heading) => heading.textContent)

/** Every setting label on the page, in order. */
const labels = () =>
  findAll('[data-bot-chat] [data-slot="field-label"]').map((label) => label.textContent)

/** The field of a setting, found by the label a user reads above it. */
const fieldOf = (name: string, scope = "[data-bot-chat]") =>
  findAll(`${scope} [data-slot="field-label"]`)
    .find((label) => label.textContent === name)
    ?.closest('[data-slot="field"]') ?? null

/** The field of a setting, found by the label that names it: what a screen reader reads. */
const fieldNamed = (name: string, scope = "[data-bot-chat]") =>
  findAll(`${scope} [data-slot="field"]`).find((field) => {
    const id = field.getAttribute("aria-labelledby")
    return id ? document.getElementById(id)?.textContent === name : false
  }) ?? null

/** The line under a setting's label saying what it is for. */
const subtitleOf = (field: Element | null) =>
  field?.querySelector('[data-slot="field-description"]')?.textContent ?? null

/** Which settings sit under which ownership heading, in drawing order. */
function grouped() {
  const root = find("[data-bot-chat]")
  const found: Record<string, string[]> = {}
  let heading = ""
  for (const block of Array.from(root?.children ?? [])) {
    const title = block.querySelector("h2")?.textContent
    if (title) {
      heading = title
      found[heading] = []
      continue
    }
    for (const label of Array.from(block.querySelectorAll('[data-slot="field-label"]')))
      found[heading]?.push(label.textContent ?? "")
  }
  return found
}

const flat = (element: Element | null) => (element?.textContent ?? "").replace(/\s+/g, " ")

/**
 * A host answering the plugin's `info` (its features, and whether it lets Gots pick the model) plus
 * the three settings routes and the two reads the model pickers make.
 */
function host({
  features = ["triage_model", "fallbacks", "host_model"],
  writers = true,
  models = ["own-model", "cheap-model"],
}: { features?: string[]; writers?: boolean; models?: string[] } = {}) {
  const calls: { method: string; path: string }[] = []
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    calls.push({ method: init?.method ?? "GET", path })
    if (path.endsWith("/plugins/memento/info"))
      return json({
        name: "memento",
        features,
        research: { writers: { model: writers, provider: writers } },
      })
    if (path.endsWith("/plugins/memento/triage-model")) return json({ triage_model: null })
    if (path.endsWith("/plugins/memento/fallbacks")) return json({ fallbacks: [] })
    if (path.endsWith("/api/model/options"))
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
    if (path.endsWith("/models")) return json({ data: models.map((id) => ({ id })) })
    return json({})
  }
  return { calls, fetch: fetch as unknown as typeof globalThis.fetch }
}

/** A bot of this test's own: its connection names a host, so no other test's answers are read. */
async function seed(
  name: string,
  features: string[],
  patch = {},
  options: { writers?: boolean; models?: string[] } = {},
) {
  await seedSettings()
  await db.profiles.clear()
  await db.profiles.put(botProfile(name, patch))
  const fake = host({ features, ...options })
  globalThis.fetch = fake.fetch
  return fake
}

test("the Chat page is the Gots triage pick, then the model, default and fallback providers", async () => {
  await seed("chat-groups", ["triage_model", "fallbacks", "host_model", "delegation_model"])
  await mount(page("/settings/bots/bot-1/chat"), async () => {
    assert.deepEqual(
      headings("[data-bot-chat]"),
      ["Gots Specific Settings", "Hermes Settings"],
      "one heading per ownership, in order",
    )
    assert.deepEqual(
      grouped(),
      {
        "Gots Specific Settings": ["Triage model"],
        "Hermes Settings": ["Model", "Default model", "Fallback providers"],
      },
      "every setting under the owner it belongs to",
    )
    assert.deepEqual(
      labels(),
      ["Triage model", "Model", "Default model", "Fallback providers"],
      "and in the order the page draws them",
    )
    assert.doesNotMatch(text(), /Subagent model/, "Subagent model is General's, not this page's")
  })
})

test("the triage row says what the model decides, and the info icon is gone", async () => {
  await seed("chat-triage-copy", ["triage_model", "fallbacks", "host_model"])
  await mount(page("/settings/bots/bot-1/chat"), async () => {
    const field = fieldNamed("Triage model")
    assert.ok(field, "the triage field is on the page")
    assert.equal(subtitleOf(field), TRIAGE, "the explanation is the row's subtitle, word for word")
    assert.equal(find('[aria-label="About the triage model"]'), null, "the info icon is gone")
    assert.equal(find('[aria-label^="About the"]'), null, "and nothing else explains it in a pop-up")
    assert.ok(find("#triage-model"), "the picker itself is untouched")
  })
})

test("the fallback field is Fallback providers, saying what the chain is for", async () => {
  await seed("chat-fallbacks", ["triage_model", "fallbacks", "host_model"])
  await mount(page("/settings/bots/bot-1/chat"), async () => {
    assert.equal(
      find("#fallback-models-label")?.textContent,
      "Fallback providers",
      "the label a user reads",
    )
    const field = fieldNamed("Fallback providers")
    assert.ok(field, "and the name the field group answers to")
    assert.equal(
      subtitleOf(field),
      "The chain Hermes tries after the main model",
      "with its subtitle",
    )
    assert.doesNotMatch(text(), /Fallback models/, "the old name is nowhere on the page")
  })
})

test("the model and default model rows say what each is for", async () => {
  await seed("chat-subtitles", ["triage_model", "fallbacks", "host_model"])
  await mount(page("/settings/bots/bot-1/chat"), async () => {
    assert.equal(
      subtitleOf(fieldOf("Model")),
      "The model a chat runs when it has no pick of its own",
      "the model a chat runs",
    )
    assert.equal(
      subtitleOf(fieldOf("Default model")),
      "The host's main model, on every surface",
      "and the default the host runs",
    )
  })
})

test("a host that withholds the model keeps its banner under the subtitle", async () => {
  await seed("chat-withheld", ["triage_model", "fallbacks", "host_model"], {}, { writers: false })
  await mount(page("/settings/bots/bot-1/chat"), async () => {
    const field = fieldOf("Triage model")
    assert.ok(field, "the triage field is still there")
    assert.equal(subtitleOf(field), TRIAGE, "the subtitle is unchanged")
    const body = flat(field)
    const subtitle = body.indexOf(TRIAGE)
    const banner = body.indexOf("This host doesn't let Gots pick the model.")
    assert.ok(subtitle >= 0, "the subtitle is drawn")
    assert.ok(banner > subtitle, "the banner sits under the subtitle")
  })
})

test("a host without the triage route leaves the Chat page its Hermes group alone", async () => {
  await seed("chat-no-triage", ["fallbacks", "host_model"])
  await mount(page("/settings/bots/bot-1/chat"), async () => {
    assert.deepEqual(headings("[data-bot-chat]"), ["Hermes Settings"], "no heading over an empty card")
    assert.equal(find("#triage-model"), null, "and no triage pick")
  })
})

test("a group with no row draws no heading: a linked bot whose host withholds delegation", async () => {
  await seed("chat-general-empty", ["triage_model", "fallbacks"], { hostId: "host-1" })
  await mount(page("/settings/bots/bot-1/general"), async () => {
    assert.deepEqual(
      headings(),
      ["Gots Specific Settings", "Bot Profile"],
      "no Hermes Settings over a card with nothing in it",
    )
    assert.doesNotMatch(text(), /API base URL/, "a linked bot's address is its host's")
    assert.doesNotMatch(text(), /Server key/, "and so is its key")
  })
})

test("the Hermes heading is there once the card has a row, linked or not", async () => {
  await seed("chat-general-delegation", ["triage_model", "fallbacks", "delegation_model"], {
    hostId: "host-1",
  })
  await mount(page("/settings/bots/bot-1/general"), async () => {
    assert.deepEqual(
      headings(),
      ["Gots Specific Settings", "Bot Profile", "Hermes Settings"],
      "the delegation row earns its heading",
    )
    assert.ok(fieldNamed("Subagent model", ""), "Subagent model is General's")
  })

  await seed("chat-general-unlinked", ["triage_model", "fallbacks"])
  await mount(page("/settings/bots/bot-1/general"), async () => {
    assert.deepEqual(
      headings(),
      ["Gots Specific Settings", "Bot Profile", "Hermes Settings"],
      "an unlinked bot's own address and key keep the heading",
    )
    assert.match(text(), /API base URL/)
    assert.match(text(), /Server key/)
  })
})
