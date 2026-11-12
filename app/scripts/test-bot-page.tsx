/**
 * A bot's own page, over a seeded device database and a faked host (ADR 0055, ADR 0104, ADR 0143):
 * what the bot is under the caption *Bot* — its switches, the plugin its host runs, its profile, and
 * how it connects — with no heading at all, every setting a title over the line saying what it is for
 * and the value it holds in the accent colour, "Not set" where it holds nothing, a value's tap
 * opening its edit as a pushed screen and its pick as a bottom sheet, and the write each lands at the
 * fetch boundary. The settings behind it — every other page's row — sit in one card under *Settings*,
 * which the list's own test holds.
 */
import { toast } from "sonner"
import assert from "node:assert/strict"
import test from "node:test"
import { useLiveQuery } from "dexie-react-hooks"
import { useState } from "react"
import { MemoryRouter, Route, Routes, useParams } from "react-router"

import { BotSettingsList, BotSettingsPage } from "@/components/bot-settings"
import { useReadAttempt } from "@/lib/read-attempt"
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
  labelled,
  missing,
  mount,
  path,
  refuseFirst,
  seedSettings,
  settle,
  type,
  until,
  wordsOf,
} from "./component-kit.tsx"

/** General draws the host's Subagent model only where its plugin advertises the override. */
const FEATURES = ["delegation_model"]

const DELEGATION = {
  fields: [
    { key: "delegation.backend", kind: "string" as const, section: "" },
    { key: "delegation.compression_threshold_tokens", kind: "number" as const, section: "" },
    { key: "delegation.inherit_mcp_toolsets", kind: "boolean" as const, section: "" },
    { key: "delegation.max_iterations", kind: "number" as const, section: "" },
    { key: "delegation.max_summary_chars", kind: "number" as const, section: "" },
    { key: "delegation.child_timeout_seconds", kind: "number" as const, section: "" },
    {
      key: "delegation.reasoning_effort",
      kind: "select" as const,
      section: "",
      options: ["", "low", "high"],
    },
    { key: "delegation.max_concurrent_children", kind: "number" as const, section: "" },
    { key: "delegation.independent_completions", kind: "boolean" as const, section: "" },
    { key: "delegation.max_spawn_depth", kind: "number" as const, section: "" },
    { key: "delegation.orchestrator_enabled", kind: "boolean" as const, section: "" },
    { key: "delegation.oneshot_max_children", kind: "number" as const, section: "" },
    { key: "delegation.subagent_auto_approve", kind: "boolean" as const, section: "" },
    {
      key: "delegation.surface_child_process_notifications",
      kind: "boolean" as const,
      section: "",
    },
  ],
  values: {},
  defaults: {
    "delegation.backend": "default",
    "delegation.compression_threshold_tokens": 0,
    "delegation.inherit_mcp_toolsets": true,
    "delegation.max_iterations": 250,
    "delegation.max_summary_chars": 24000,
    "delegation.child_timeout_seconds": 0,
    "delegation.reasoning_effort": "",
    "delegation.max_concurrent_children": 10,
    "delegation.independent_completions": false,
    "delegation.max_spawn_depth": 1,
    "delegation.orchestrator_enabled": true,
    "delegation.oneshot_max_children": 2,
    "delegation.subagent_auto_approve": false,
    "delegation.surface_child_process_notifications": false,
  },
}

/** The host's General block, as its schema offers it: a key at the top level and one in a section. */
const HOST_GENERAL = {
  fields: [
    { key: "timezone", kind: "string" as const, section: "" },
    { key: "session.terminal_continue", kind: "boolean" as const, section: "session" },
  ],
  values: { timezone: "Europe/London" },
  defaults: {},
}

function LivePage() {
  const { tab, sub } = useParams()
  const profile = useLiveQuery(() => db.profiles.get("bot-1"), [])
  if (!profile) return null
  // The bot's page is the entry itself; its edits are addressed under its own segment.
  if (!tab)
    return (
      <div data-general-page>
        <BotSettingsList key={profile.id} profile={profile} />
      </div>
    )
  const shown = botTabOf(tab) ?? "bot"
  return (
    <div data-general-page>
      <BotSettingsPage key={profile.id} profile={profile} tab={shown} sub={botSubOf(shown, sub)} />
    </div>
  )
}

