/**
 * A bot's settings as a multi-step screen (ADR 0055): three cards with no headings and no captions —
 * General alone, the Gots plugin's pages, then the bot's Hermes's — the rows in the order they are
 * drawn and the copy each carries, an icon a row and no chevron, the rows a host's features leave out
 * and the addresses that land on General instead, the segments that named pages before the list
 * landing on the pages that took their place, the out-of-date banner leading the list, a row pushing
 * its page on a phone and swapping the pane beside the list on a laptop, the header's trash named for
 * the bot it deletes, and each page still holding what its tab held — values that open their edits.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter, Route, Routes } from "react-router"

import { db } from "@/lib/db"
import { SettingsPage } from "@/routes/settings"
import {
  Path,
  absent,
  botProfile,
  click,
  find,
  findAll,
  laptop,
  mediaHost,
  mount,
  path,
  seedSettings,
  text,
} from "./component-kit.tsx"

/** Every feature the four gated pages need, so a test starts from a host that has them all. */
const ALL = ["dictation", "mcps", "afk_picks", "skills"]

const settings = (entry: string) => (
  <MemoryRouter initialEntries={[entry]}>
    <Path />
    <Routes>
      <Route path="/settings/:section?/:botId?/:tab?/:sub?" element={<SettingsPage />} />
    </Routes>
  </MemoryRouter>
)

/**
 * A bot of this test's own: what a connection's plugin answered is remembered for the page, so each
 * test names its own host and no answer leaks into the next.
 */
async function seed(name: string, features: string[] | "away", patch = {}) {
  await seedSettings()
  await db.profiles.clear()
  await db.profiles.put(botProfile(name, patch))
  mediaHost({ features })
}

const rows = () => findAll("[data-bot-page]").map((row) => row.getAttribute("data-bot-page"))
const row = (segment: string) => find(`[data-bot-page="${segment}"]`)
/** Any heading the list still draws: ADR 0055 took them all out. */
const headings = () =>
  findAll(
    "[data-bot-settings-list] h1, [data-bot-settings-list] h2, [data-bot-settings-list] h3",
  ).map((heading) => heading.textContent)
/** The cards the list draws, each with the pages it holds — General's alone, then Gots's, Hermes's. */
const cards = () =>
  findAll("[data-bot-settings-list] > div").map((card) =>
    [...card.querySelectorAll("[data-bot-page]")].map((one) => one.getAttribute("data-bot-page")),
  )
/** The icons a row wears: its page's own, and no chevron beside it. */
const iconsPerRow = () =>
  findAll("[data-bot-page]").map((one) => one.querySelectorAll("svg").length)
/** What a user reads on an element, with its spacing flattened. */
const words = (element: Element | null) => (element?.textContent ?? "").replace(/\s+/g, " ").trim()
const back = () => find('button[aria-label="Back"]')
const titles = () => findAll("h1").map((heading) => heading.textContent)

test("the list draws General alone, then every other page in the one card under it", async () => {
  await seed("list-order", ALL)
  await mount(settings("/settings/bots/bot-1"), async () => {
    assert.deepEqual(
      rows(),
      ["general", "models", "coding", "speech-to-text", "mcps", "skills"],
      "the pages in list order",
    )
    assert.deepEqual(
      cards(),
      [["general"], ["models", "coding", "speech-to-text", "mcps", "skills"]],
      "two cards separated by a gap: General on its own, then every other page together",
    )
    assert.deepEqual(headings(), [], "and no headings: a card is separated by the gap, not named")
    assert.deepEqual(
      findAll("[data-bot-page]").map((one) => one.textContent),
      [
        "GeneralEnabled, notifications, profile and your Hermes's address",
        "ModelsModel, default model, triage model and fallback providers",
        "CodingAway From Keyboard and this bot's pick budget",
        "Speech-to-textVocabulary, cleanup model and speech model",
        "MCPThe servers this bot works with",
        "SkillsThe skills this bot can use",
      ],
      "every row is its name over the line saying what it holds",
    )
    assert.deepEqual(iconsPerRow(), [1, 1, 1, 1, 1, 1], "one icon a row, and no chevron beside it")
    assert.deepEqual(
      words(find("[data-bot-settings-list]")),
      findAll("[data-bot-page]")
        .map((one) => words(one))
        .join(""),
      "and nothing else is written on the list: no captions over these cards",
    )
    assert.deepEqual(titles(), ["A bot"], "the list screen is named after the bot")
    assert.ok(
      find('header button[aria-label="Delete A bot"]'),
      "and its header carries the trash named for the bot it deletes",
    )
  })
})

/** The page each feature gates, and the row that page would have drawn. */
const GATED = [
  { feature: "mcps", segment: "mcps", name: "MCP" },
  { feature: "skills", segment: "skills", name: "Skills" },
  { feature: "afk_picks", segment: "coding", name: "Coding" },
  { feature: "dictation", segment: "speech-to-text", name: "Speech-to-text" },
] as const

for (const { feature, segment, name } of GATED) {
  test(`a host that withholds ${feature} draws no ${name} row, and its address lands on General`, async () => {
    await seed(
      `gate-${feature}`,
      ALL.filter((one) => one !== feature),
    )
    await mount(settings(`/settings/bots/bot-1/${segment}`), async () => {
      assert.equal(row(segment), null, `no ${name} row on the list`)
      assert.equal(path(), "/settings/bots/bot-1/general", "the address is General's, in place")
      assert.match(text(), /Test connection/, "and General is what is drawn")
    })
  })
}

test("a host that hasn't answered yet keeps the address, and draws General meanwhile", async () => {
  await seed("gate-unknown", "away")
  await mount(settings("/settings/bots/bot-1/mcps"), async () => {
    assert.equal(path(), "/settings/bots/bot-1/mcps", "the address it was asked for stands")
    assert.match(text(), /Test connection/, "General is what is drawn while there is no answer")
  })
})

