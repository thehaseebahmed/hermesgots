/**
 * A bot's settings as a multi-step screen (ADR 0055): two cards with no headings and no captions —
 * General alone, then every other page together — the rows in the order they are drawn and the copy
 * each carries, an icon a row and no chevron, the rows a host's features leave out and the addresses
 * that land on General instead, the segments that named pages before the list landing on the pages
 * that took their place, a fourth segment that names nothing landing on the page it was asked under,
 * the out-of-date banner leading the list, a row pushing its page on a phone and swapping the pane
 * beside the list on a laptop, the header's trash named for the bot it deletes, and each page still
 * holding what its tab held — values that open their edits.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter, Route, Routes } from "react-router"

import { db } from "@/lib/db"
import { MIN_PLUGIN_VERSION } from "@/lib/version"
import { SettingsPage } from "@/routes/settings"
import {
  Path,
  absent,
  GENERAL,
  botProfile,
  click,
  find,
  findAll,
  laptop,
  mediaHost,
  missing,
  mount,
  path,
  seedSettings,
  shutSheet,
  text,
  type,
  until,
  wordsOf,
} from "./component-kit.tsx"

/** Every feature the gated pages need, so a test starts from a host that has them all. */
const ALL = ["general_page", "dictation", "mcps", "afk_picks", "skills", "delegation_page"]

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
  mediaHost({ features, general: GENERAL })
}

const rows = () => findAll("[data-bot-page]").map((row) => row.getAttribute("data-bot-page"))
const row = (segment: string) => find(`[data-bot-page="${segment}"]`)
/** Any heading the list still draws: ADR 0055 took them all out. */
const headings = () =>
  findAll(
    "[data-bot-settings-list] h1, [data-bot-settings-list] h2, [data-bot-settings-list] h3",
  ).map((heading) => heading.textContent)
/** The cards the list draws, each with the pages it holds. */
const cards = () =>
  findAll("[data-bot-settings-list] [data-settings-group]")
    .map((card) =>
      [...card.querySelectorAll("[data-bot-page]")].map((one) => one.getAttribute("data-bot-page")),
    )
    .filter((pages) => pages.length)
/** The icons a row wears: its page's own, and no chevron beside it. */
const iconsPerRow = () =>
  findAll("[data-bot-page]").map((one) => one.querySelectorAll("svg").length)
/** What a user reads on an element, with its spacing flattened. */
const back = () => find('button[aria-label="Back"]')
const titles = () => findAll("h1").map((heading) => heading.textContent)

