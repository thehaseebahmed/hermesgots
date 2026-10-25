// What the plugin's own `info` advertises decides what the app draws. A Bot whose plugin answers
// without `mcps` — a Hermes this plugin can't list MCP servers on — has no MCP page on its settings
// list at all, and the page's own URL brings the user back to the Bot's General page instead of
// leaving them on a blank page. A Bot whose plugin lists servers but doesn't advertise `mcps_write` —
// a Hermes whose write built-ins are missing — still lists them, with no switch on any row rather
// than one whose every tap could only come back refused. One that lists, writes and reads but
// doesn't advertise `mcps_catalogue` keeps its Add action — the header's + — for a server typed in
// by hand and offers no way into the Catalogue, since reading one is the whole of that choice; one
// that reads a Catalogue but predates `mcps_add` offers no + at all, as the action's whole work is
// the adding. One without `mcps_remove` keeps every row and its Config tab with no Remove server on
// it, and one without `mcps_config` opens a sheet with only the Tools tab it can fill — with the
// removal under it, since removing a server is its own feature and doesn't need the block. The
// `info` answer is the only thing that changes; nothing logs an error.
import { app, assert, flow, pass, settled } from "./lib.mjs"

const run = async ({ page, profileId, shot }) => {
  const editor = `/settings/bots/${profileId}`
  const screen = `${editor}/mcps`
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  // The plugin's own `info`, read through and answered with the named features left out.
  const gate = async (...without) => {
    await page.unroute("**/api/plugins/memento/info")
    await page.route("**/api/plugins/memento/info", async (route) => {
      // The browser's CORS preflight for the same URL is left alone; only the answer is rewritten.
      if (route.request().method() !== "GET") return route.continue()
      const response = await route.fetch()
      const body = await response.json()
      await route.fulfill({
        response,
        json: {
          ...body,
          features: (body.features ?? []).filter((feature) => !without.includes(feature)),
        },
      })
    })
  }
  const mcpRow = () => page.locator('[data-bot-page="mcps"]')
  // The MCP page's own body: the settings list's other rows stay on screen, so a control is counted
  // here rather than anywhere on the screen.
  const panel = () => page.locator("[data-mcp-tab]")
  const openPage = async () => {
    await page.goto(`${app}${editor}`)
    await mcpRow().waitFor({ timeout: 15_000 })
    await mcpRow().click()
    await page.waitForURL(`**${screen}`, { timeout: 15_000 })
  }
  // One server's own sheet, opened by tapping its name.
  const openServer = async (name) => {
    await page.locator(`[data-mcp="${name}"] button`).first().click()
    await page.getByRole("tab", { name: "Config" }).waitFor({ timeout: 15_000 })
  }

  // A Hermes that can neither list a Bot's servers nor switch one: no page, and no screen to be stuck
  // on. A plugin that can't list them can't have written the switch either, so both go together.
  await gate("mcps", "mcps_write")

  // The Bot's settings list answers, and carries no MCP page row at all.
  // No row is only an answer once the host's has come back: before it, there is none either.
  const answered = page.waitForResponse(
    (response) =>
      response.url().includes("/api/plugins/memento/info") && response.request().method() === "GET",
  )
  await page.goto(`${app}${editor}`)
  await page.getByRole("button", { name: "Test connection" }).waitFor({ timeout: 15_000 })
  await answered
  await settled(page)
  assert.equal(await mcpRow().count(), 0, "the bot's list of pages has no MCP page")
  await shot("no-page")

  // Reached by URL, the page lands back on the Bot's General page: no server list, and nowhere left
  // to be stuck.
  await page.goto(`${app}${screen}`)
  await page.waitForURL(`**${editor}/general`, { timeout: 15_000 })
  assert.equal(await page.locator("[data-mcp]").count(), 0, "no server is listed")
  await page.getByRole("button", { name: "Test connection" }).waitFor({ timeout: 15_000 })
  await shot("back-on-general")

  // A Hermes that can list a Bot's servers but not switch one: the page lists them and offers no
  // switch at all, rather than one whose every tap could only come back refused.
  await gate("mcps_write")
  await openPage()
  await page.locator('[data-mcp="github"]').waitFor({ timeout: 15_000 })
  assert.equal(await panel().locator("[data-mcp]").count(), 6, "the Bot's servers are listed")
  assert.equal(
    await panel().getByRole("switch").count(),
    0,
    "a Host that can't switch one offers no switch",
  )
  await shot("no-switches")

  // A Host that can't remove one: every row is there and the sheet's Config tab has no removal.
  await gate("mcps_remove")
  await openPage()
  await page.locator('[data-mcp="github"]').waitFor({ timeout: 15_000 })
  assert.equal(await panel().getByRole("switch").count(), 5, "its servers keep their switch")
  await openServer("github")
  assert.equal(
    await page.getByRole("button", { name: "Remove server" }).count(),
    0,
    "a Host that can't remove one offers no removal in Config",
  )
  await shot("no-removals")

  // A Host with no Catalogue to read: the + is in the header for a server typed in by hand, and the
  // sheet it opens offers no way into a Catalogue it can't read.
  await gate("mcps_catalogue")
  await openPage()
  await page.locator('[data-mcp="github"]').waitFor({ timeout: 15_000 })
  const add = page.getByRole("button", { name: "Add a server" })
  assert.ok(
    await add.evaluate((node) => Boolean(node.closest("header"))),
    "the + sits in the screen's header",
  )
  await add.click()
  await page.locator('[data-mcp-source="custom"]').waitFor({ timeout: 15_000 })
  assert.equal(
    await page.locator('[data-mcp-source="catalogue"]').count(),
    0,
    "a Host with no Catalogue offers no way into one",
  )
  await shot("no-catalogue")

  // A Host that reads a Catalogue but can't add from one: no + at all, rather than one whose every
  // tap could only be a 501.
  await gate("mcps_add")
  await openPage()
  await page.locator('[data-mcp="github"]').waitFor({ timeout: 15_000 })
  assert.equal(
    await page.getByRole("button", { name: "Add a server" }).count(),
    0,
    "a Host that can read a Catalogue but can't add from one offers no +",
  )
  assert.equal(await page.locator("[data-mcp-add]").count(), 0, "and nothing of the Add action")
  await shot("no-add")

  // A Host that can't describe a block: the sheet has no Config tab, and only the one tab it can fill.
  await gate("mcps_config")
  await openPage()
  await page.locator('[data-mcp="github"]').waitFor({ timeout: 15_000 })
  await page.locator('[data-mcp="github"] button').first().click()
  await page.getByRole("tab", { name: "Tools" }).waitFor({ timeout: 15_000 })
  assert.equal(await page.getByRole("tab", { name: "Config" }).count(), 0, "no Config tab")
  assert.equal(await page.getByRole("tab", { name: "Tools" }).count(), 1, "the Tools tab alone")
  // Removal is advertised on its own, so the sheet carries it where it has no Config tab to put it in.
  assert.equal(
    await page.getByRole("button", { name: "Remove server" }).count(),
    1,
    "a Host that can remove a server without describing one still offers the removal",
  )
  await shot("tools-only")

  // A failed fetch the browser logs on its own (a 404 with no CORS headers) isn't the app's error.
  assert.deepEqual(
    errors.filter((e) => !/Failed to load resource|CORS policy/.test(e)),
    [],
    `no error in the console (${errors.join("; ")})`,
  )
}

await flow("mcps-gate", run)
pass(
  "a Bot whose plugin answers without `mcps` has no MCP page and its page URL returns to General, one that lists servers without `mcps_write` lists them with no switch, one without `mcps_remove` keeps its rows and offers no removal in Config, one with no Catalogue offers only a custom server to add from the header's +, one that has a Catalogue but can't add from one offers no + at all, one without `mcps_config` opens Tools alone with the removal still under it, and no error is logged",
)
