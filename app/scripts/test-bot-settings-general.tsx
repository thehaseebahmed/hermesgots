/**
 * A bot's General page, over a seeded device database and a faked host (ADR 0055): no headings at
 * all, the muted captions "Bot Profile" and "Hermes" over the cards that follow them, every setting a
 * title over the line saying what it is for and the value it holds in the accent colour — "Not set"
 * where it holds nothing — a value's tap opening its edit as a pushed screen and its pick as a bottom
 * sheet, and the write each lands at the fetch boundary.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { useLiveQuery } from "dexie-react-hooks"
import { MemoryRouter, Route, Routes, useParams } from "react-router"

import { BotSettingsPage } from "@/components/bot-settings"
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
  laptop,
  mount,
  path,
  seedSettings,
  type,
  until,
} from "./component-kit.tsx"

/** General draws the host's Subagent model only where its plugin advertises the override. */
const FEATURES = ["delegation_model"]

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

const general = (entry = "/settings/bots/bot-1/general") => (
  <MemoryRouter initialEntries={[entry]}>
    <Path />
    <Routes>
      <Route path="/settings/bots/:botId/:tab?/:sub?" element={<LivePage />} />
    </Routes>
  </MemoryRouter>
)

type Sent = { method: string; path: string; body: Record<string, unknown> | null }

/**
 * A host answering the plugin's `info` (its features and version), the delegation route, its models
 * and the health check a connection test makes, and recording every request it was sent.
 */
function host({
  features = FEATURES,
  version = "0.81.0" as string | null,
  models = ["own-model", "cheap-model"],
  health,
  away = false,
}: {
  features?: string[]
  version?: string | null
  models?: string[]
  /** What the health check refuses with, where the test is of a host that isn't well. */
  health?: string
  /** A host that hasn't answered at all: no feature list, so no page has a gate to read. */
  away?: boolean
} = {}) {
  const calls: Sent[] = []
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = (init?.method ?? "GET").toUpperCase()
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ method, path: url.pathname, body })
    if (url.pathname.endsWith("/plugins/memento/info"))
      return away
        ? json({ error: { message: "Not home." } }, 503)
        : json({ name: "memento", version, features })
    if (url.pathname.endsWith("/plugins/memento/delegation"))
      return json({ delegation: body ? body.delegation : null })
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
    if (url.pathname.endsWith("/plugins/memento/reminders"))
      return json({ object: "memento.progress_reminders", level: body?.level ?? "normal", levels: ["off", "normal", "frequent"] })
    if (url.pathname.endsWith("/health"))
      return health ? json({ error: { message: health } }, 500) : json({ ok: true })
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
const words = (element: Element | null) => (element?.textContent ?? "").replace(/\s+/g, " ").trim()
/** Where a string sits on the page, for asking what comes before what. */
const at = (needle: string) => words(page()).indexOf(needle)
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
const rowText = (id: string) => words(row(id))
/** The value a row holds, in the accent colour. */
const accent = (id: string) => row(id)?.querySelector(".text-primary")?.textContent ?? null
/** A button the page draws, by the words on it. */
const button = (label: string) =>
  findAll("[data-general-page] button").find((one) => words(one) === label) ?? null
const testButton = () => find('[aria-label="Test connection"]')

/** The bottom sheet a pick opens on a phone: its list of buttons, and the choices it offers. */
const sheet = (label: string) => find(`[data-pick-list="${label}"]`)
const choices = (label: string) => findAll(`[data-pick-list="${label}"] > button`)
const choice = (label: string, name: string) =>
  choices(label).find((one) => words(one) === name) ?? null
/** A model a model pick offers, in the sheet it opened. */
const modelOption = (name: string) =>
  findAll("[aria-pressed]").find((one) => words(one) === name) ?? null
/** Opens a setting's pick, and waits for the sheet it opens. */
async function openPick(id: string) {
  await click(row(id))
  await until(
    async () => Boolean(find("[data-pick-list]")) || Boolean(find("[aria-pressed]")),
    "the pick's sheet",
  )
}