test("the bot's page is what the bot is under Bot, then every setting in one card under Settings", async () => {
  await seed("list-order", ALL)
  await mount(settings("/settings/bots/bot-1"), async () => {
    assert.deepEqual(
      rows(),
      ["general", "models", "coding", "speech-to-text", "mcps", "skills", "delegation"],
      "the settings in list order",
    )
    assert.deepEqual(
      cards(),
      [["general", "models", "coding", "speech-to-text", "mcps", "skills", "delegation"]],
      "one card of every setting, under the bot's own rows",
    )
    assert.deepEqual(
      headings(),
      [],
      "and no headings: a caption names a card, and none is a heading",
    )
    assert.deepEqual(
      findAll("[data-bot-page]").map((one) => one.textContent),
      [
        "GeneralModel, limits, session timeouts and update settings",
        "ModelsThe model this bot's chats run",
        "CodingAway From Keyboard and this bot's pick budget",
        "Speech-to-textVocabulary, cleanup model and speech model",
        "MCPThe servers this bot works with",
        "SkillsThe skills this bot can use",
        "DelegationSubagent model, limits and approvals",
      ],
      "every row is its name over the line saying what it holds",
    )
    assert.deepEqual(
      iconsPerRow(),
      [1, 1, 1, 1, 1, 1, 1],
      "one icon a row, and no chevron beside it",
    )
    assert.deepEqual(
      findAll("[data-bot-settings-list] > p").map((one) => wordsOf(one)),
      ["Bot", "Settings"],
      "two captions: the bot's own rows, then the settings behind them",
    )
    assert.deepEqual(
      findAll("[data-bot-card] > p").map((one) => wordsOf(one)),
      ["Bot Profile", "Hermes"],
      "and the bot's card keeps the names its own cards had",
    )
    assert.match(
      wordsOf(find("[data-bot-card]")),
      /^Mute notifications/,
      "the bot's switches lead its card",
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
  { feature: "delegation_page", segment: "delegation", name: "Delegation" },
] as const

for (const { feature, segment, name } of GATED) {
  test(`a host that withholds ${feature} draws no ${name} row, and its address lands on the bot's page`, async () => {
    await seed(
      `gate-${feature}`,
      ALL.filter((one) => one !== feature),
    )
    await mount(settings(`/settings/bots/bot-1/${segment}`), async () => {
      assert.ok(missing(`[data-bot-page="${segment}"]`), `no ${name} row on the settings card`)
      assert.equal(path(), "/settings/bots/bot-1", "the bot's own address, in place")
      assert.ok(find("[data-bot-card]"), "and the bot's page is what is drawn")
    })
  })
}

test("a host that hasn't answered yet keeps the address, and draws the bot's page meanwhile", async () => {
  await seed("gate-unknown", "away")
  await mount(settings("/settings/bots/bot-1/mcps"), async () => {
    assert.equal(path(), "/settings/bots/bot-1/mcps", "the address it was asked for stands")
    assert.ok(find("[data-bot-card]"), "and the bot's own page is what is drawn")
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

test("a fourth segment that names no edit of its page lands on the page", async () => {
  await seed("unknown-edit", ALL)
  await mount(settings("/settings/bots/bot-1/general/nonsense"), async () => {
    assert.equal(path(), "/settings/bots/bot-1/general", "the page it was asked under")
    assert.deepEqual(titles(), ["General"], "which is drawn, in the entry the address had")
    assert.doesNotMatch(text(), /Cannot GET|no edit/, "and nothing says the address was wrong")
  })
})

test("a fourth segment under a page with no sub-screens lands on the page too", async () => {
  await seed("sub-under-none", ALL)
  await mount(settings("/settings/bots/bot-1/coding/nonsense"), async () => {
    assert.equal(path(), "/settings/bots/bot-1/coding", "Coding, the page the segment followed")
    assert.deepEqual(titles(), ["Coding"], "drawn without a sub-screen it doesn't have")
  })
})

test("an out-of-date plugin's banner leads the list, in the words the design settled", async () => {
  await seed("banner-outdated", ALL, { pluginVersion: "0.1.0" })
  await mount(settings("/settings/bots/bot-1"), async () => {
    const list = find("[data-bot-settings-list]")
    assert.equal(
      list?.firstElementChild?.textContent,
      `This bot's plugin is out of date! Update it to ${MIN_PLUGIN_VERSION} or newer.`,
      "the banner is the first thing on the list",
    )
    assert.equal(rows().length, 7, "and every row follows it")
  })
})

test("a plugin that isn't out of date has no banner over the list", async () => {
  await seed("banner-current", ALL, { pluginVersion: MIN_PLUGIN_VERSION })
  await mount(settings("/settings/bots/bot-1"), async () => {
    assert.doesNotMatch(text(), /out of date/, "nothing says the plugin is old")
    assert.equal(rows().length, 7, "and the list is all there is")
  })
})

test("a disabled bot has no banner, however old its plugin", async () => {
  await seed("banner-disabled", ALL, { pluginVersion: "0.1.0", disabled: true })
  await mount(settings("/settings/bots/bot-1"), async () => {
    assert.doesNotMatch(text(), /out of date/, "a bot that is off is not told to update")
    assert.equal(rows().length, 7, "and its pages are still listed")
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
      assert.match(
        text(),
        /The model a chat runs when it has no pick of its own/,
        "to the Models page",
      )
      assert.doesNotMatch(
        text(),
        /Fallback providers/,
        "and the chain is General's now, not theirs",
      )
    })
  }),
)

test("a page still holds what its page held, each setting over its value", async () => {
  const CHAT = [...ALL, "delegation_model", "triage_model", "fallbacks"]
  await seed("pages", ALL, { hostId: "host-1" })
  await mount(settings("/settings/bots/bot-1"), async () => {
    assert.deepEqual(titles(), ["A bot"], "the bot's own page")
    for (const label of ["Enabled", "Name", "Image", "Test connection"])
      assert.ok(text().includes(label), `it still has ${label}`)
    assert.ok(find('[data-setting="name"]'), "its Name is a value that opens its edit")
    absent('[data-setting="subagent-model"]', "and nothing of the Hermes side is forced on it")
  })
  await seed("pages-models", CHAT, { hostId: "host-1" })
  await mount(settings("/settings/bots/bot-1/models"), async () => {
    assert.deepEqual(titles(), ["Models"], "the Models page")
    assert.ok(
      text().includes("The model a chat runs when it has no pick of its own"),
      "its model pick",
    )
    assert.ok(find('[data-setting="model"]'), "which is a value that opens its pick")
  })
})

test("a page's own edit is a screen the list's page pushes, with the list under it", async () => {
  await seed("pages-edit", ALL)
  await mount(settings("/settings/bots/bot-1/bot/name"), async () => {
    assert.deepEqual(
      titles(),
      ["Edit Name"],
      "the screen says what it does, not what the field says",
    )
    assert.ok(find("#edit-name"), "holding the bot's name in a field")
    assert.equal(path(), "/settings/bots/bot-1/bot/name", "at an address of its own")
    await click(back())
    assert.equal(path(), "/settings/bots/bot-1", "and Back returns to the page it came from")
    assert.deepEqual(titles(), ["A bot"], "which is named for the bot")
  })

  // Every drill-in form says what it does, the host's own keys included.
  await seed("pages-edit-keyed", ALL)
  await mount(settings("/settings/bots/bot-1/general/timezone"), async () => {
    await until(async () => Boolean(find("#edit-timezone")), "the field")
    assert.deepEqual(titles(), ["Edit Timezone"], "a key's form is named the same way")
  })
})

test("a back that would throw away typing asks first", async () => {
  await seed("pages-discard", ALL)
  await mount(settings("/settings/bots/bot-1/general/timezone"), async () => {
    await until(async () => Boolean(find("#edit-timezone")), "the field")
    await type(find("#edit-timezone"), "UTC")
    await click(back())
    assert.equal(path(), "/settings/bots/bot-1/general/timezone", "the back holds the screen")
    assert.ok(find("[role='alertdialog']"), "and asks before it throws the typing away")

    await click(
      findAll("[role='alertdialog'] button").find((one) => wordsOf(one) === "Keep editing") ?? null,
    )
    assert.equal(path(), "/settings/bots/bot-1/general/timezone", "keeping the edit stays in it")

    await click(back())
    await click(
      findAll("[role='alertdialog'] button").find((one) => wordsOf(one) === "Discard") ?? null,
    )
    assert.equal(path(), "/settings/bots/bot-1/general", "and discarding leaves")
  })
})

test(
  "an edit drawn as a card is a pop-up: closing it asks nothing",
  laptop(async () => {
    await seed("wide-edit", ALL)
    await mount(settings("/settings/bots/bot-1/bot/name"), async () => {
      await until(async () => Boolean(find("#edit-name")), "the card's field")
      await type(find("#edit-name"), "Renamed")
      // Clicking out of the card — Escape here — is the whole of saying no.
      await shutSheet(() => find('[role="dialog"]'))
      assert.equal(
        path(),
        "/settings/bots/bot-1",
        "the card closes onto the page it was opened over",
      )
      assert.ok(missing('[role="alertdialog"]'), "with nothing asked: closing a pop-up is the whole of saying no")
      assert.equal((await db.profiles.get("bot-1"))?.name, "A bot", "and nothing was written")
    })
  }),
)

test("an untouched edit leaves without a word", async () => {
  await seed("pages-untouched", ALL)
  await mount(settings("/settings/bots/bot-1/general/timezone"), async () => {
    await until(async () => Boolean(find("#edit-timezone")), "the field")
    await click(back())
    assert.equal(
      path(),
      "/settings/bots/bot-1/general",
      "a form nobody typed in is a back, not a question",
    )
    assert.ok(missing('[role="alertdialog"]'), "with nothing to ask")
  })
})
