// A bot's settings as a list of pages: at a laptop's width the list takes the pane the Settings menu
// had and a page swaps into the pane beside it, and on a phone the list and every page push over
// what opened them and back out through the same history. Where a pane sits and what a back press
// lands on are the two things no DOM test has — a render has no pane widths and no history stack —
// while what each page holds is `test-bot-*-tab.tsx`'s and what the list draws is
// `test-bot-settings-list.tsx`'s.
import { app, assert, flow, pass, settled } from "./lib.mjs"

/** The banner a bot whose plugin is behind wears over its list, verbatim, for the app's own floor. */
const bannerOf = (page) =>
  page.evaluate(async () => {
    const { MIN_PLUGIN_VERSION } = await import("/src/lib/version.ts")
    return `This bot's plugin is out of date! Update it to ${MIN_PLUGIN_VERSION} or newer.`
  })
/** One row's subtitle, so a row is proved to say what it holds rather than only to be there. */
const CODING = "Away From Keyboard and this bot's pick budget"
const PACES = [
  ["general", "General"],
  ["models", "Models"],
  ["coding", "Coding"],
  ["delegation", "Delegation"],
]

/** A Settings row of the menu, which the bot's own list takes the place of. */
const menuRow = (page) => page.locator('a[href="/settings/appearance"]')

/**
 * Puts the bot's plugin behind the app's floor before the page first draws, so the banner is there the
 * moment the list is. The page then writes the version its host answers — the mock's own 0.29.1, which
 * is behind `MIN_PLUGIN_VERSION` too — so the banner stands on the host's answer, and the seed only
 * spares the flow the beat before that answer lands.
 */
const seedPlugin = (page, profileId) =>
  page.evaluate(async (id) => {
    const { db } = await import("/src/lib/db.ts")
    await db.profiles.update(id, { pluginVersion: "0.1.0" })
  }, profileId)

/**
 * A second bot on the device, so the bot on screen is one this device could be left without: the
 * delete at its foot is a live control rather than the off one a lone unlinked bot wears.
 */
const seedSibling = (page) =>
  page.evaluate(async () => {
    const { db } = await import("/src/lib/db.ts")
    const [profile] = await db.profiles.toArray()
    await db.profiles.add({ ...profile, id: `${profile.id}-sibling`, name: "Sibling bot" })
  })

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
 * The banner's icon on its text: the alert centres the icon in the rows the text takes rather than
 * lining it up with the first line, and that is a fact only a browser with layout can measure
 * (ADR 0019). The banner's words take two lines at both widths the flow runs, so the centres are
 * compared where the text is taller than one line: a pixel apart at most — the icon spans the text's
 * row and the empty one under it, so half the grid's 2px row gap is the one pixel — and both numbers
 * are printed, so a regression reads as a number.
 */
const assertBannerCentred = async (list, words) => {
  const banner = list.locator('[data-slot="alert"]').filter({ hasText: words })
  assert.equal(await banner.count(), 1, "the out-of-date banner is one alert")
  const { icon, text } = await banner.evaluate((element) => {
    const middle = (node) => {
      if (!node) return null
      const box = node.getBoundingClientRect()
      return box.top + box.height / 2
    }
    return {
      icon: middle(element.querySelector(":scope > svg")),
      text: middle(element.querySelector('[data-slot="alert-description"]')),
    }
  })
  assert.ok(icon !== null, "the banner draws its icon")
  assert.ok(text !== null, "the banner draws its text")
  assert.ok(
    Math.abs(icon - text) <= 1,
    `the banner's icon is centred on its text (${icon.toFixed(1)} against ${text.toFixed(1)})`,
  )
}

/**
 * The page's foot, which only a browser with layout can prove (ADR 0019): *Delete bot* sits under the
 * last card, inside the column the page's captions and cards stand in, with nothing of that column
 * below it — and no header on the screen carries a delete control, since the trash that used to live
 * there is this button now. The column is the page's own (`[data-bot-settings-list]`), not the pane
 * beside it, so the button's box has to fall inside the column's own.
 */