test("General is the bot's own switches, then Bot Profile over its card, then its Hermes", async () => {
  await seed("general-groups", { hostId: "host-1" })
  await mount(general(), async () => {
    assert.deepEqual(headings(), [], "no headings: the captions name the cards")

    const switches = words(page()?.children[0] ?? null)
    assert.match(switches, /Enabled/, "the bot's own switch sits on top, in a card of its own")
    assert.match(switches, /Mute notifications/)
    assert.doesNotMatch(switches, /Name|Image/, "and nothing of the profile block")

    assert.equal(
      caption("Bot Profile")?.textContent?.trim(),
      "Bot Profile",
      "the profile's caption",
    )
    assert.deepEqual(
      rowsIn("Bot Profile"),
      ["name", "image", "test"],
      "what the bot is called, how it looks, and how it connects",
    )
    assert.equal(caption("Hermes")?.textContent?.trim(), "Hermes", "then its Hermes's caption")
    assert.deepEqual(
      rowsIn("Hermes"),
      ["subagent-model"],
      "a linked bot has only the model every subagent runs on",
    )
    assert.ok(
      !caption("Gots Specific Settings"),
      "and no caption over the switches, which are the bot's own",
    )

    const order = [
      "Enabled",
      "Mute notifications",
      "Bot Profile",
      "Name",
      "Image",
      "Test connection",
      "Hermes",
      "Subagent model",
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
        words(one).includes("Mute notifications"),
      ) ?? null
    assert.equal(
      words(mute),
      "Mute notificationsEvery push from this bot, on every device",
      "Mute says what it mutes",
    )
    const enabled = findAll("[data-general-page] label").find((one) =>
      words(one).includes("Enabled"),
    )
    assert.ok(!enabled, "an unlinked bot has no registry switch to draw")

    assert.ok(
      rowText("test").startsWith("Test connectionAsk this bot's server how it is"),
      "Test connection says what the button does",
    )
    assert.ok(
      rowText("subagent-model").startsWith("Subagent modelThe model every subagent runs on"),
      "Subagent model says which model it picks",
    )
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
    assert.ok(!caption("Hermes"), "a Hermes card with no row draws no caption at all")
    assert.ok(caption("Bot Profile"), "and the rest of General is still there")
  })
})

test("the Hermes card is there once it has a row, linked or not", async () => {
  await seed("general-delegation", { hostId: "host-1" })
  await mount(general(), async () => {
    assert.ok(caption("Hermes"), "the delegation row earns its caption")
    assert.deepEqual(rowsIn("Hermes"), ["subagent-model"], "and the row it holds")
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
      words(one).includes("Enabled"),
    )
    assert.match(
      words(enabled ?? null),
      /^EnabledHidden in Gots/,
      "Enabled says the bot is hidden rather than when it was seen",
    )
  })
})

test("the Name row opens the Name edit, and Save writes the bot's name", async () => {
  await seed("general-name-edit")
  await mount(general(), async () => {
    await click(row("name"))
    assert.equal(path(), "/settings/bots/bot-1/general/name", "the edit has an address of its own")
    assert.doesNotMatch(words(page()), /Mute notifications/, "and the page under it is not drawn")

    const field = find("#edit-name") as HTMLInputElement | null
    assert.ok(field, "a labelled field holding the current value")
    assert.equal(field?.value, "A bot", "which is the bot's name")
    assert.equal(words(find("[data-general-page] label")), "Name", "the label names what is edited")
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
    assert.equal(path(), "/settings/bots/bot-1/general", "and the page comes back")
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
    assert.equal(path(), "/settings/bots/bot-1/general", "and the page is back")
  })
})

