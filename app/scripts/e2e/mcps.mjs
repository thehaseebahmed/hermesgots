// A Bot's MCP servers, as a page of its own settings at /settings/bots/<botId>/mcps: a + in the
// screen's header adds a server, then the servers the bot's own config holds under "Your servers",
// then the ones a Hermes plugin provides under "From plugins". Every row is its name over its health
// — a tool count where Hermes reports one, Off, Connecting…, the Host's own sentence on a failure,
// and Click here to authenticate on a server waiting for Server access — and carries no state badge.
// Flipping a switch writes it and the row's health follows. The page is a history entry of its own,
// so on a phone back returns to the bot's list. A Bot with no servers shows the + and no heading at
// all. Phone and tablet, light and dark.
import { app, assert, flow, pass } from "./lib.mjs"

// What the mock's rows answer, and the health line the page draws for each.
const SERVERS = [
  ["github", "Healthy: 78 tools"],
  ["postgres", "Off"],
  ["linear", "Connecting…"],
  ["sentry", "Connection refused: nothing is listening on localhost:3100."],
  ["notion", "Click here to authenticate"],
  ["filesystem", "Healthy: 4 tools"],
]
const REASON = "Connection refused: nothing is listening on localhost:3100."

const run = async ({ page, profileId, shot, until }) => {
  const editor = `/settings/bots/${profileId}`
  const screen = `${editor}/mcps`
  // Every read of the Bot's servers, so the page's own timer can be counted.
  const reads = []
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith("/api/plugins/memento/mcp")) reads.push(1)
  })
  const panel = () => page.locator("[data-mcp-tab]")

  // The bot's settings list carries the MCP page, and it opens a screen of its own.
  await page.goto(`${app}${editor}`)
  const row = page.locator('[data-bot-page="mcps"]')
  await row.waitFor({ timeout: 15_000 })
  await shot("list")
  await row.click()
  await page.waitForURL(`**${screen}`, { timeout: 15_000 })

  // The Add action is the header's +, named what its row was, and the page carries no row for it.
  const add = page.locator("[data-mcp-add]")
  await add.waitFor({ timeout: 15_000 })
  assert.ok(
    await add.evaluate((node) => Boolean(node.closest("header"))),
    "the Add action is a + in the screen's header",
  )
  assert.equal(
    await panel().getByText("Add a server", { exact: true }).count(),
    0,
    "and no Add row is left in the page",
  )

  // Every server, with its health under its name — and no state badge.
  for (const [name, health] of SERVERS) {
    const server = page.locator(`[data-mcp="${name}"]`)
    await server.waitFor({ timeout: 15_000 })
    assert.ok(
      await server.getByText(health, { exact: true }).isVisible(),
      `${name} reads as ${health}`,
    )
  }
  for (const word of ["on", "off", "connecting", "failed", "needs access", "provided by a plugin"])
    assert.equal(
      await panel().getByText(word, { exact: true }).count(),
      0,
      `no row carries the state word "${word}"`,
    )
  // The two headings, each over its own servers, and the failed one's reason under its name.
  assert.equal(
    await panel().getByText("Your servers", { exact: true }).count(),
    1,
    "the bot's own servers sit under their heading",
  )
  assert.equal(
    await panel().getByText("From plugins", { exact: true }).count(),
    1,
    "the plugin's sit under theirs",
  )
  assert.ok(
    await page.locator('[data-mcp="sentry"]').getByText(REASON, { exact: true }).isVisible(),
    "a failed server shows the Host's own reason",
  )
  // A switch per server the bot's own config has, and none for the one a Hermes plugin provides.
  assert.equal(
    await panel().getByRole("switch").count(),
    5,
    "each of the bot's own servers has a switch",
  )
  assert.equal(
    await page.locator('[data-mcp="filesystem"] [role="switch"]').count(),
    0,
    "a server a Hermes plugin provides has no switch",
  )
  // The health line that is the way into Server access is a button of its own.
  assert.equal(
    await page
      .locator('[data-mcp="notion"]')
      .getByRole("button", { name: "Click here to authenticate" })
      .count(),
    1,
    "the waiting row's health line is the button that starts Server access",
  )
  await shot("servers")

  // Flipping a switch writes the flag for this bot, and the row's health follows without a manual
  // refresh. The flow reads the state it starts in and puts it back, so the mock is left as found.
  const github = page.getByRole("switch", { name: "github on", exact: true })
  const checked = async () => (await github.getAttribute("aria-checked")) === "true"
  const readsAs = (health) =>
    page.locator('[data-mcp="github"]').getByText(health, { exact: true }).isVisible()
  const before = await checked()
  await github.click()
  await until(
    () => readsAs(before ? "Off" : "Healthy: 78 tools"),
    15_000,
    `the toggled server to read as ${before ? "Off" : "Healthy"}`,
  )
  assert.equal(await checked(), !before, "the switch follows the state it landed in")
  await shot("toggled")
  await github.click()
  await until(
    () => readsAs(before ? "Healthy: 78 tools" : "Off"),
    15_000,
    `the toggled server to read as ${before ? "Healthy" : "Off"} again`,
  )
  assert.equal(await checked(), before, "switching it back restores it")

  // A server that is connecting is watched: the page reads again on its own, so the state it lands in
  // shows without anything being tapped.
  const watched = reads.length
  await until(
    () => reads.length > watched,
    15_000,
    "the page to read again while a server is connecting",
  )

  // Where back lands is the width's own: on a phone the page was pushed over the bot's list, while on
  // the wide screen the list stood beside the page all along, so its own back control is the way out.
  const wide = (page.viewportSize()?.width ?? 0) >= 1024
  if (wide) {
    await page.getByRole("button", { name: "Back", exact: true }).click()
    await page.waitForURL((url) => url.pathname === "/settings", { timeout: 15_000 })
  } else {
    await page.goBack()
    await page.waitForURL((url) => url.pathname === editor, { timeout: 15_000 })
    await page.locator('[data-bot-page="mcps"]').waitFor({ timeout: 15_000 })
  }
  await shot("back")

  // A Bot with no MCP servers shows the + and nothing else: no heading over an empty list.
  await page.route("**/api/plugins/memento/mcp", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ object: { servers: [] } }),
    }),
  )
  await page.goto(`${app}${screen}`)
  await page.getByRole("button", { name: "Add a server" }).waitFor({ timeout: 15_000 })
  assert.equal(await page.locator("[data-mcp]").count(), 0, "no server is listed")
  assert.equal(
    await panel().getByText("Your servers", { exact: true }).count(),
    0,
    "an empty list has no heading",
  )
  assert.equal(
    await panel().getByText("From plugins", { exact: true }).count(),
    0,
    "and no second heading either",
  )
  await shot("empty")

  // Nothing transient to watch, so the page reads once on open and no more.
  const opened = reads.length
  await page.waitForTimeout(7_000)
  assert.equal(reads.length, opened, "a page with nothing transient reads once on open")
  await page.unroute("**/api/plugins/memento/mcp")
}

for (const width of [390, 1024]) {
  for (const dark of [false, true]) {
    const look = `${width}${dark ? "-dark" : ""}`
    await flow(`mcps-${look}`, run, {
      viewport: { width, height: width < 768 ? 844 : 768 },
      dark,
    })
  }
}
pass(
  "the Bot's MCP servers are a page of its settings: a + in the screen's header for Add a server and no row for it in the page, the bot's own servers and then the plugin's under their headings, each row a name over its health with no state badge, a switch on each of the bot's own and none on a plugin's, the waiting row's health line the button into Server access, back out to the bot's list on a phone and to Settings from the list on the wide screen, the empty page with its + alone and its own polling, at 390 and 1024px, light and dark",
)
