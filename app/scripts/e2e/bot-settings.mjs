// A bot's settings as a list of pages: at a laptop's width the list takes the pane the Settings menu
// had and a page swaps into the pane beside it, and on a phone the list and every page push over
// what opened them and back out through the same history. Where a pane sits and what a back press
// lands on are the two things no DOM test has — a render has no pane widths and no history stack —
// while what each page holds is `test-bot-*-tab.tsx`'s and what the list draws is
// `test-bot-settings-list.tsx`'s.
import { app, assert, flow, pass, settled } from "./lib.mjs"

/** The banner a bot whose plugin is behind wears over its list, verbatim. */
const BANNER = "This bot's plugin is out of date! Update it to 0.80.0 or newer."
/** One row's subtitle, so a row is proved to say what it holds rather than only to be there. */
const CODING = "Away From Keyboard and this bot's pick budget"
const PACES = [
  ["general", "General"],
  ["models", "Models"],
  ["coding", "Coding"],
]

/** A Settings row of the menu, which the bot's own list takes the place of. */
const menuRow = (page) => page.locator('a[href="/settings/appearance"]')

/** Puts the bot's plugin one release behind, so the list wears its banner without a Test connection. */
const seedPlugin = (page, profileId) =>
  page.evaluate(async (id) => {
    const { db } = await import("/src/lib/db.ts")
    await db.profiles.update(id, { pluginVersion: "0.79.0" })
  }, profileId)

/** Opens the Settings menu and answers the row naming the flow's bot. */
const openMenu = async (page, profileId) => {
  await page.goto(`${app}/settings`)
  const row = page.locator(`a[href="/settings/bots/${profileId}"]`)
  await row.waitFor({ timeout: 15_000 })
  await settled(page)
  assert.equal(await menuRow(page).count(), 1, "the Settings menu is what /settings opens")
  return row
}

/**
 * The bot's list of pages: drawn, wholly on screen, its rows there at both widths, and — the one
 * thing a browser is here for — the banner over them and a row's own words. Answers the list.
 */
const assertList = async (page, viewport) => {
  const list = page.locator("[data-bot-settings-list]")
  await list.waitFor({ timeout: 15_000 })
  await settled(page)
  const box = await list.boundingBox()
  assert.ok(box, "the bot's list of pages has a box")
  assert.ok(box.width > 0 && box.height > 0, "the list is drawn, not collapsed")
  assert.ok(
    box.x >= -1 && box.x + box.width <= viewport.width + 1,
    `the list is on screen at ${viewport.width}px (${Math.round(box.x)}…${Math.round(box.x + box.width)})`,
  )
  assert.equal(
    await list.getByText(BANNER, { exact: true }).count(),
    1,
    "the list wears the out-of-date plugin's banner, in its own words",
  )
  for (const [segment, title] of PACES) {
    const row = list.locator(`[data-bot-page="${segment}"]`)
    await row.waitFor({ timeout: 15_000 })
    assert.equal(await row.count(), 1, `${title} has a row in the list`)
  }
  assert.equal(
    await list.getByText(CODING, { exact: true }).count(),
    1,
    "Coding's row says what it holds, verbatim",
  )
  // The list has no headings at all now: its pages sit in cards separated by gaps (ADR 0055).
  assert.equal(
    await list.getByRole("heading").count(),
    0,
    "the list carries no headings — its groups are cards, not headings",
  )
  const cards = list.locator("[data-settings-group]")
  const count = await cards.count()
  assert.equal(count, 2, `General alone, then every other page, are two cards (${count})`)
  let previous = null
  for (let i = 0; i < count; i++) {
    const box = await cards.nth(i).boundingBox()
    assert.ok(box, `card ${i + 1} has a box`)
    if (previous) {
      assert.ok(
        box.y >= previous.y + previous.height + 4,
        `card ${i + 1} is separated from the one above by a gap (${Math.round(box.y)} over ${Math.round(previous.y + previous.height)})`,
      )
    }
    previous = box
  }
  return list
}

/** Whether two boxes are the same box, to a pixel — an animation or a reflow may leave a fraction. */
const same = (one, two) =>
  ["x", "y", "width", "height"].every((key) => Math.abs(one[key] - two[key]) <= 1)

