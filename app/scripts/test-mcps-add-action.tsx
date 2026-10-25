/**
 * The MCP page's way in to adding a server: a + in the screen header rather than a row above the
 * lists. The real route is mounted at /settings/bots/<botId>/mcps over a seeded device database and a
 * faked HTTP boundary, so the header the page renders under is the one the app gives it.
 *
 * The + is there only where the Host answers `mcps_add` — the gate the Add row had — and its tap
 * opens the same Add sheet (Catalogue where the Host reads one, Custom server where it can land a
 * block): a Host that withholds `mcps_catalogue` still has the +, offering only the custom form. The
 * lists themselves are untouched by the move.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter, Route, Routes } from "react-router"

import { SettingsPage } from "@/routes/settings"
import { botPageOf } from "@/lib/bot-tabs"
import { db } from "@/lib/db"
import {
  botProfile,
  click,
  find,
  findAll,
  json,
  mediaHost,
  mount,
  seedSettings,
  settle,
  until,
  type HostAsk,
} from "./component-kit.tsx"

/** The MCP page, at the address the bot's settings list gives it. */
const settings = () => (
  <MemoryRouter initialEntries={["/settings/bots/bot-1/mcps"]}>
    <Routes>
      <Route path="/settings/:section?/:botId?/:tab?" element={<SettingsPage />} />
    </Routes>
  </MemoryRouter>
)

/** What the Host reports the bot has: one of its own and one a Hermes plugin provides. */
const SERVERS = [
  {
    name: "github",
    state: "on",
    enabled: true,
    source: "config",
    reason: null,
    access: false,
    tools: 78,
  },
  {
    name: "filesystem",
    state: "plugin",
    enabled: true,
    source: "plugin",
    reason: null,
    access: false,
    tools: 4,
  },
]

const addButton = () => find("[data-mcp-add]")
/** Every control on the screen answering to the Add action's name, wherever it sits. */
const namedAdd = () =>
  findAll("button").filter(
    (button) =>
      button.getAttribute("aria-label") === "Add a server" ||
      button.getAttribute("title") === "Add a server",
  )
const sectionHeading = (section: string) =>
  find(`[data-mcp-section="${section}"] h2`)?.textContent ?? null

/**
 * A bot of this test's own — its connection names a host, so no other test's feature answers are
 * read — with the plugin's `info` advertising `features` and its `mcp` route answering `servers`.
 */
async function seed(name: string, features: string[], servers: unknown[] = SERVERS) {
  await seedSettings()
  await db.profiles.clear()
  await db.profiles.put(botProfile(name))
  const asked: HostAsk[] = []
  mediaHost({ host: name, features, asked })
  const host = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    if (url.pathname.endsWith("/plugins/memento/mcp")) {
      // Recorded here rather than by the host behind it: this route is answered before the host
      // sees it, so its own record would never carry the read.
      asked.push({ host: url.host, path: url.pathname, search: url.search, authorization: null })
      return json({ object: { servers } })
    }
    return host(input as RequestInfo, init)
  }) as typeof fetch
  return asked
}

test("the + sits in the screen header, not in the page's body", async () => {
  await seed("mcp-add-header", ["mcps", "mcps_add", "mcps_catalogue"])
  await mount(settings(), async () => {
    await settle()
    const button = addButton()
    assert.ok(button, "the + is on screen")
    assert.equal(button.getAttribute("aria-label"), "Add a server", "named Add a server")
    assert.equal(button.getAttribute("title"), "Add a server", "with that name as its tooltip")
    assert.ok(button.closest("header"), "and it sits in the screen's header")
    assert.equal(button.closest("[data-mcp-tab]"), null, "never in the page's own body")
    assert.equal(
      find("[data-mcp-tab]")?.textContent?.includes("Add a server"),
      false,
      "and no Add row is left in the page",
    )
    assert.equal(namedAdd().length, 1, "there is exactly one control named Add a server")
    // The screen is the MCP page's own, titled as its row in the settings list names it.
    assert.equal(find("h1")?.textContent, botPageOf("mcps").title, "the header is the MCP page's")
  })
})

