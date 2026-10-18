// What the plugin's own `info` advertises decides what the app draws. A Bot whose plugin answers
// without the `mcps` feature — a Hermes this plugin can't list MCP servers on — has no MCP servers
// row in its editor at all, and the screen's own URL brings the user back to the Bot instead of
// leaving them on a blank page. A Bot whose plugin lists servers but doesn't advertise `mcps_write`
// — a Hermes whose write built-ins are missing — still lists them, with no switch on any row rather
// than one whose every tap could only come back refused. One that switches them but doesn't
// advertise `mcps_remove` — a plugin older than the removal — keeps its switch and offers no
// removal, for the same reason. A Host that can do all that but has no Catalogue to read — a Hermes
// without the module the Add action needs — keeps its screen and offers no Add action, again so no
// control is offered that could only fail; and one that reads a Catalogue but predates the add keeps
// its Catalogue and offers no Add action either, since the action's whole work is the adding. The
// `info` answer is the only thing that changes; nothing logs an error.
import { app, assert, flow, pass } from "./lib.mjs"

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

  // A Hermes that can neither list a Bot's servers nor switch one: no row, and no screen to be stuck
  // on. A plugin that can't list them can't have written the switch either, so both go together.
  await gate("mcps", "mcps_write")

  // The Bot's editor answers, and carries no MCP servers row at all.
  const asked = page.waitForResponse((response) =>
    response.url().endsWith("/api/plugins/memento/info"),
  )
  await page.goto(`${app}${editor}`)
  await asked
  await page.getByRole("button", { name: "Test connection" }).waitFor({ timeout: 15_000 })
  await page.waitForTimeout(1_000)
  assert.equal(
    await page.getByRole("link", { name: "MCP servers" }).count(),
    0,
    "the Bot's editor has no MCP servers row",
  )
  await shot("no-row")

  // Reached by URL, the screen lands back on the Bot: no server list, and nowhere left to be stuck.
  await page.goto(`${app}${screen}`)
  await page.waitForURL(`**${editor}`, { timeout: 15_000 })
  assert.equal(await page.locator("[data-mcp]").count(), 0, "no server is listed")
  assert.equal(
    await page.getByText("No MCP servers.", { exact: true }).count(),
    0,
    "not the empty list's screen",
  )
  await page.getByRole("button", { name: "Test connection" }).waitFor({ timeout: 15_000 })
  await shot("back-on-bot")

  // A Hermes that can list a Bot's servers but not switch one: the screen lists them and offers no
  // switch at all, rather than one whose every tap could only come back refused.
  await gate("mcps_write")
  await page.goto(`${app}${editor}`)
  await page.getByRole("link", { name: "MCP servers" }).waitFor({ timeout: 15_000 })
  await page.goto(`${app}${screen}`)
  await page.locator('[data-mcp="github"]').waitFor({ timeout: 15_000 })
  assert.equal(await page.locator("[data-mcp]").count(), 6, "the Bot's servers are listed")
  assert.equal(
    await page.getByRole("switch").count(),
    0,
    "a Host that can't switch one offers no switch",
  )
  await shot("no-switches")

  // A plugin that can switch a Bot's servers but predates the removal: the switch is offered and no
  // row offers a removal, rather than a removal whose every tap could only come back a 404. The
  // plugin that first shipped the switch is exactly that host.
  await gate("mcps_remove")
  await page.goto(`${app}${editor}`)
  await page.getByRole("link", { name: "MCP servers" }).waitFor({ timeout: 15_000 })
  await page.goto(`${app}${screen}`)
  await page.locator('[data-mcp="github"]').waitFor({ timeout: 15_000 })
  assert.equal(
    await page.getByRole("switch").count(),
    5,
    "the Bot's own servers still have a switch",
  )
  assert.equal(
    await page.getByRole("button", { name: /^Remove / }).count(),
    0,
    "a Host that can't remove one offers no removal",
  )
  await shot("no-removals")

  // A plugin that lists and switches a Bot's servers but has no Catalogue to add from: the screen is
  // the same, with no Add action on it, rather than one whose every tap could only be a 501.
  await gate("mcps_catalogue")
  await page.goto(`${app}${editor}`)
  await page.getByRole("link", { name: "MCP servers" }).waitFor({ timeout: 15_000 })
  await page.goto(`${app}${screen}`)
  await page.locator('[data-mcp="github"]').waitFor({ timeout: 15_000 })
  assert.equal(
    await page.getByRole("button", { name: "Add a server" }).count(),
    0,
    "a Host with no Catalogue offers no Add action",
  )
  assert.equal(
    await page.getByRole("switch").count(),
    5,
    "and its servers keep their switch",
  )
  await shot("no-catalogue")

  // A plugin that lists, switches and removes a Bot's servers and reads a Catalogue, but predates
  // the add: the screen and its Catalogue are the same, with no Add action on it — the action's whole
  // work is the adding, so a Host that can't add has no action to offer.
  await gate("mcps_add")
  await page.goto(`${app}${editor}`)
  await page.getByRole("link", { name: "MCP servers" }).waitFor({ timeout: 15_000 })
  await page.goto(`${app}${screen}`)
  await page.locator('[data-mcp="github"]').waitFor({ timeout: 15_000 })
  assert.equal(
    await page.getByRole("button", { name: "Add a server" }).count(),
    0,
    "a Host that can read a Catalogue but can't add from one offers no Add action",
  )
  assert.equal(
    await page.getByRole("button", { name: /^Remove / }).count(),
    5,
    "and its servers keep their removal",
  )
  await shot("no-add")

  assert.deepEqual(errors, [], `no error in the console (${errors.join("; ")})`)
}

await flow("mcps-gate", run)
pass(
  "a Bot whose plugin answers without `mcps` has no MCP servers row and its screen's URL returns to the Bot, one that lists servers without `mcps_write` lists them with no switch, one that switches them without `mcps_remove` keeps its switch and offers no removal, one with no Catalogue offers no Add action, one that has a Catalogue but can't add from one offers no Add action either, and no error is logged",
)