/** ≥1024px: the menu's pane becomes the list, and a page swaps into the pane beside it. */
const wide = async ({ page, profileId, shot }) => {
  const viewport = page.viewportSize()
  assert.ok(viewport, "the page has a viewport")
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  await seedPlugin(page, profileId)
  const botRow = await openMenu(page, profileId)
  await shot("menu")

  await botRow.click()
  await page.waitForURL((url) => url.pathname === `/settings/bots/${profileId}`, {
    timeout: 15_000,
  })
  await settled(page)
  assert.equal(await menuRow(page).count(), 0, "the bot's list takes the Settings menu's pane")
  const list = await assertList(page, viewport)
  const before = await list.boundingBox()
  const kept = await list.elementHandle()
  assert.ok(before && kept, "the list is a box and an element of its own")

  const general = page.getByRole("heading", { level: 1, name: "General", exact: true })
  await general.waitFor({ timeout: 15_000 })
  const generalBox = await general.boundingBox()
  assert.ok(generalBox, "General's page has a box")
  assert.ok(
    before.x + before.width <= generalBox.x + 1,
    `General sits in the pane beside the list (list ends at ${Math.round(before.x + before.width)}, page starts at ${Math.round(generalBox.x)})`,
  )
  await shot("general")

  await list.locator('[data-bot-page="models"]').click()
  await page.waitForURL((url) => url.pathname === `/settings/bots/${profileId}/models`, {
    timeout: 15_000,
  })
  await settled(page)
  await page.getByRole("heading", { level: 1, name: "Models", exact: true }).waitFor({
    timeout: 15_000,
  })
  assert.equal(
    await page.getByRole("heading", { level: 1, name: "General", exact: true }).count(),
    0,
    "the pane beside the list swapped from General to Models",
  )
  assert.ok(
    await kept.evaluate((element) => element.isConnected),
    "the list is the same element it was",
  )
  assert.ok(await list.isVisible(), "the list is still on screen beside the page")
  const after = await list.boundingBox()
  assert.ok(after, "the list still has a box")
  assert.ok(same(before, after), "the list's box did not move while the pane beside it swapped")
  await shot("models")
  assert.deepEqual(errors, [], `no error on the page (${errors.join("; ")})`)
}

/** 390px: the list pushes over the menu, a page over the list, and back lands where it came from. */
const phone = async ({ page, profileId, shot }) => {
  const viewport = page.viewportSize()
  assert.ok(viewport, "the page has a viewport")
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  await seedPlugin(page, profileId)
  const botRow = await openMenu(page, profileId)
  await shot("menu")

  await botRow.click()
  await page.waitForURL((url) => url.pathname === `/settings/bots/${profileId}`, {
    timeout: 15_000,
  })
  await settled(page)
  assert.equal(await menuRow(page).count(), 0, "the list pushed over the Settings menu")
  const back = page.getByRole("button", { name: "Back", exact: true })
  await back.waitFor({ timeout: 15_000 })
  assert.ok(await back.isVisible(), "the list screen pushes with a back control")
  const list = await assertList(page, viewport)
  await shot("list")

  await list.locator('[data-bot-page="models"]').click()
  await page.waitForURL((url) => url.pathname === `/settings/bots/${profileId}/models`, {
    timeout: 15_000,
  })
  await settled(page)
  await page.getByRole("heading", { level: 1, name: "Models", exact: true }).waitFor({
    timeout: 15_000,
  })
  assert.ok(await back.isVisible(), "the page pushes with a back control of its own")
  assert.equal(
    await list.isVisible(),
    false,
    "the page covers the list rather than sitting beside it",
  )
  await shot("page")

  await page.goBack()
  await page.waitForURL((url) => url.pathname === `/settings/bots/${profileId}`, {
    timeout: 15_000,
  })
  await settled(page)
  assert.ok(await list.isVisible(), "back from the page returns to the list")
  assert.equal(
    await menuRow(page).count(),
    0,
    "back from the page does not skip the list for Settings",
  )
  await shot("back-to-list")

  await page.goBack()
  await page.waitForURL((url) => url.pathname === "/settings", { timeout: 15_000 })
  await settled(page)
  assert.equal(await menuRow(page).count(), 1, "back from the list returns to the Settings menu")
  assert.ok(await menuRow(page).isVisible(), "the menu is what back from the list draws")
  await shot("back-to-menu")
  assert.deepEqual(errors, [], `no error on the page (${errors.join("; ")})`)
}

for (const dark of [false, true]) {
  await flow(`bot-settings-1024${dark ? "-dark" : ""}`, wide, {
    viewport: { width: 1024, height: 768 },
    dark,
  })
}
for (const dark of [false, true]) {
  await flow(`bot-settings-390${dark ? "-dark" : ""}`, phone, {
    viewport: { width: 390, height: 844 },
    dark,
  })
}
pass(
  "a bot's settings is a list of pages with no headings anywhere: two caption-free cards separated by gaps under the out-of-date plugin's banner, General alone in the first and the other five pages in the second; at 1024px it takes the Settings menu's pane, General open in the pane beside it, and tap Models swaps that pane while the same list element stays put at the same box; on a 390px phone the list pushes over the menu and a page over the list, both with a back control, and back returns to the list and then to the menu — light and dark at both widths",
)
