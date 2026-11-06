import { app, assert, flow, mock, mockAuth, mockPost, pass, runId, settled } from "./lib.mjs"

const PAGE = "[data-slot=app-page]"
const ROWS = "[aria-label=Apps] li"
const OFFLINE = "Offline — showing what this device last saw."
// The page column's own gutters: `px-4` either side, which the drawing inside it stops at.
const GUTTER = 16
const HOME = "Home"
const TITLE = `A garden of three beds ${runId()}`
const FIRST_PAGE = "The garden"
const CHANGED_PAGE = "The garden after the rain"
const WIDTHS = [390, 768]

/** What the open app has drawn, and where: one walk, so no two boxes are read a reflow apart. */
const drawing = (page) =>
  page.evaluate((selector) => {
    const column = document.querySelector(selector)
    const round = (value) => Math.round(value * 10) / 10
    if (!column) return null
    const card = column.querySelector("[data-slot=card]")
    const box = column.getBoundingClientRect()
    const drawn = card?.getBoundingClientRect()
    return {
      title: card?.querySelector("[data-slot=card-title]")?.textContent?.trim() ?? null,
      rows: column.querySelectorAll("tbody tr").length,
      charts: column.querySelectorAll("[data-slot=chart] svg").length,
      column: { left: round(box.left), right: round(box.right), width: round(box.width) },
      card: drawn ? { width: round(drawn.width), left: round(drawn.left) } : null,
      screen: window.innerWidth,
      sideways: document.documentElement.scrollWidth - window.innerWidth,
    }
  }, PAGE)

const drew = (page, until, title, what) =>
  until(async () => (await drawing(page))?.title === title, 30_000, what)

const titles = async (page) =>
  (await page.locator(ROWS).allInnerTexts()).map((row) => row.split("\n")[0].trim())

/**
 * Sends a change from the keyboard: the field's next stop is the Send, so Enter on it submits as a
 * press does — the path a reader without a pointer has.
 */
async function sendChange(page, text) {
  await page.getByLabel("Change this page").fill(text)
  await page.keyboard.press("Tab")
  assert.equal(
    await page.evaluate(() => document.activeElement?.getAttribute("aria-label")),
    "Send change",
    "the field's next stop is the page's Send",
  )
  await page.keyboard.press("Enter")
}

const openApp = (page, title) =>
  page.locator(ROWS).filter({ hasText: title }).getByRole("button").click()

/** The app the mock lists under a title, for the hidden mark a second device would write. */
async function hostApp(title) {
  const answer = await fetch(`${mock}/api/plugins/gots/apps`, { headers: mockAuth })
  assert.equal(answer.ok, true, `the mock's list answers (${answer.status})`)
  const listed = await answer.json()
  const found = listed.apps.find((one) => one.title === title)
  assert.ok(found, `the mock lists an app titled ${title}`)
  return found
}

/** Hides or shows a built-in app on the host, and says what the host answered when it refuses. */
async function setHidden(id, hidden) {
  const answer = await mockPost(`/api/plugins/gots/apps/${id}/hidden`, { hidden })
  assert.equal(answer.ok, true, `the host took hidden:${hidden} (${answer.status}: ${await answer.text()})`)
}

/** Builds an app from the list's `+`, agreeing to a page that calls no tools. */
async function build(page, until, prompt) {
  await page.getByRole("button", { name: "New app" }).click()
  const field = page.getByLabel("What should it be?")
  await field.waitFor({ timeout: 15_000 })
  await field.fill(prompt)
  await page.getByRole("button", { name: "Build" }).click()
  await page
    .getByText("This app calls no tools. It only shows what its pages hold.")
    .waitFor({ timeout: 20_000 })
  await page.getByRole("button", { name: "Save app" }).click()
  await until(
    async () => /\/apps\/[^/]+$/.test(new URL(page.url()).pathname),
    20_000,
    "the new app to open",
  )
  return new URL(page.url()).pathname.split("/").at(-1)
}