const general = (entry = "/settings/bots/bot-1") => (
  <MemoryRouter initialEntries={[entry]}>
    <Path />
    <Routes>
      <Route path="/settings/bots/:botId/:tab?/:sub?" element={<LivePage />} />
    </Routes>
  </MemoryRouter>
)

type Sent = { method: string; path: string; body: Record<string, unknown> | null }

/**
 * A host answering the plugin's `info` (its features and version), the delegation route and its
 * models, and recording every request it was sent.
 */
function host({
  features = FEATURES,
  version = "0.81.0" as string | null,
  models = ["own-model", "cheap-model"],
  away = false,
  level = "normal" as string | null,
  refuse,
  noDelegation = false,
  customDelegation = false,
  generalRefusals = 0,
  noGeneral = false,
}: {
  features?: string[]
  version?: string | null
  models?: string[]
  /** A host that hasn't answered at all: no feature list, so no page has a gate to read. */
  away?: boolean
  /** The level this host holds — `frequent` from a plugin written before the four names. */
  level?: string | null
  /** A level this host won't take, as a plugin from before the four names won't take Quiet. */
  refuse?: string
  /** A host whose schema carries no delegation category, so its page can't be read. */
  noDelegation?: boolean
  /** A host whose delegation section points at an endpoint written by hand. */
  customDelegation?: boolean
  /** How many of its General settings reads this host refuses before it answers with the block. */
  generalRefusals?: number
  /** A host whose schema carries no General block, so its page reads as an answer without one. */
  noGeneral?: boolean
} = {}) {
  const calls: Sent[] = []
  const refuseGeneral = refuseFirst(
    generalRefusals,
    "This bot's config.yaml can't be read right now.",
  )
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = (init?.method ?? "GET").toUpperCase()
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ method, path: url.pathname, body })
    if (url.pathname.endsWith("/plugins/gots/info"))
      return away
        ? json({ error: { message: "Not home." } }, 503)
        : json({ name: "gots", version, features })
    if (url.pathname.endsWith("/plugins/gots/general")) {
      const refusal = refuseGeneral()
      if (refusal) return refusal
      return json(noGeneral ? {} : { general: HOST_GENERAL })
    }
    if (url.pathname.endsWith("/plugins/gots/delegation-settings"))
      return noDelegation
        ? json({ error: { message: "No delegation category." } }, 501)
        : json({ object: "gots.delegation_settings", delegation: DELEGATION })
    if (url.pathname.endsWith("/plugins/gots/delegation"))
      return json({
        delegation: body ? body.delegation : null,
        ...(customDelegation && !body ? { custom: true } : {}),
      })
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
    if (url.pathname.endsWith("/plugins/gots/reminders")) {
      // A host older than the four names refuses one it doesn't hold, in its own words (ADR 0068).
      if (refuse && body?.level === refuse)
        return json({ error: { message: `level must be one of off, normal, frequent` } }, 400)
      return json({ object: "gots.progress_reminders", level: body?.level ?? level })
    }
    return json({})
  }
  return { calls, fetch: fetch as unknown as typeof globalThis.fetch }
}

/**
 * A bot of this test's own: what a connection's plugin answered is remembered for the page, so each
 * test names its own host and no answer leaks into the next.
 */
async function seed(
  name: string,
  patch = {},
  features: string[] = FEATURES,
  options: Parameters<typeof host>[0] = {},
) {
  await seedSettings()
  await db.profiles.clear()
  await db.profiles.put(botProfile(name, patch))
  const server = host({ ...options, features })
  globalThis.fetch = server.fetch
  return server.calls
}

/** What a user reads on an element, with its spacing flattened. */
const page = () => find("[data-general-page]")
/** Where a string sits on the page, for asking what comes before what. */
const at = (needle: string) => wordsOf(page()).indexOf(needle)
/** Any heading the page still draws: the captions replaced them. */
const headings = () =>
  findAll("[data-general-page] h1, [data-general-page] h2, [data-general-page] h3").map((one) =>
    one.textContent?.trim(),
  )
/** A caption: the muted line standing over a card of its own. */
const caption = (title: string) =>
  findAll("[data-general-page] p").find((one) => one.textContent?.trim() === title) ?? null
