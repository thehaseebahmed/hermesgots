/**
 * A bot's settings as a multi-step screen: the list's rows in the order they are drawn and the copy
 * each carries, the rows a host's features leave out and the addresses that land on General instead,
 * the segments that named pages before the list landing on the pages that took their place, the
 * out-of-date banner leading the list, a row pushing its page on a phone and swapping the pane
 * beside the list on a laptop, and each page still holding what its tab held.
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
      <Route path="/settings/:section?/:botId?/:tab?" element={<SettingsPage />} />
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
const headings = () => findAll("[data-bot-settings-list] h2").map((heading) => heading.textContent)
const back = () => find('button[aria-label="Back"]')
const titles = () => findAll("h1").map((heading) => heading.textContent)

test("the list draws General, then the Gots plugin's pages, then the bot's Hermes's", async () => {
  await seed("list-order", ALL)
  await mount(settings("/settings/bots/bot-1"), async () => {
    assert.deepEqual(
      rows(),
      ["general", "chat", "coding", "speech-to-text", "mcps", "skills"],
      "the pages in list order",
    )
    assert.deepEqual(
      headings(),
      ["Gots Specific Settings", "Hermes Settings"],
      "one heading per ownership, over the pages it holds",
    )
    assert.deepEqual(
      findAll("[data-bot-page]").map((one) => one.textContent),
      [
        "GeneralEnabled, notifications, profile and your Hermes's address",
        "ChatModel, default model, triage model and fallback providers",
        "CodingAway From Keyboard and this bot's pick budget",
        "Speech-to-textVocabulary, cleanup model and speech model",
        "MCPThe servers this bot works with",
        "SkillsThe skills this bot can use",
      ],
      "every row is its name over the line saying what it holds",
    )
    assert.deepEqual(titles(), ["A bot"], "the list screen is named after the bot")
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
  await seed("old-models", ALL)
  await mount(settings("/settings/bots/bot-1/models"), async () => {
    assert.equal(path(), "/settings/bots/bot-1/chat", "models is Chat")
    assert.deepEqual(titles(), ["Chat"], "and the screen is named for it")
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
    await click(row("chat"))
    assert.equal(path(), "/settings/bots/bot-1/chat", "the page has an address of its own")
    assert.deepEqual(titles(), ["Chat"], "named for the page it opened")
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

      await click(row("chat"))
      assert.equal(path(), "/settings/bots/bot-1/chat", "the address carries the segment")
      assert.ok(find("[data-bot-settings-list]"), "the list stays where it was")
      assert.deepEqual(titles(), ["A bot", "Chat"], "and the pane beside it swapped")
      assert.match(text(), /Default model/, "to the Chat page")
      assert.doesNotMatch(text(), /Test connection/, "and nothing of General is left")
    })
  }),
)

test("a page still holds what its page held: General its own fields, Chat its models", async () => {
  const CHAT = [...ALL, "delegation_model", "triage_model", "fallbacks"]
  await seed("pages", ALL, { hostId: "host-1" })
  await mount(settings("/settings/bots/bot-1/general"), async () => {
    assert.deepEqual(titles(), ["General"], "the General page")
    for (const label of ["Enabled", "Name", "Image", "Test connection"])
      assert.ok(text().includes(label), `General still has ${label}`)
  })
  await seed("pages-chat", CHAT, { hostId: "host-1" })
  await mount(settings("/settings/bots/bot-1/chat"), async () => {
    assert.deepEqual(titles(), ["Chat"], "the Chat page")
    for (const label of ["Default model", "Triage model", "Fallback providers"])
      assert.ok(text().includes(label), `Chat still has ${label}`)
  })
})
