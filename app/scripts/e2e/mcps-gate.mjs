// A Bot whose plugin answers its `info` without the `mcps` feature — a Hermes this plugin can't list
// MCP servers on. Its editor carries no MCP servers row at all, and the screen's own URL brings the
// user back to the Bot instead of leaving them on a blank page. The `info` answer is the only thing
// that changes; the read of the servers themselves is never asked for, and nothing logs an error.
import { app, assert, flow, pass } from "./lib.mjs"

const run = async ({ page, profileId, shot }) => {
  const editor = `/settings/bots/${profileId}`
  const screen = `${editor}/mcps`
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  // The plugin's own `info`, read through and answered with `mcps` left out of its features.
  await page.route("**/api/plugins/memento/info", async (route) => {
    // The browser's CORS preflight for the same URL is left alone; only the answer is rewritten.
    if (route.request().method() !== "GET") return route.continue()
    const response = await route.fetch()
    const body = await response.json()
    await route.fulfill({
      response,
      json: { ...body, features: (body.features ?? []).filter((feature) => feature !== "mcps") },
    })
  })

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

  assert.deepEqual(errors, [], `no error in the console (${errors.join("; ")})`)
}

await flow("mcps-gate", run)
pass(
  "a Bot whose plugin answers without `mcps` has no MCP servers row, its screen's URL returns to the Bot, and no error is logged",
)