/** The card a caption names: what follows it. */
const card = (title: string) => caption(title)?.nextElementSibling ?? null
/** The rows of a card, in the order it draws them. */
const rowsIn = (title: string) =>
  [...(card(title)?.querySelectorAll("[data-setting]") ?? [])].map((one) =>
    one.getAttribute("data-setting"),
  )
/** A setting's row, and what a user reads on it. */
const row = (id: string) => find(`[data-setting="${id}"]`)
const rowText = (id: string) => wordsOf(row(id))
/** The value a row holds, in the accent colour. */
const accent = (id: string) => row(id)?.querySelector(".text-primary")?.textContent ?? null
/** A button the page draws, by the words on it. */
const button = (label: string) =>
  findAll("[data-general-page] button").find((one) => wordsOf(one) === label) ?? null

/** The bottom sheet a pick opens on a phone: its list of buttons, and the choices it offers. */
const sheet = (label: string) => find(`[data-pick-list="${label}"]`)
const choices = (label: string) => findAll(`[data-pick-list="${label}"] li > button`)
const choice = (label: string, name: string) =>
  choices(label).find((one) => wordsOf(one) === name) ?? null
/** A model a model pick offers, in the sheet it opened. */
const modelOption = (name: string) =>
  findAll("[role=radio]").find((one) => wordsOf(one) === name) ?? null
/** Opens a setting's pick, and waits for the sheet it opens. */
async function openPick(id: string) {
  await click(row(id))
  await until(
    async () => Boolean(find("[data-pick-list]")) || Boolean(find("[role=radiogroup]")),
    "the pick's sheet",
  )
}

test("General is the bot's own switches, then Bot Profile over its card, then its Hermes", async () => {
  await seed("general-old-groups", { hostId: "host-1" }, [...FEATURES, "progress_reminders"])
  await mount(general(), async () => {
    assert.deepEqual(headings(), [], "no headings: the captions name the cards")

    assert.equal(
      wordsOf(findAll("[data-general-page] > div > p")[0] ?? null),
      "Bot",
      "the bot's own rows lead, under the caption Bot",
    )
    const switches = wordsOf(findAll("[data-bot-card] [data-settings-group]")[0] ?? null)
    assert.match(switches, /Enabled/, "the bot's own switch sits on top, in a card of its own")
    assert.match(switches, /Mute notifications/)
    assert.match(
      switches,
      /Plugin/,
      "and the plugin its host runs, at the foot of the card under them",
    )
    assert.doesNotMatch(switches, /Name|Image/, "and nothing of the profile block")

    assert.equal(
      caption("Bot Profile")?.textContent?.trim(),
      "Bot Profile",
      "the profile's caption",
    )
    assert.deepEqual(
      rowsIn("Bot Profile"),
      ["name", "image", "reminders"],
      "what the bot is called, how it looks, and how often it says what it is doing",
    )
    assert.ok(
      !caption("Hermes"),
      "a linked bot's server is the host's, and the subagent model is on the Delegation page",
    )
    assert.ok(
      !caption("Gots Specific Settings"),
      "and no caption over the switches, which are the bot's own",
    )

    const order = [
      "Enabled",
      "Mute notifications",
      "Plugin",
      "Bot Profile",
      "Name",
      "Image",
    ]
    assert.ok(
      order.every((one) => at(one) >= 0),
      "every one of them is drawn",
    )
    assert.deepEqual(
      [...order].sort((a, b) => at(a) - at(b)),
      order,
      "drawn in that order, top to bottom",
    )
  })
})

test("every setting is a title over the line saying what it is for, and the value it holds", async () => {
  await seed("general-values", { botId: "tri" })
  await mount(general(), async () => {
    assert.equal(rowText("name"), "NameA bot", "Name is the bot's own name, with no line under it")
    assert.equal(accent("name"), "A bot", "and its value sits in the accent colour")

    assert.equal(rowText("image"), "ImageTri", "Image is the character the bot wears")
    assert.equal(accent("image"), "Tri")

    const mute =
      findAll("[data-general-page] label").find((one) =>
        wordsOf(one).includes("Mute notifications"),
      ) ?? null
    assert.equal(
      wordsOf(mute),
      "Mute notificationsEvery push from this bot, on every device",
      "Mute says what it mutes",
    )
    const enabled = findAll("[data-general-page] label").find((one) =>
      wordsOf(one).includes("Enabled"),
    )
    assert.ok(!enabled, "an unlinked bot has no registry switch to draw")

    await until(() => rowText("plugin") === "Plugin0.81.0", "the plugin's own answer")
    assert.equal(accent("plugin"), "0.81.0", "Plugin holds the version the bot's host runs")
    absent('[data-setting="subagent-model"]', "the subagent model is not on the bot's page")
    assert.ok(
      rowText("server-key").startsWith("Server keyThe key this app sends to that server"),
      "Server key says what the key is for",
    )
    assert.ok(
      rowText("base-url").startsWith("API base URLWhere this bot's Hermes server is"),
      "and the address says what it is for too",
    )
  })
})