test("the segments that named pages before the list land on the pages that took their place", async () => {
  await seed("old-chat", ALL)
  await mount(settings("/settings/bots/bot-1/chat"), async () => {
    assert.equal(path(), "/settings/bots/bot-1/models", "chat is Models")
    assert.deepEqual(titles(), ["Models"], "and the screen is named for it")
  })
  await seed("old-dictation", ALL)
  await mount(settings("/settings/bots/bot-1/dictation"), async () => {
    assert.equal(path(), "/settings/bots/bot-1/speech-to-text", "dictation is Speech-to-text")
    assert.deepEqual(titles(), ["Speech-to-text"], "and the screen is named for it")
  })
})

test("an address naming no page of this bot's lands on its list", async () => {
  await seed("unknown-segment", ALL)
  await mount(settings("/settings/bots/bot-1/nonsense"), async () => {
    assert.equal(path(), "/settings/bots/bot-1", "the bot's own list")
    assert.ok(find("[data-bot-settings-list]"), "and the list is what is drawn")
  })
})

test("an out-of-date plugin's banner leads the list, in the words the design settled", async () => {
  await seed("banner-outdated", ALL, { pluginVersion: "0.1.0" })
  await mount(settings("/settings/bots/bot-1"), async () => {
    const list = find("[data-bot-settings-list]")
    assert.equal(
      list?.firstElementChild?.textContent,
      "This bot's plugin is out of date! Update it to 0.80.0 or newer.",
      "the banner is the first thing on the list",
    )
    assert.equal(rows().length, 6, "and every row follows it")
  })
})

test("a plugin that isn't out of date has no banner over the list", async () => {
  await seed("banner-current", ALL, { pluginVersion: "0.81.0" })
  await mount(settings("/settings/bots/bot-1"), async () => {
    assert.doesNotMatch(text(), /out of date/, "nothing says the plugin is old")
    assert.equal(rows().length, 6, "and the list is all there is")
  })
})

test("a disabled bot has no banner, however old its plugin", async () => {
  await seed("banner-disabled", ALL, { pluginVersion: "0.1.0", disabled: true })
  await mount(settings("/settings/bots/bot-1"), async () => {
    assert.doesNotMatch(text(), /out of date/, "a bot that is off is not told to update")
    assert.equal(rows().length, 6, "and its pages are still listed")
  })
})

test("on a phone a row pushes its page, and the page's back returns to the list", async () => {
  await seed("push", ALL)
  await mount(settings("/settings/bots/bot-1"), async () => {
    assert.deepEqual(titles(), ["A bot"], "the list is a screen of its own")
    await click(row("models"))
    assert.equal(path(), "/settings/bots/bot-1/models", "the page has an address of its own")
    assert.deepEqual(titles(), ["Models"], "named for the page it opened")
    await click(back())
    assert.equal(path(), "/settings/bots/bot-1", "back returns to the list")
    assert.deepEqual(titles(), ["A bot"], "which is named for the bot")
  })
})

test(
  "on a laptop the list takes the menu's pane, and a row swaps the page beside it",
  laptop(async () => {
    await seed("wide", ALL)
    await mount(settings("/settings/bots/bot-1"), async () => {
      assert.ok(find("[data-bot-settings-list]"), "the list is the pane the menu was in")
      absent('a[href="/settings/appearance"]')
      assert.deepEqual(titles(), ["A bot", "General"], "the bot's list beside General")

      await click(row("models"))
      assert.equal(path(), "/settings/bots/bot-1/models", "the address carries the segment")
      assert.ok(find("[data-bot-settings-list]"), "the list stays where it was")
      assert.deepEqual(titles(), ["A bot", "Models"], "and the pane beside it swapped")
      assert.match(text(), /Default model/, "to the Models page")
      assert.doesNotMatch(text(), /Test connection/, "and nothing of General is left")
    })
  }),
)

test("a page still holds what its page held, each setting over its value", async () => {
  const CHAT = [...ALL, "delegation_model", "triage_model", "fallbacks"]
  await seed("pages", ALL, { hostId: "host-1" })
  await mount(settings("/settings/bots/bot-1/general"), async () => {
    assert.deepEqual(titles(), ["General"], "the General page")
    for (const label of ["Enabled", "Name", "Image", "Test connection"])
      assert.ok(text().includes(label), `General still has ${label}`)
    assert.ok(find('[data-setting="name"]'), "its Name is a value that opens its edit")
    assert.doesNotMatch(text(), /Subagent model/, "and nothing of the Hermes side is forced on it")
  })
  await seed("pages-models", CHAT, { hostId: "host-1" })
  await mount(settings("/settings/bots/bot-1/models"), async () => {
    assert.deepEqual(titles(), ["Models"], "the Models page")
    for (const label of ["Default model", "Triage model", "Fallback providers"])
      assert.ok(text().includes(label), `Models still has ${label}`)
    assert.ok(find('[data-setting="fallbacks"]'), "its chain is a value that opens its own screen")
  })
})

test("a page's own edit is a screen the list's page pushes, with the list under it", async () => {
  await seed("pages-edit", ALL)
  await mount(settings("/settings/bots/bot-1/general/name"), async () => {
    assert.deepEqual(titles(), ["Name"], "the edit is a screen named for what it edits")
    assert.ok(find("#edit-name"), "holding the bot's name in a field")
    assert.equal(path(), "/settings/bots/bot-1/general/name", "at an address of its own")
    await click(back())
    assert.equal(
      path(),
      "/settings/bots/bot-1/general",
      "and Back returns to the page it came from",
    )
    assert.deepEqual(titles(), ["General"], "which is named for the page")
  })
})