test("the Server key's edit masks the key, and Save waits for a change", async () => {
  await seed("general-key-edit")
  await mount(general("/settings/bots/bot-1/general/server-key"), async () => {
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
    assert.equal(path(), "/settings/bots/bot-1/general", "back on the page")
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

test("the Subagent model row opens the host's models, and a pick is written to the host", async () => {
  const calls = await seed("general-subagent-pick", { hostId: "host-1" })
  await mount(general(), async () => {
    assert.equal(accent("subagent-model"), "Default model", "nothing set says Default model")

    await openPick("subagent-model")
    assert.ok(modelOption("cheap-model"), "the host's models, in a sheet")
    await click(modelOption("cheap-model"))

    const write = calls.find(
      (one) => one.method === "POST" && one.path.endsWith("/plugins/memento/delegation"),
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

test("Test connection answers Connected, with the plugin version the host runs", async () => {
  await seed("general-test-ok")
  await mount(general(), async () => {
    await click(testButton())
    await until(async () => words(page()).includes("Connected"), "the test's answer")
    const answer = find('[data-setting="test"] [role="status"]')
    assert.equal(
      words(answer),
      "Connected · Plugin 0.81.0",
      "the row's answer line says it connected and names the plugin the host runs",
    )
    assert.match(answer?.className ?? "", /text-primary/, "in the accent colour, as a value is")
    absent('[data-setting="test"] [role="alert"]', "and nothing is raised")
  })

  await seed("general-test-bare", {}, FEATURES, { version: null })
  await mount(general(), async () => {
    await click(testButton())
    await until(async () => words(page()).includes("Connected"), "the test's answer")
    assert.equal(
      words(find('[data-setting="test"] [role="status"]')),
      "Connected · No plugin",
      "a host without the plugin says so in the same place",
    )
  })
})

test("a test the host refuses shows its own sentence in the row's alert", async () => {
  await seed("general-test-fail", {}, FEATURES, { health: "Hermes is restarting." })
  await mount(general(), async () => {
    await click(testButton())
    await until(async () => Boolean(find('[role="alert"]')), "the host's refusal")
    const alert = find('[role="alert"]')
    assert.equal(words(alert), "Hermes is restarting.", "in the host's own words")
    assert.match(alert?.className ?? "", /text-destructive/, "in red, as a refusal is")
    assert.equal(
      words(row("test")).match(/Hermes is restarting\./g)?.length ?? 0,
      1,
      "the row's value carries the sentence, once",
    )
    assert.doesNotMatch(words(row("test")), /Connected/, "and nothing claims it connected")
  })
})

test(
  "a test's answer belongs to the connection it tested, and reads idle once that changes",
  laptop(async () => {
    await seed("general-test-stale")
    await mount(general(), async () => {
      await click(testButton())
      await until(async () => words(page()).includes("Connected"), "the test's answer")
      // The answer's own writes land after it: the page is read again, and its rows come back.
      await until(async () => Boolean(row("base-url")), "the page's rows")

      // The edit rides over the page at this width, so the page that holds the answer stays mounted.
      await click(row("base-url"))
      const field = find("#edit-api-base-url") as HTMLInputElement | null
      assert.ok(field, "the address's edit")
      await type(field, "http://elsewhere.test/v1")
      // The card is a dialog, drawn in a portal: its Save is not inside the page's own subtree.
      await click(findAll("button").find((one) => words(one) === "Save") ?? null)
      await until(
        async () => (await db.profiles.get("bot-1"))?.baseUrl === "http://elsewhere.test/v1",
        "the new address to land",
      )

      assert.doesNotMatch(
        words(row("test")),
        /Connected/,
        "the row claims nothing about a server it never reached",
      )
      absent('[data-setting="test"] [role="status"]', "and no answer is left standing over it")
    })
  }),
)

test("an address into a page this bot doesn't have draws no edit of it, and writes no key", async () => {
  const calls = await seed("general-foreign-sub", {}, FEATURES, { away: true })
  const before = await db.profiles.get("bot-1")
  await mount(general("/settings/bots/bot-1/speech-to-text/vocabulary"), async () => {
    assert.equal(
      path(),
      "/settings/bots/bot-1/speech-to-text/vocabulary",
      "the address it was asked for stands",
    )
    assert.match(words(page()), /Test connection/, "General is what is drawn")
    absent("#edit-vocabulary", "and the page it names is not, so its edit has no field")
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
      pills.map((one) => words(one)),
      ["Off", "Normal", "Frequent"],
      "three words, and no numbers",
    )
    assert.doesNotMatch(rowText("reminders"), /\d/, "the counts behind them stay on the host")

    const chosen = () =>
      findAll('[data-setting="reminders"] [aria-checked="true"]').map((one) => words(one))
    assert.deepEqual(chosen(), ["Normal"], "the level the host answered is the one that reads on")

    const frequent = pills.find((one) => words(one) === "Frequent")
    assert.ok(frequent, "Frequent is a pill the row draws")
    await click(frequent)
    await until(
      () => calls.some((one) => one.method === "POST" && one.path.endsWith("/reminders")),
      "the level's write",
    )
    assert.deepEqual(
      calls.find((one) => one.method === "POST" && one.path.endsWith("/reminders"))?.body,
      { level: "frequent" },
      "choosing a pill writes that level, and the counts stay the host's",
    )
    await until(
      () => chosen()[0] === "Frequent",
      "the level the host answered back",
    )
  })
})

test("a plugin that doesn't advertise reminders draws no row", async () => {
  await seed("general-no-reminders", { hostId: "host-1" })
  await mount(general(), async () => {
    assert.equal(row("reminders"), null, "no row to set a setting this host doesn't have")
    assert.doesNotMatch(words(page()), /Progress updates/)
  })
})