test("a setting that holds nothing says Not set, muted, and no card holds a text box", async () => {
  await seed("general-empty", { apiKey: "" })
  await mount(general(), async () => {
    assert.equal(
      rowText("server-key"),
      "Server keyThe key this app sends to that serverNot set",
      "a bot with no key says so",
    )
    assert.equal(accent("server-key"), null, "and the words are not in the accent colour")
    assert.equal(rowText("image"), "ImageNot set", "a bot wearing no character says so too")
    absent('[data-general-page] input:not([type="checkbox"])', "no card holds a text box")
    absent("[data-general-page] textarea", "and nothing else on the page is typed into")
  })
})

test("an unlinked bot is asked for its Hermes's address and key, and a linked one is not", async () => {
  await seed("general-unlinked", {}, [])
  await mount(general(), async () => {
    assert.ok(row("base-url"), "an unlinked bot's own address")
    assert.ok(row("server-key"), "and its own key")
    absent("#enabled", "with no registry flag to set")
    absent(
      '[data-setting="subagent-model"]',
      "and a host advertising no subagent model leaves no row",
    )
  })

  await seed("general-linked", { hostId: "host-1" }, [])
  await mount(general(), async () => {
    absent('[data-setting="base-url"]', "the host knows its address")
    absent('[data-setting="server-key"]', "and holds the key")
    assert.ok(find("#enabled"), "while the bot can still be switched on and off")
    assert.ok(!caption("Hermes"), "a linked bot has no Hermes card at all")
    assert.ok(caption("Bot Profile"), "and the rest of General is still there")
  })
})

test("the Hermes card is the unlinked bot's own address and key, and a linked bot has none", async () => {
  await seed("general-delegation", { hostId: "host-1" })
  await mount(general(), async () => {
    assert.ok(!caption("Hermes"), "a linked bot has no row for one, with or without the feature")
  })

  await seed("general-address", {}, [])
  await mount(general(), async () => {
    assert.ok(caption("Hermes"), "an unlinked bot's own address and key keep the caption")
    assert.deepEqual(rowsIn("Hermes"), ["base-url", "server-key"])
  })
})

test("a disabled bot still reads as hidden in Gots", async () => {
  await seed("general-disabled", { hostId: "host-1", disabled: true })
  await mount(general(), async () => {
    const enabled = findAll("[data-general-page] label").find((one) =>
      wordsOf(one).includes("Enabled"),
    )
    assert.match(
      wordsOf(enabled ?? null),
      /^EnabledHidden in Gots/,
      "Enabled says the bot is hidden rather than when it was seen",
    )
  })
})

test("the Name row opens the Name edit, and Save writes the bot's name", async () => {
  await seed("general-name-edit")
  await mount(general(), async () => {
    await click(row("name"))
    assert.equal(path(), "/settings/bots/bot-1/bot/name", "the edit has an address of its own")
    assert.doesNotMatch(wordsOf(page()), /Mute notifications/, "and the page under it is not drawn")

    const field = find("#edit-name") as HTMLInputElement | null
    assert.ok(field, "a labelled field holding the current value")
    assert.equal(field?.value, "A bot", "which is the bot's name")
    assert.equal(
      wordsOf(find("[data-general-page] label")),
      "Name",
      "and the field names what is edited",
    )
    assert.equal(
      (button("Save") as HTMLButtonElement | null)?.disabled,
      true,
      "and nothing is saved until the value moves",
    )

    await type(field, "Renamed")
    await click(button("Save"))
    assert.equal(
      (await db.profiles.get("bot-1"))?.name,
      "Renamed",
      "the write lands on the profile",
    )
    assert.equal(path(), "/settings/bots/bot-1", "and the page comes back")
    assert.equal(accent("name"), "Renamed", "showing the name the bot now holds")
  })
})