const assertDeleteAtFoot = async (page, column) => {
  const remove = column.getByRole("button", { name: "Delete bot", exact: true })
  assert.equal(await remove.count(), 1, "the page carries one button reading Delete bot")
  // One on the screen, not one in the column: a second control anywhere else — a row, a card, the
  // pane beside — is a second answer to where a bot is deleted.
  assert.equal(
    await page.getByRole("button", { name: "Delete bot", exact: true }).count(),
    1,
    "and it is the page's only one",
  )
  assert.equal(
    await remove.isDisabled(),
    false,
    "the device holds a bot to fall back on, so the control is live",
  )
  assert.equal(
    await page.locator("header").getByRole("button", { name: /delete|remove/i }).count(),
    0,
    "and no header carries a delete control",
  )
  const cards = column.locator("[data-settings-group]")
  const last = await cards.nth((await cards.count()) - 1).boundingBox()
  assert.ok(last, "the page's last card has a box")
  const geometry = await column.evaluate((element) => {
    const box = (node) => {
      const rect = node.getBoundingClientRect()
      return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right }
    }
    const button = [...element.querySelectorAll("button")].find(
      (one) => (one.textContent ?? "").trim() === "Delete bot",
    )
    if (!button) return null
    const at = box(button)
    const below = [...element.querySelectorAll("*")].filter(
      (node) => !button.contains(node) && box(node).bottom > at.bottom + 1,
    )
    return { button: at, column: box(element), below: below.map((node) => node.tagName) }
  })
  assert.ok(geometry, "the button is inside the page's own column")
  assert.ok(
    geometry.button.top >= last.y + last.height,
    `the button's top is below the last card's bottom (${Math.round(geometry.button.top)} over ${Math.round(last.y + last.height)})`,
  )
  assert.ok(
    geometry.button.left >= geometry.column.left - 1 &&
      geometry.button.right <= geometry.column.right + 1,
    `the button is inside the column's own width (${Math.round(geometry.button.left)}…${Math.round(geometry.button.right)} in ${Math.round(geometry.column.left)}…${Math.round(geometry.column.right)})`,
  )
  assert.deepEqual(
    geometry.below,
    [],
    `nothing in the column sits below the button (${geometry.below.join(", ")})`,
  )
  assert.ok(
    Math.abs(geometry.column.bottom - geometry.button.bottom) <= 1,
    `the column ends on the button (${geometry.column.bottom.toFixed(1)} against ${geometry.button.bottom.toFixed(1)})`,
  )

  // A live control is one that does something: the tap asks first, in the words the bot's kind
  // settled, and a cancel leaves the bot where it was. A disabled or dead button would pass every
  // number above, so the tap is the proof that the foot is a control and not a label.
  await remove.click()
  const dialog = page.locator('[role="alertdialog"]')
  await dialog.waitFor({ timeout: 15_000 })
  assert.equal(
    (await dialog.locator('[data-slot="alert-dialog-title"]').textContent())?.trim(),
    "Delete Test bot?",
    "the tap asks first, naming the bot",
  )
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
  await dialog.waitFor({ state: "detached", timeout: 15_000 })
  await settled(page)
  assert.equal(
    await page.locator("[data-bot-settings-list]").count(),
    1,
    "and cancelling leaves the bot's page where it was",
  )
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
  const banner = await bannerOf(page)
  assert.equal(
    await list.getByText(banner, { exact: true }).count(),
    1,
    "the list wears the out-of-date plugin's banner, in its own words",
  )
  await assertBannerCentred(list, banner)
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
  const cards = list
    .locator("[data-settings-group]")
    .filter({ has: page.locator("[data-bot-page]") })
  const count = await cards.count()
  assert.equal(count, 1, `every settings page is one card (${count})`)
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
  await seedSibling(page)
  const botRow = await openMenu(page, profileId)
  await shot("menu")

  await botRow.click()
  await page.waitForURL((url) => url.pathname === `/settings/bots/${profileId}`, {
    timeout: 15_000,
  })
  await settled(page)
  assert.equal(await menuRow(page).count(), 0, "the bot's list takes the Settings menu's pane")
  const list = await assertList(page, viewport)
  await assertDeleteAtFoot(page, list)
  const top = await list.boundingBox()
  const kept = await list.elementHandle()
  assert.ok(top && kept, "the list is a box and an element of its own")

  const general = page.getByRole("heading", { level: 1, name: "General", exact: true })
  await general.waitFor({ timeout: 15_000 })
  const generalBox = await general.boundingBox()
  assert.ok(generalBox, "General's page has a box")
  assert.ok(
    top.x + top.width <= generalBox.x + 1,
    `General sits in the pane beside the list (list ends at ${Math.round(top.x + top.width)}, page starts at ${Math.round(generalBox.x)})`,
  )
  await shot("general")

  // The click's own scroll moves the list's box: the pane holds more rows than a laptop's height, so
  // reaching Models scrolls it. The box the swap is measured from is taken with the row already in
  // view, and the scroll itself is asserted, so what the swap is judged on is its own doing.
  const models = list.locator('[data-bot-page="models"]')
  const scrolledTo = () =>
    list.evaluate((element) => {
      // The pane the rows scroll in is the list's own column, not the list: ask the ancestor that
      // actually scrolls, so the number is the reader's place rather than an always-zero element.
      for (let node = element.parentElement; node; node = node.parentElement)
        if (node.scrollHeight > node.clientHeight + 1) return node.scrollTop
      return 0
    })
  await models.scrollIntoViewIfNeeded()
  await settled(page)
  const before = await list.boundingBox()
  const scroll = await scrolledTo()
  assert.ok(before, "the list has a box to hold its place by")
  assert.ok(scroll > 0, `reaching Models scrolled the list's pane (${scroll}px)`)
  await models.click()
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
  assert.equal(await scrolledTo(), scroll, "and the swap left that scroll where it was")
  const after = await list.boundingBox()
  assert.ok(after, "the list still has a box")
  assert.ok(same(before, after), "the list's box did not move while the pane beside it swapped")
  await shot("models")

  await page.goto(`${app}/settings/dictation`)
  await page.getByRole("tab", { name: "Bots" }).waitFor({ timeout: 15_000 })
  await page.getByRole("tab", { name: "Bots" }).click()
  const fromSection = page.locator("[data-dictation-bot]").first()
  await fromSection.waitFor({ timeout: 15_000 })
  await fromSection.click()
  await page.waitForURL((url) => url.pathname.startsWith(`/settings/bots/${profileId}/`), {
    timeout: 15_000,
  })
  await settled(page)
  await page.getByRole("button", { name: "Back", exact: true }).click()
  await page.waitForURL((url) => url.pathname === "/settings/dictation", { timeout: 15_000 })
  await settled(page)
  assert.ok(
    await page.getByRole("heading", { level: 1, name: "AI Dictation", exact: true }).isVisible(),
    "back from a bot's page opened in AI Dictation returns to AI Dictation",
  )
  await shot("back-to-section")

  assert.deepEqual(errors, [], `no error on the page (${errors.join("; ")})`)
}

/** 390px: the list pushes over the menu, a page over the list, and back lands where it came from. */
const phone = async ({ page, profileId, shot }) => {
  const viewport = page.viewportSize()
  assert.ok(viewport, "the page has a viewport")
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  await seedPlugin(page, profileId)
  await seedSibling(page)
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
  await assertDeleteAtFoot(page, list)
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
  "a bot's settings is a list of pages with no headings anywhere: the bot's own rows above one card holding every settings page, the cards separated by gaps under the out-of-date plugin's banner and its icon centred on that banner's text, and one Delete bot at the foot of the column under the last card with nothing below it, no delete control in the header, and a tap that opens the confirm a cancel leaves; at 1024px it takes the Settings menu's pane, General open in the pane beside it, and tap Models swaps that pane while the same list element stays put at the same box; on a 390px phone the list pushes over the menu and a page over the list, both with a back control, and back returns to the list and then to the menu; and a page opened from AI Dictation's Bots tab comes back to AI Dictation, not to the menu, at 1024px — light and dark at both widths",
)
