// A Bot's MCP servers can be taken away from their own sheet: the Config tab of a server the bot's
// own config holds carries a Remove server, and the one a Hermes plugin provides carries none,
// because Hermes refuses to modify that one. A removal asks for confirmation first — a cancel sends
// nothing and leaves the server exactly where it was — and a confirmed one takes the server away and
// leaves the page showing what is left, without a manual refresh: the page's own re-read of the bot's
// servers is what the list follows, so the row stays gone. Phone and tablet, light and dark.
import { app, assert, flow, mock, pass } from "./lib.mjs"

const run = async ({ page, profileId, shot, until }) => {
  const editor = `/settings/bots/${profileId}`
  const screen = `${editor}/mcps`
  // The removals the app sent, so the route and the server it named are both asserted.
  const removals = []
  const reads = []
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname
    if (path === "/api/plugins/memento/mcp") reads.push(1)
    if (request.method() === "DELETE" && path.startsWith("/api/plugins/memento/mcp/"))
      removals.push(decodeURIComponent(path.split("/").pop()))
  })
  // One server's own sheet, opened by tapping its name, on its Config tab.
  const openConfig = async (name) => {
    await page.locator(`[data-mcp="${name}"] button`).first().click()
    await page.getByRole("button", { name: "Remove server" }).waitFor({ timeout: 15_000 })
  }
  const closeSheet = async () => {
    await page.keyboard.press("Escape")
    await page.getByRole("button", { name: "Remove server" }).waitFor({ state: "hidden" })
  }

  try {
    // The bot's settings list carries the MCP page, and it opens a screen of its own.
    await page.goto(`${app}${editor}`)
    const row = page.locator('[data-bot-page="mcps"]')
    await row.waitFor({ timeout: 15_000 })
    await row.click()
    await page.waitForURL(`**${screen}`, { timeout: 15_000 })
    await page.locator('[data-mcp="postgres"]').waitFor({ timeout: 15_000 })
    await shot("rows")

    // Row removal is gone from the list itself: each server's own Config carries it, and the one a
    // Hermes plugin provides is read-only so its sheet has none.
    assert.equal(
      await page.locator("[data-mcp-tab]").getByRole("button", { name: /^Remove / }).count(),
      0,
      "no row offers a removal beside its name any more",
    )
    await openConfig("postgres")
    await shot("config")
    await closeSheet()
    await page.locator('[data-mcp="filesystem"] button').first().click()
    await page.getByRole("tab", { name: "Config" }).waitFor({ timeout: 15_000 })
    assert.equal(
      await page.getByRole("button", { name: "Remove server" }).count(),
      0,
      "a server a Hermes plugin provides offers no removal",
    )
    await closeSheet()

    // The removal asks first, and a cancel sends nothing to the bot and leaves the server where it is.
    await openConfig("postgres")
    await page.getByRole("button", { name: "Remove server" }).click()
    const dialog = page.getByRole("alertdialog")
    await dialog.getByText("Remove postgres?", { exact: true }).waitFor({ timeout: 15_000 })
    await shot("confirm")
    await dialog.getByRole("button", { name: "Cancel" }).click()
    await dialog.waitFor({ state: "hidden", timeout: 15_000 })
    assert.deepEqual(removals, [], "a cancelled removal sends nothing to the bot")
    assert.ok(
      await page.locator('[data-mcp="postgres"]').isVisible(),
      "the server a cancel was asked about is still listed",
    )

    // Confirming takes the server away for this bot, and the page shows what is left.
    await page.getByRole("button", { name: "Remove server" }).click()
    await dialog.getByText("Remove postgres?", { exact: true }).waitFor({ timeout: 15_000 })
    await dialog.getByRole("button", { name: "Remove", exact: true }).click()
    await until(
      () =>
        page
          .locator('[data-mcp="postgres"]')
          .count()
          .then((count) => count === 0),
      15_000,
      "the removed server to go without a manual refresh",
    )
    assert.deepEqual(
      removals,
      ["postgres"],
      "the removal named the server on the plugin's own route",
    )
    assert.equal(await page.locator("[data-mcp]").count(), 5, "the page shows what is left")
    await shot("removed")

    // The page keeps reading while a server is still connecting, and the row stays gone: the list
    // follows the bot's own answer rather than a row the app dropped by itself.
    const opened = reads.length
    await until(() => reads.length > opened, 15_000, "the page to read the bot's servers again")
    assert.equal(
      await page.locator('[data-mcp="postgres"]').count(),
      0,
      "the removed server stays gone across a re-read",
    )

    assert.deepEqual(errors, [], `no error in the console (${errors.join("; ")})`)
  } finally {
    // The rest of the suite finds the mock's whole list again — the removed server is put back, and
    // anything the add flow left behind with it.
    await fetch(`${mock}/__mock/mcp`, { method: "POST" })
  }
}

for (const width of [390, 1024]) {
  for (const dark of [false, true]) {
    const look = `${width}${dark ? "-dark" : ""}`
    await flow(`mcps-remove-${look}`, run, {
      viewport: { width, height: width < 768 ? 844 : 768 },
      dark,
    })
  }
}
pass(
  "a removal lives on each of a Bot's own MCP servers' Config tab and on none a Hermes plugin provides, a cancel sends nothing and leaves the server, and a confirmed removal takes it away with the page showing what is left, at 390 and 1024px, light and dark",
)