test("Cancel writes nothing at all, and returns to the page", async () => {
  await seed("general-name-cancel")
  await mount(general(), async () => {
    await click(row("name"))
    await type(find("#edit-name"), "Typed and abandoned")
    await click(button("Cancel"))
    assert.equal((await db.profiles.get("bot-1"))?.name, "A bot", "the profile is untouched")
    assert.equal(path(), "/settings/bots/bot-1", "and the page is back")
  })
})

test("the Server key's edit masks the key, and Save waits for a change", async () => {
  await seed("general-key-edit")
  await mount(general("/settings/bots/bot-1/bot/server-key"), async () => {
    const field = find("#edit-server-key") as HTMLInputElement | null
    assert.ok(field, "the key's own field")
    assert.equal(field?.getAttribute("type"), "password", "the key is masked while it is typed")
    assert.ok(find('[aria-label="Show key"]'), "with the way to show it")
    assert.equal(
      (button("Save") as HTMLButtonElement | null)?.disabled,
      true,
      "and nothing to save until it moves",
    )

    await click(find('[aria-label="Show key"]'))
    assert.equal(find("#edit-server-key")?.getAttribute("type"), "text", "the toggle shows the key")
    assert.ok(find('[aria-label="Hide key"]'), "and offers to hide it again")

    await type(find("#edit-server-key"), "new-key")
    assert.equal(
      (button("Save") as HTMLButtonElement | null)?.disabled,
      false,
      "a change can be saved",
    )
    await click(button("Save"))
    assert.equal((await db.profiles.get("bot-1"))?.apiKey, "new-key", "and the write lands")
    assert.equal(path(), "/settings/bots/bot-1", "back on the page")
  })
})

test("the Image row opens the bot characters as a sheet, and a pick is written", async () => {
  await seed("general-image-pick")
  await mount(general(), async () => {
    await openPick("image")
    assert.ok(sheet("Image"), "the sheet's radio list is named for the setting it fills")
    assert.ok(choices("Image").length > 1, "with one row per character")
    assert.ok(choice("Image", "Cubby"), "each by the name it is called")

    await click(choice("Image", "Cubby"))
    assert.equal((await db.profiles.get("bot-1"))?.botId, "cubby", "the pick lands on the bot")
    await until(async () => !sheet("Image"), "the sheet to close behind the pick")
    assert.equal(accent("image"), "Cubby", "and the row shows the character it now wears")
  })
})

test("a host that refuses the Delegation page says so, and draws no Subagent row", async () => {
  await seed("general-no-delegation", { hostId: "host-1" }, [...FEATURES, "delegation_page"], {
    noDelegation: true,
  })
  await mount(general("/settings/bots/bot-1/delegation"), async () => {
    await until(async () => Boolean(find('[role="alert"]')), "the refusal to be said")
    assert.equal(find('[role="alert"]')?.textContent, "No delegation category.")
    absent('[data-setting="subagent-model"]', "and no row is drawn over a page that can't be read")
  })
})

/**
 * A bot switched to on one connection: both answer at one address and key, so the page is the same
 * instance across the swap. Keyed by the bot it draws, it starts that bot's own read and waits, so
 * neither the refusal nor the row of the bot before it stands over the page (#992).
 */