await flow(
  "apps",
  async ({ page, shot, until }) => {
    const host = new URL(mock).origin
    // Every write the app makes to a page, counted when the host has answered it: the claim this
    // flow makes is that a change is drawn before one lands, so a refusal would not count.
    const writes = []
    page.on("response", (response) => {
      if (
        response.request().method() === "POST" &&
        /\/apps\/[^/]+\/pages\//.test(response.url()) &&
        response.ok()
      )
        writes.push(response.url())
    })

    await page.goto(`${app}/apps`)
    const holds = async (title) => (await titles(page)).some((one) => one.startsWith(title))
    await until(() => holds("Tasks"), 20_000, "the built-in apps")
    assert.ok(await holds(HOME), "the bot's built-in apps are the list, read off its host")
    await shot("list")

    // A built-in app is an ordinary app: its root page draws, and a page whose server this host
    // hasn't got draws the sample its query declared — never an empty frame.
    await openApp(page, HOME)
    await drew(page, until, "The house at a glance", "the built-in dashboard to draw")
    await until(
      async () => (await drawing(page)).charts >= 1,
      20_000,
      "the page's chart to arrive with its library",
    )
    await settled(page)
    assert.equal(
      await page
        .getByText("Sample data: these numbers show the shape of the page, not your house.")
        .count(),
      1,
      "the page's own callout says the data is sample",
    )
    await shot("built-in")
    pass("a built-in app opens on its root page and draws its declared sample")

    await page.getByRole("button", { name: "Open the living room" }).click()
    await page.getByText("Ceiling light").waitFor({ timeout: 20_000 })
    await settled(page)
    assert.match(
      await page.locator(PAGE).innerText(),
      /Back to the house/,
      "the room's own page draws, with the way back on it",
    )
    await shot("built-in-page")
    await page.getByRole("button", { name: "Back to the house" }).click()
    await drew(page, until, "The house at a glance", "the root page to come back")
    pass("a page leads to another page of the same app, and back")

    await page.goto(`${app}/apps`)
    await until(() => holds(HOME), 15_000, "the list again")
    const id = await build(page, until, TITLE)
    await drew(page, until, FIRST_PAGE, "the new app to draw its page")
    await settled(page)
    assert.equal((await drawing(page)).rows, 3, "the table draws the rows the model answered")
    await shot("built")
    pass("an app built from the list's own prompt sheet opens on the page it answered")

    for (const width of WIDTHS) {
      if (width !== WIDTHS[0]) {
        await page.setViewportSize({ width, height: width < 768 ? 844 : 768 })
        await settled(page)
      }
      const at = `${width}px`
      const before = await drawing(page)
      assert.ok(
        Math.abs(before.card.width - (before.column.width - GUTTER * 2)) <= 1,
        `the drawing takes the page's own column at ${at} (${before.card.width}px of ${before.column.width}px)`,
      )
      assert.ok(
        before.column.left >= 0 && before.column.right <= before.screen,
        `and sits inside the screen at ${at}`,
      )
      assert.equal(before.sideways, 0, `the screen doesn't scroll sideways at ${at}`)

      // A change is drawn from the block as it arrives, before the page is written: the host holds
      // the block's fence open for a moment, and the screen draws the page it holds.
      const written = writes.length
      await sendChange(page, "Say it rained overnight")
      await until(
        async () => {
          const seen = await drawing(page)
          return seen?.title === CHANGED_PAGE && seen.rows === 2
        },
        30_000,
        `the changed page to draw as it arrives at ${at}`,
      )
      assert.equal(writes.length, written, `no page write had landed while it drew at ${at}`)
      await shot(`change-${width}`)
      pass(`a change streams into the page at ${at}, and no write had landed while it drew`)

      await until(async () => writes.length > written, 30_000, `the change to land at ${at}`)
      await page.getByRole("button", { name: "Undo" }).waitFor({ timeout: 20_000 })
      await settled(page)
      await shot(`changed-${width}`)

      // One step of undo, the host's: the page it replaced comes back, and nothing is left to undo.
      await page.getByRole("button", { name: "Undo" }).click()
      await drew(page, until, FIRST_PAGE, `the undo to draw the page it put back at ${at}`)
      await settled(page)
      assert.equal(
        await page.getByRole("button", { name: "Undo" }).count(),
        0,
        `one step of undo leaves nothing to undo at ${at}`,
      )
      assert.equal((await drawing(page)).rows, 3, `the replaced page's rows are back at ${at}`)
      await shot(`undone-${width}`)
      pass(`undo puts the page it replaced back at ${at}, and the control goes with it`)
    }

    // The host stopped: the app still opens on its root page, drawn from this device's own copy,
    // and says where it came from rather than failing or drawing an empty frame. The copy is read
    // out of this device first, so what the legs assert is a committed row and not a promise.
    await until(
      () =>
        page.evaluate(async (appId) => {
          const { db } = await import("/src/lib/db.ts")
          const rows = await db.appCache.toArray()
          return rows.some((row) => row.key.includes(`${appId}/`))
        }, id),
      10_000,
      "this device to have kept the page",
    )
    await page.route(`${host}/**`, (route) => route.abort("failed"))
    await page.goto(`${app}/apps/${id}`)
    await page.getByText(OFFLINE).waitFor({ timeout: 20_000 })
    await drew(page, until, FIRST_PAGE, "the cached page to draw")
    await settled(page)
    for (const width of WIDTHS) {
      if (width !== WIDTHS[0]) {
        await page.setViewportSize({ width, height: width < 768 ? 844 : 768 })
        await settled(page)
      }
      assert.equal(
        (await drawing(page)).rows,
        3,
        `every row of the page is drawn from the copy at ${width}px`,
      )
      await shot(`offline-${width}`)
    }

    await page.getByRole("button", { name: "Back to Apps" }).click()
    await until(() => holds(TITLE), 20_000, "the cached list")
    await page.getByText(OFFLINE).waitFor({ timeout: 20_000 })
    const names = await titles(page)
    assert.ok(
      [TITLE, HOME, "Tasks"].every((one) => names.some((row) => row.startsWith(one))),
      `the list this device last saw draws, offline (${names.join(", ")})`,
    )
    for (const width of WIDTHS) {
      if (width !== WIDTHS[0]) {
        await page.setViewportSize({ width, height: width < 768 ? 844 : 768 })
        await settled(page)
      }
      await page.getByText(OFFLINE).waitFor({ timeout: 20_000 })
      await shot(`offline-list-${width}`)
    }
    pass("with the host stopped the app and its list draw from this device")
    await page.unroute(`${host}/**`)

    // Hiding is the host's, not this device's: what a hidden built-in leaves is every list, and
    // what it keeps is the record — nothing is deleted.
    const home = await hostApp(HOME)
    await setHidden(home.id, true)
    await page.goto(`${app}/apps`)
    await until(
      async () => (await holds(TITLE)) && !(await holds(HOME)),
      20_000,
      "the list without the hidden app",
    )
    const shown = await titles(page)
    assert.ok(
      shown.some((one) => one.startsWith("Tasks")) && !shown.some((one) => one.startsWith(HOME)),
      `a built-in the host hid is offered to nobody (${shown.join(", ")})`,
    )
    await shot(`hidden-${WIDTHS[0]}`)
    await page.setViewportSize({ width: 768, height: 768 })
    await settled(page)
    await shot(`hidden-${WIDTHS[1]}`)

    await setHidden(home.id, false)
    await page.goto(`${app}/apps`)
    await until(() => holds(HOME), 20_000, "the app to come back")
    pass("a hidden built-in leaves the list the host answers, and hiding deletes nothing")
  },
  { viewport: { width: WIDTHS[0], height: 844 } },
)