test("its tap opens the Add sheet, with both ways in", async () => {
  await seed("mcp-add-sheet", ["mcps", "mcps_add", "mcps_catalogue"])
  await mount(settings(), async () => {
    await settle()
    await click(addButton())
    await until(async () => Boolean(find('[data-mcp-source="catalogue"]')), "the Add sheet to open")
    assert.ok(find('[data-mcp-source="custom"]'), "and to offer Custom server too")
    assert.equal(
      find('[role="dialog"]')?.textContent?.includes("Add a server"),
      true,
      "the sheet is the one the Add row opened",
    )
  })
})

test("a Host without mcps_add has no + anywhere, and still lists its servers", async () => {
  const asked = await seed("mcp-add-withheld", ["mcps", "mcps_catalogue"])
  await mount(settings(), async () => {
    await settle()
    assert.equal(addButton(), null, "no +")
    assert.equal(namedAdd().length, 0, "and nothing named Add a server")
    assert.equal(
      asked.filter((one) => one.path.endsWith("/plugins/memento/mcp")).length,
      1,
      "the page still read the bot's servers",
    )
    assert.equal(sectionHeading("config"), "Your servers", "its own servers are there")
    assert.equal(sectionHeading("plugin"), "From plugins", "and the plugin's")
    assert.ok(find('[data-mcp="github"]'), "each with its row")
    assert.ok(find('[data-mcp="filesystem"]'))
  })
})

test("a Host with mcps_add but no Catalogue has the +, offering only a custom server", async () => {
  await seed("mcp-add-no-catalogue", ["mcps", "mcps_add"])
  await mount(settings(), async () => {
    await settle()
    assert.ok(addButton(), "the + is there for a server typed in by hand")
    await click(addButton())
    await until(async () => Boolean(find('[data-mcp-source="custom"]')), "the Add sheet to open")
    assert.equal(
      find('[data-mcp-source="catalogue"]'),
      null,
      "and offers no way into a Catalogue this Host can't read",
    )
  })
})

test("the lists are what they were, with the + over them", async () => {
  await seed("mcp-add-lists", ["mcps", "mcps_add", "mcps_catalogue"])
  await mount(settings(), async () => {
    await settle()
    assert.ok(addButton(), "the + is on the screen")
    assert.equal(sectionHeading("config"), "Your servers", "its own servers keep their heading")
    assert.equal(sectionHeading("plugin"), "From plugins", "and the plugin's keeps its own")
    assert.equal(
      findAll("[data-mcp]").map((row) => row.getAttribute("data-mcp")).join(","),
      "github,filesystem",
      "every server keeps its row",
    )
    const headings = findAll("[data-mcp-tab] h2").map((one) => one.textContent).join(",")
    assert.equal(headings, "Your servers,From plugins", "and the page holds the lists alone")
  })
})

test("an empty list is the + and no heading at all", async () => {
  await seed("mcp-add-empty", ["mcps", "mcps_add", "mcps_catalogue"], [])
  await mount(settings(), async () => {
    await settle()
    assert.ok(addButton(), "with nothing to list the + is still the way in")
    assert.equal(findAll("[data-mcp]").length, 0, "no server is listed")
    assert.equal(findAll("[data-mcp-tab] h2").length, 0, "and an empty list has no heading")
  })
})

test("on a wide screen the + is the page's own, never the list's", async () => {
  // The width is set before the screen is rendered, since the pane it draws is chosen then.
  const width = window.innerWidth
  window.innerWidth = 1440
  try {
    await seed("mcp-add-wide", ["mcps", "mcps_add", "mcps_catalogue"])
    await mount(settings(), async () => {
      await settle()
      const headers = findAll("header")
      const titled = (title: string) =>
        headers.find((one) => one.querySelector("h1")?.textContent === title)
      assert.equal(headers.length, 2, "the list and the page each wear a header")
      assert.ok(
        titled(botPageOf("mcps").title)?.querySelector("[data-mcp-add]"),
        "the + is in the MCP page's header",
      )
      assert.equal(
        titled("A bot")?.querySelector("[data-mcp-add]"),
        null,
        "and the bot's list beside it has none",
      )
      assert.ok(find("[data-bot-settings-list]"), "the list is on screen beside the page")
    })
  } finally {
    window.innerWidth = width
  }
})