test("a bot switched to on one connection draws nothing of the bot before it", async () => {
  await seedSettings()
  await db.profiles.clear()
  const address = "http://one.test/v1"
  const first = botProfile("A bot", { id: "bot-1", baseUrl: address, apiKey: "key" })
  const second = botProfile("B bot", { id: "bot-2", baseUrl: address, apiKey: "key" })
  await db.profiles.bulkPut([first, second])

  // The first bot's page cannot be read; the second's answer is still on its way when the page is
  // asked what it draws, which is the moment the bot before it would show.
  const refuseDelegation = refuseFirst(1, "No delegation category.", 501)
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith("/plugins/gots/info"))
      return json({ name: "gots", version: "0.81.0", features: [...FEATURES, "delegation_page"] })
    if (url.pathname.endsWith("/plugins/gots/delegation-settings")) {
      const refusal = refuseDelegation()
      if (refusal) return refusal
      await new Promise((resolve) => setTimeout(resolve, 100))
      return json({ object: "gots.delegation_settings", delegation: DELEGATION })
    }
    return json({})
  }) as unknown as typeof globalThis.fetch

  /** The page, with the bot beneath it swapped the way the route's own param swaps it. */
  function Switched() {
    const [profile, setProfile] = useState(first)
    return (
      <>
        <button type="button" onClick={() => setProfile(second)}>
          To B
        </button>
        <BotSettingsPage profile={profile} tab="delegation" />
      </>
    )
  }

  await mount(
    <MemoryRouter initialEntries={["/settings/bots/bot-1/delegation"]}>
      <Switched />
    </MemoryRouter>,
    async () => {
      await until(async () => Boolean(find('[role="alert"]')), "the first bot's refusal")
      assert.equal(find('[role="alert"]')?.textContent, "No delegation category.")

      await click(findAll("button").find((one) => wordsOf(one) === "To B") ?? null)
      assert.equal(
        find('[role="alert"]')?.textContent ?? null,
        null,
        "the refusal of the bot before it is not on the page",
      )
      absent(
        '[data-setting="subagent-model"]',
        "and neither is the row it would have drawn, before the answer lands",
      )
    },
  )
})

test("a delegation section pointing at a hand-written endpoint reads Custom", async () => {
  await seed("general-custom-delegation", { hostId: "host-1" }, [...FEATURES, "delegation_page"], {
    customDelegation: true,
  })
  await mount(general("/settings/bots/bot-1/delegation"), async () => {
    await until(async () => Boolean(row("subagent-model")), "the Delegation page's first row")
    assert.equal(accent("subagent-model"), "Custom", "an endpoint the host runs on says Custom")
  })
})

test("the Delegation page's Subagent model row opens the host's models, and a pick is written to the host", async () => {
  const calls = await seed("general-subagent-pick", { hostId: "host-1" }, [
    ...FEATURES,
    "delegation_page",
  ])
  await mount(general("/settings/bots/bot-1/delegation"), async () => {
    await until(async () => Boolean(row("subagent-model")), "the Delegation page's first row")
    assert.deepEqual(
      [...(find("[data-bot-delegation]")?.querySelectorAll("[data-setting]") ?? [])].map((one) =>
        one.getAttribute("data-setting"),
      ),
      ["subagent-model", ...DELEGATION.fields.map((field) => field.key)],
      "the model leads, then the host's own keys, with no caption between",
    )
    assert.equal(accent("subagent-model"), "Default model", "nothing set says Default model")

    await openPick("subagent-model")
    assert.ok(modelOption("cheap-model"), "the host's models, in a sheet")
    await click(modelOption("cheap-model"))

    const write = calls.find(
      (one) => one.method === "POST" && one.path.endsWith("/plugins/gots/delegation"),
    )
    assert.deepEqual(
      write?.body,
      { delegation: { provider: "openrouter", model: "cheap-model" } },
      "the pick is the delegation model the host is sent",
    )
    assert.equal(
      accent("subagent-model"),
      "openrouter/cheap-model",
      "and the row shows what the host now holds",
    )
  })
})

test("a read the host refused says so, with a way to ask again, and the tap draws the page", async () => {
  const calls = await seed(
    "general-refused-once",
    { hostId: "host-1" },
    [...FEATURES, "general_page"],
    { generalRefusals: 1 },
  )
  const reads = () => calls.filter((one) => one.path.endsWith("/plugins/gots/general"))

  await mount(general("/settings/bots/bot-1/general"), async () => {
    const notice = '[data-bot-general] [role="alert"]'
    await until(async () => Boolean(find(notice)), "the refusal to be said")
    assert.match(
      wordsOf(find(notice)),
      /config\.yaml can't be read right now/,
      "the notice holds the host's own sentence",
    )

    const retry = labelled(`${notice} button`, "Try again")
    assert.ok(retry, "and one control offering to ask the same read again")
    assert.equal(
      retry.getAttribute("title"),
      "Try again",
      "an icon, so the words it is named are what a reader hears",
    )
    assert.equal(wordsOf(retry), "", "and no label is drawn beside it")
    assert.equal(reads().length, 1, "the page asked its General settings once, and was refused")

    await click(retry)
    await until(async () => Boolean(row("timezone")), "the page's rows")

    assert.deepEqual(
      reads().map((one) => one.method),
      ["GET", "GET"],
      "the tap asked the same route again, once",
    )
    absent(notice, "the notice goes with it")
    assert.equal(accent("timezone"), "Europe/London", "and the rows draw what the host holds")
  })
})

