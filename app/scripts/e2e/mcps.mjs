// A Bot's MCP servers: the row in its editor opens a screen of its own at
// /settings/bots/<botId>/mcps, which lists every server with Gots' own state word, shows the Host's
// own reason on a failed one, carries a switch on each of the bot's own servers and none on the one
// a Hermes plugin provides, and says so when the Bot has none. Flipping a switch writes it and the
// row shows the state it lands in. Back returns to the Bot, and the screen reads once on open, again
// only while a server is connecting or waiting on Server access. Phone and tablet, light and dark.
import { app, assert, flow, pass } from "./lib.mjs"

// What the mock's `mcp` route answers, and the word the screen renders for each state.
const SERVERS = [
  ["github", "on"],
  ["postgres", "off"],
  ["linear", "connecting"],
  ["sentry", "failed"],
  ["notion", "needs access"],
  ["filesystem", "provided by a plugin"],
]
const REASON = "Connection refused: nothing is listening on localhost:3100."

const run = async ({ page, profileId, shot, until }) => {
  const editor = `/settings/bots/${profileId}`
  const screen = `${editor}/mcps`
  // Every read of the Bot's servers, so the screen's own timer can be counted.
  const reads = []
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith("/api/plugins/memento/mcp")) reads.push(1)
  })

  // The Bot's editor carries the row, and it opens the screen as a screen of its own.
  await page.goto(`${app}${editor}`)
  const row = page.getByRole("link", { name: "MCP servers" })
  await row.waitFor({ timeout: 15_000 })
  await row.scrollIntoViewIfNeeded()
  await shot("row")
  await row.click()
  await page.waitForURL(`**${screen}`, { timeout: 15_000 })

  // Every server, with the word Gots uses for its state — and nothing about the tools it brings.
  for (const [name, word] of SERVERS) {
    const server = page.locator(`[data-mcp="${name}"]`)
    await server.waitFor({ timeout: 15_000 })
    assert.ok(await server.getByText(word, { exact: true }).isVisible(), `${name} reads as ${word}`)
  }
  // The failed one carries the Host's own reason.
  assert.ok(
    await page.locator('[data-mcp="sentry"]').getByText(REASON, { exact: true }).isVisible(),
    "a failed server shows the Host's own reason",
  )
  // A switch per server the bot's own config has, and none for the one a Hermes plugin provides.
  assert.equal(await page.getByRole("switch").count(), 5, "each of the bot's own servers has a switch")
  assert.equal(
    await page.locator('[data-mcp="filesystem"] [role="switch"]').count(),
    0,
    "a server a Hermes plugin provides has no switch",
  )
  await shot("servers")

  // Flipping a switch writes the flag for this bot, and the row shows the state it lands in without a
  // manual refresh. Flipping it back leaves the bot as it was, so the mock's state survives the run.
  const github = page.getByRole("switch", { name: "github on" })
  const checked = async () => (await github.getAttribute("aria-checked")) === "true"
  assert.ok(await checked(), "a server that is on reads as on")
  await github.click()
  await until(
    () => page.locator('[data-mcp="github"]').getByText("off", { exact: true }).isVisible(),
    15_000,
    "the toggled server to read as off",
  )
  assert.equal(await checked(), false, "the switch follows the state it landed in")
  await shot("toggled-off")
  await github.click()
  await until(
    () => page.locator('[data-mcp="github"]').getByText("on", { exact: true }).isVisible(),
    15_000,
    "the toggled server to read as on again",
  )
  assert.ok(await checked(), "switching it back on restores it")

  // A server that is connecting is watched: the screen reads again on its own, so the state it
  // lands in shows without anything being tapped.
  const watched = reads.length
  await until(
    () => reads.length > watched,
    15_000,
    "the screen to read again while a server is connecting",
  )

  // Back returns to the Bot, the way every screen of its kind does.
  await page.getByRole("button", { name: "Back" }).click()
  await page.waitForURL(`**${editor}`, { timeout: 15_000 })
  await page.getByRole("button", { name: "Test connection" }).waitFor({ timeout: 15_000 })
  await shot("back")

  // A Bot with no MCP servers says so, reached by URL; the read's answer is the only thing replaced.
  await page.route("**/api/plugins/memento/mcp", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ object: { servers: [] } }),
    }),
  )
  await page.goto(`${app}${screen}`)
  await page.getByText("No MCP servers.", { exact: true }).waitFor({ timeout: 15_000 })
  await shot("empty")

  // Nothing transient to watch, so the screen reads once on open and no more.
  const opened = reads.length
  await page.waitForTimeout(7_000)
  assert.equal(reads.length, opened, "a screen with nothing transient reads once on open")
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
  "the Bot's MCP servers list from its editor row, with every state word, the failed one's reason, a switch per server it owns (and none on a plugin's) flipped off and back on, the empty state and its own polling, at 390 and 1024px, light and dark",
)
