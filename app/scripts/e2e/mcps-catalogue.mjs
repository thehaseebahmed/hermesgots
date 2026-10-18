// A Bot's Add action opens Hermes's Catalogue as a searchable list at
// /settings/bots/<botId>/mcps: every entry the Host's Hermes offers, each marked with whether this
// Bot already has it — the ones it has reading Added, the ones it hasn't reading nothing — and a
// search that narrows the list, in an entry's name or in what Hermes says it is, with a search that
// matches nothing saying so. Opening it and searching it adds nothing: the Bot's own servers are
// exactly what they were, and no add is ever sent. Phone and tablet, light and dark.
import { app, assert, flow, pass } from "./lib.mjs"

// What the mock's catalogue answers, and which of those entries this bot's config already has.
const ENTRIES = [
  "github",
  "google-drive",
  "linear",
  "notion",
  "postgres",
  "sentry",
  "slack",
  "stripe",
  "unvetted",
]
const ADDED = ["github", "linear", "notion", "postgres", "sentry"]

const run = async ({ page, profileId, shot, until }) => {
  const editor = `/settings/bots/${profileId}`
  const screen = `${editor}/mcps`
  // Every add the app sent: browsing the Catalogue may send none.
  const adds = []
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/plugins/memento/mcp/install") adds.push(1)
  })

  await page.goto(`${app}${screen}`)
  // The Bot's own servers first, so the flow can prove the Catalogue left them exactly as they were.
  await page.locator('[data-mcp="github"]').waitFor({ timeout: 15_000 })
  const servers = await page.locator("[data-mcp]").count()

  // The screen offers the Add action, and it opens the Catalogue.
  const add = page.getByRole("button", { name: "Add a server" })
  await add.waitFor({ timeout: 15_000 })
  await add.scrollIntoViewIfNeeded()
  await shot("add")
  await add.click()
  const sheet = page.getByRole("dialog")
  await sheet.getByRole("heading", { name: "Catalogue" }).waitFor({ timeout: 15_000 })

  // Every entry Hermes offers, each marked with whether this Bot already has it.
  for (const name of ENTRIES) {
    const entry = page.locator(`[data-catalogue="${name}"]`)
    await entry.waitFor({ timeout: 15_000 })
    const added = ADDED.includes(name)
    assert.equal(
      await entry.getByText("Added", { exact: true }).count(),
      added ? 1 : 0,
      `${name} reads as ${added ? "already added" : "not added"}`,
    )
  }
  await shot("catalogue")

  // Searching narrows the list to what it matches, in the entry's own name…
  const search = page.getByRole("searchbox", { name: "Search the catalogue" })
  await search.fill("slack")
  await until(
    () => page.locator("[data-catalogue]").count().then((count) => count === 1),
    15_000,
    "the search to narrow the list to the one entry whose name it matches",
  )
  assert.ok(
    await page.locator('[data-catalogue="slack"]').isVisible(),
    "the search kept the entry whose name it matched",
  )
  await shot("searched")

  // …and in what Hermes says an entry is.
  await search.fill("pull requests")
  await until(
    () => page.locator("[data-catalogue]").count().then((count) => count === 1),
    15_000,
    "the search to narrow the list by what Hermes says the entry is",
  )
  assert.ok(
    await page.locator('[data-catalogue="github"]').isVisible(),
    "the search kept the entry whose description it matched",
  )

  // A search that matches nothing says so rather than reading as a Catalogue with no entries.
  await search.fill("nothing like this")
  await sheet
    .getByText("Nothing matches “nothing like this”.", { exact: true })
    .waitFor({ timeout: 15_000 })
  assert.equal(
    await page.locator("[data-catalogue]").count(),
    0,
    "a search that matches nothing lists nothing",
  )
  await shot("no-matches")

  // Opened again, the Catalogue is whole: the search is not kept.
  await page.keyboard.press("Escape")
  await sheet.waitFor({ state: "hidden", timeout: 15_000 })
  await add.click()
  await page.locator('[data-catalogue="stripe"]').waitFor({ timeout: 15_000 })
  assert.equal(
    await page.locator("[data-catalogue]").count(),
    ENTRIES.length,
    "opening the Catalogue again shows every entry",
  )
  await page.keyboard.press("Escape")
  await sheet.waitFor({ state: "hidden", timeout: 15_000 })

  // Nothing was added: the Bot's own servers are what they were, and no add was sent.
  await page.locator('[data-mcp="github"]').waitFor({ timeout: 15_000 })
  assert.equal(
    await page.locator("[data-mcp]").count(),
    servers,
    "the Bot's own servers are unchanged by browsing the Catalogue",
  )
  assert.deepEqual(adds, [], "opening and searching the Catalogue adds nothing")
  await shot("unchanged")
}

for (const width of [390, 1024]) {
  for (const dark of [false, true]) {
    const look = `${width}${dark ? "-dark" : ""}`
    await flow(`mcps-catalogue-${look}`, run, {
      viewport: { width, height: width < 768 ? 844 : 768 },
      dark,
    })
  }
}
pass(
  "the Bot's Add action opens Hermes's Catalogue with every entry and each one this Bot already has marked Added, a search narrows it by name and by what Hermes says an entry is, a search that matches nothing says so, reopening shows every entry again, and nothing is added, at 390 and 1024px, light and dark",
)