test("a host that answers without its General block says so, and offers no retry", async () => {
  await seed("general-no-block", { hostId: "host-1" }, [...FEATURES, "general_page"], {
    noGeneral: true,
  })
  await mount(general("/settings/bots/bot-1/general"), async () => {
    const notice = '[data-bot-general] [role="alert"]'
    await until(async () => Boolean(find(notice)), "the answer")
    assert.equal(
      wordsOf(find(notice)),
      "This host doesn't carry its General settings.",
      "the notice says what the host answered",
    )
    absent(`${notice} button`, "and no control asks again a question the host already answered")
  })
})

test("the bot's own page names the plugin its host runs, and asks nothing else about its connection", async () => {
  const calls = await seed(
    "plugin-named",
    { hostId: "host-1", pluginVersion: "0.120.0" },
    FEATURES,
    { version: "0.81.0" },
  )
  await mount(general(), async () => {
    await until(() => rowText("plugin") === "Plugin0.81.0", "the plugin's answer")
    assert.equal(accent("plugin"), "0.81.0", "the row holds the version the host runs")

    await until(
      async () => (await db.profiles.get("bot-1"))?.pluginVersion === "0.81.0",
      "the stored version to follow the host's answer",
    )
    await until(
      () => /out of date/.test(wordsOf(page())),
      "the banner to follow the version it reads",
    )

    // The claim is about what the page asks, not how many times a mount runs it: the app mounts its
    // effects twice in development, and the harness does not.
    const info = calls.filter((one) => one.path.endsWith("/plugins/gots/info"))
    assert.ok(info.length >= 1, "opening the page asked its plugin's info")
    assert.deepEqual(
      calls.filter((one) => one.path.endsWith("/health")),
      [],
      "and asked nothing about its connection",
    )
    assert.deepEqual(
      calls.filter((one) => one.path.endsWith("/models")),
      [],
      "nor for its models",
    )
  })
})

test("a host that answers without a plugin says No plugin, and nothing is written", async () => {
  await seed(
    "plugin-absent",
    { hostId: "host-1", pluginVersion: "0.1.0" },
    FEATURES,
    { version: null },
  )
  await mount(general(), async () => {
    await until(() => rowText("plugin") === "PluginNo plugin", "the host's answer")
    assert.equal(accent("plugin"), null, "an absence reads muted rather than as a value")
    // The host said it runs no plugin, so the version this device stored is gone: the banner that
    // read it cannot keep calling a bot out of date on an answer that says otherwise.
    await until(
      async () => (await db.profiles.get("bot-1"))?.pluginVersion === undefined,
      "the stored version to go with the plugin it named",
    )
    await until(() => !/out of date/.test(wordsOf(page())), "and its banner to go with it")
  })
})

test("a plugin answer still owed draws no value line at all", async () => {
  await seed("plugin-owed", { hostId: "host-1" }, FEATURES, { away: true })
  await mount(general(), async () => {
    assert.equal(rowText("plugin"), "Plugin", "the row names the plugin and holds nothing yet")
    assert.equal(
      row("plugin")?.querySelector(".text-primary") ?? null,
      null,
      "with no value line to read",
    )
  })
})

test("an address into a page this bot doesn't have draws no edit of it, and writes no key", async () => {
  const calls = await seed("general-foreign-sub", {}, FEATURES, { away: true })
  const before = await db.profiles.get("bot-1")
  await mount(general("/settings/bots/bot-1/speech-to-text/vocabulary"), async () => {
    assert.equal(
      path(),
      "/settings/bots/bot-1/speech-to-text/vocabulary",
      "the address it was asked for stands",
    )
    assert.match(wordsOf(page()), /Bot Profile/, "the bot's own page is what is drawn")
    absent("[data-vocabulary]", "and the page it names is not drawn")
    absent(
      '[data-general-page] input:not([type="checkbox"])',
      "nothing on the screen is typed into",
    )
    assert.equal(
      (await db.profiles.get("bot-1"))?.apiKey,
      before?.apiKey,
      "the server key is untouched",
    )
    assert.deepEqual(
      calls.filter((one) => one.method !== "GET"),
      [],
      "and nothing was sent anywhere",
    )
  })
})

test("the reminders row is chosen where it sits, and shows no count", async () => {
  const calls = await seed("general-reminders", { hostId: "host-1" }, [
    ...FEATURES,
    "progress_reminders",
  ])
  await mount(general(), async () => {
    await until(() => Boolean(row("reminders")), "the reminders row")
    assert.match(rowText("reminders"), /Progress updates/, "the row names what the setting is for")
    assert.match(
      rowText("reminders"),
      /How much it says is still the bot's call/,
      "and says what the levels do not promise",
    )
    const pills = findAll('[data-setting="reminders"] [role="radio"]')
    assert.deepEqual(
      pills.map((one) => wordsOf(one)),
      ["Off", "Quiet", "Normal", "Chatty"],
      "four words, and no numbers",
    )
    assert.doesNotMatch(rowText("reminders"), /\d/, "the counts behind them stay on the host")

    const chosen = () =>
      findAll('[data-setting="reminders"] [aria-checked="true"]').map((one) => wordsOf(one))
    assert.deepEqual(chosen(), ["Normal"], "the level the host answered is the one that reads on")

    const chatty = pills.find((one) => wordsOf(one) === "Chatty")
    assert.ok(chatty, "Chatty is a pill the row draws")
    await click(chatty)
    await until(
      () => calls.some((one) => one.method === "POST" && one.path.endsWith("/reminders")),
      "the level's write",
    )
    assert.deepEqual(
      calls.find((one) => one.method === "POST" && one.path.endsWith("/reminders"))?.body,
      { level: "chatty" },
      "choosing a pill writes that level, and the counts stay the host's",
    )
    await until(() => chosen()[0] === "Chatty", "the level the host answered back")
  })
})

test("an older host's stored level reads as the level this app draws for it", async () => {
  await seed(
    "general-legacy-reminders",
    { hostId: "host-1" },
    [...FEATURES, "progress_reminders"],
    {
      level: "frequent",
    },
  )
  await mount(general(), async () => {
    await until(() => Boolean(row("reminders")), "the reminders row")
    const chosen = () =>
      findAll('[data-setting="reminders"] [aria-checked="true"]').map((one) => wordsOf(one))
    assert.deepEqual(chosen(), ["Chatty"], "the old name draws as the level it behaves as")
  })
})

test("a level the host refuses says so, and the row keeps what the host holds", async () => {
  const said: unknown[] = []
  const real = toast.error
  toast.error = ((message: unknown) => {
    said.push(message)
    return ""
  }) as typeof toast.error
  try {
    const calls = await seed(
      "general-refused-reminder",
      { hostId: "host-1" },
      [...FEATURES, "progress_reminders"],
      { refuse: "quiet" },
    )
    await mount(general(), async () => {
      await until(() => Boolean(row("reminders")), "the reminders row")
      const quiet = findAll('[data-setting="reminders"] [role="radio"]').find(
        (one) => wordsOf(one) === "Quiet",
      )
      assert.ok(quiet, "the four names are offered whatever the host holds")
      await click(quiet)
      await until(
        () => calls.some((one) => one.method === "POST" && one.path.endsWith("/reminders")),
        "the level's write",
      )
      await until(() => said.length > 0, "the host's refusal")
      assert.match(String(said[0]), /level must be one of/, "the host's words reach the user")
      const chosen = () =>
        findAll('[data-setting="reminders"] [aria-checked="true"]').map((one) => wordsOf(one))
      assert.deepEqual(chosen(), ["Normal"], "and the row still draws the level the host holds")
    })
  } finally {
    toast.error = real
  }
})

test("a plugin that doesn't advertise reminders draws no row", async () => {
  await seed("general-no-reminders", { hostId: "host-1" })
  await mount(general(), async () => {
    assert.ok(
      missing('[data-setting="reminders"]'),
      "no row to set a setting this host doesn't have",
    )
    assert.doesNotMatch(wordsOf(page()), /Progress updates/)
  })
})
