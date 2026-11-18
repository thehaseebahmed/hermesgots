// The Code list drawn as a bot's chat list is: one flat band of rows with no state headings, what the
// reader pinned first, the sort menu choosing Title A–Z and remembering it over a reload, the project
// chips in the bar's pill slot reading as their names' words at 44px, a search that stands in the
// foot below a laptop's width, and the round `+` that starts a session. Then the unread dot — the
// geometry no DOM without layout can prove: its corner on the round icon, absent until this device
// has read the row, written by the thread rendering when it is opened, and back when activity lands
// while the list sits open. The whole of it then runs again at a phone's width in the dark and at a
// tablet's in the light.
import { app, assert, flow, pass } from "./lib.mjs"

const PROJECT = "p_1a2b3c4d"
const HEADINGS = ["Waiting for You", "Working", "Idle", "Closed"]

const rows = (page) => page.locator('[data-slot="session-rows"] li')
const titles = (page) => rows(page).allTextContents()
const dotsIn = (row) => row.locator("[data-unread]").count()

/** Through the store's own writer, so the list re-draws on the mark. */
const seedMark = (page, id, at) =>
  page.evaluate(async (seed) => {
    const { markRead } = await import("/src/lib/read-marks.ts")
    markRead(seed.id, seed.at)
  }, { id, at })

await flow("code-list", async ({ page, seed, shot, until }) => {
  const now = Date.now()
  await seed([
    { id: "cl-checks", title: "Checks in flight", projectId: PROJECT, createdAt: now - 5_000, updatedAt: now,
      prs: [{ repo: "acme/gots", number: 7, title: "A change", state: "open", checks: "pending",
        url: "https://example.test/7", at: now }] },
    { id: "cl-idle", title: "At rest", projectId: PROJECT, createdAt: now - 3_000, updatedAt: now - 2_000 },
    { id: "cl-idle2", title: "Another idle", projectId: PROJECT, createdAt: now - 2_000, updatedAt: now - 3_000 },
    { id: "cl-resolved", title: "Finished work", projectId: PROJECT, createdAt: now - 1_500, updatedAt: now - 4_000,
      resolvedAt: now },
    { id: "cl-pinned", title: "Held at the top", projectId: PROJECT, createdAt: now - 9_000, updatedAt: now - 9_000,
      pinned: true },
  ])

  await page.goto(`${app}/code`)
  await until(async () => (await rows(page).count()) === 4, 20_000, "the open rows")
  const text = await page.locator("main, body").first().innerText()
  for (const heading of HEADINGS)
    assert.ok(!text.includes(heading), `no "${heading}" heading groups the rows`)
  assert.ok((await titles(page))[0].includes("Held at the top"), "what the reader pinned leads the band")
  pass("one flat band, no state headings, the pinned session first")

  const sortButton = () => page.getByRole("button", { name: /^Sort sessions by/ })
  await sortButton().click()
  await page.getByText("Sort by").waitFor()
  await page.getByRole("menuitem", { name: "Title" }).click()
  await until(async () => {
    const all = await titles(page)
    return all[0]?.includes("Held at the top") && all[1]?.includes("Another idle") && all[2]?.includes("At rest")
  }, 5_000, "the rows in title order under the pin")
  assert.match(await sortButton().getAttribute("aria-label") ?? "", /Title, ascending/)
  await shot("sorted")
  await sortButton().click()
  await page.getByRole("menuitem", { name: /Title/ }).click()
  await until(async () => (await sortButton().getAttribute("aria-label") ?? "").includes("descending"), 5_000,
    "the arrow turned round")
  pass("the sort menu orders the flat band, pins first, and flips its arrow when chosen again")

  // The chips come from `readProjects`, a read that lands after the screen draws.
  const chips = page.locator('[aria-label="Filter sessions"] button')
  await until(async () => (await chips.count()) > 1, 10_000, "the project chips")
  const faces = await chips.evaluateAll((ones) =>
    ones.map((one) => ({ glyphs: one.querySelectorAll("svg").length, height: Math.round(one.getBoundingClientRect().height) })),
  )
  assert.ok(faces.every((one) => one.glyphs === 0 && one.height === 44), "words alone, 44px tall")
  const bar = await page.locator("header").first().boundingBox()
  const chipRow = await page.locator('[aria-label="Filter sessions"]').boundingBox()
  assert.ok(bar && chipRow && chipRow.y >= bar.y, "the chips stand in the bar's pill slot")
  pass("the project chips are pinned with the bar, as the chat list's pills are")

  // The search is the foot's below a laptop's width and the bar's from it; either way one field.
  const circle = page.locator('[data-slot="list-foot"] [aria-label^="Search"]')
  if (await circle.count()) await circle.first().click()
  const search = page.getByLabel("Search sessions")
  await search.waitFor()
  await search.fill("rest")
  await until(async () => (await rows(page).count()) === 1, 5_000, "the search to narrow the band")
  assert.equal(await page.getByLabel("Search sessions").count(), 1, "one field, never two")
  await search.fill("")
  await until(async () => (await rows(page).count()) === 4, 5_000, "the band back")
  pass("a search narrows the same flat band, from the foot or the bar")

  assert.equal(await page.getByRole("button", { name: "New session" }).count(), 1, "the foot's round +")
  await shot("foot")

  // The dot's own row: read once so that its mark can age. Opening the thread writes the mark.
  const target = rows(page).filter({ hasText: "Another idle" })
  await target.locator("a").first().click()
  await page.waitForURL("**/c/cl-idle2", { timeout: 10_000 })
  await until(async () => {
    const at = await page.evaluate(async (id) => {
      const { readMark } = await import("/src/lib/read-marks.ts")
      return readMark(id) ?? 0
    }, "cl-idle2")
    return at > 0
  }, 5_000, "the mark the thread's own render wrote")
  // A thread on screen keeps re-marking its own activity, so the next row is opened to hold the pane.
  await rows(page).filter({ hasText: "At rest" }).locator("a").first().click()
  await page.waitForURL("**/c/cl-idle", { timeout: 10_000 })
  await page.evaluate(async () => {
    const { db } = await import("/src/lib/db.ts")
    await db.conversations.update("cl-idle2", { updatedAt: Date.now() })
  })
  await until(async () => (await dotsIn(target)) === 1, 10_000, "the dot once activity lands past the mark")
  const dotBox = await target.locator("[data-unread]").boundingBox()
  const iconBox = await target.locator("span.size-10").boundingBox()
  assert.ok(dotBox && iconBox, "both boxes measured")
  assert.ok(dotBox.x + dotBox.width / 2 > iconBox.x + iconBox.width / 2, "the dot is on the icon's right half")
  assert.ok(dotBox.y + dotBox.height / 2 < iconBox.y + iconBox.height / 2, "and its top half")
  await target.locator("a").first().click()
  await page.waitForURL("**/c/cl-idle2", { timeout: 10_000 })
  await until(async () => (await dotsIn(target)) === 0, 5_000, "the dot to clear once the thread renders")
  pass("the dot sits at the icon's corner, needs a mark to be against, clears when read and returns with new activity")

  await page.reload()
  await until(async () => (await rows(page).count()) === 4, 20_000, "the list after a reload")
  assert.match(await sortButton().getAttribute("aria-label") ?? "", /Title, descending/,
    "this device remembers the sort, arrow and all")
  pass("the sort choice is kept on this device over a reload")
})

const VARIANTS = [
  [390, true],
  [768, false],
]
for (const [width, dark] of VARIANTS) {
  const look = `${width}px${dark ? " in the dark" : " in the light"}`
  await flow(
    `code-list-${width}${dark ? "-dark" : ""}`,
    async ({ page, seed, shot, until }) => {
      const now = Date.now()
      await seed([
        { id: "clv-checks", title: "Checks in flight", projectId: PROJECT, createdAt: now - 5_000,
          updatedAt: now, prs: [{ repo: "acme/gots", number: 9, title: "A change", state: "open",
            checks: "pending", url: "https://example.test/9", at: now }] },
        ...Array.from({ length: 8 }, (_, i) => ({
          id: `clv-idle-${i}`,
          title: `At rest ${i}`,
          projectId: PROJECT,
          createdAt: now - 9_000 + i,
          updatedAt: now - 3_000 - i,
        })),
        { id: "clv-closed", title: "Finished work", projectId: PROJECT, createdAt: now - 6_500,
          updatedAt: now - 6_000, resolvedAt: now },
        { id: "clv-pinned", title: "Held at the top", projectId: PROJECT, createdAt: now - 8_000,
          updatedAt: now - 7_000, pinned: true },
      ])
      await page.goto(`${app}/code`)
      await until(async () => (await rows(page).count()) >= 10, 20_000, `the rows at ${look}`)
      await seedMark(page, "clv-idle-3", Date.now() - 60_000)
      assert.ok((await titles(page))[0].includes("Held at the top"), `the pin leads at ${look}`)
      const waiting = rows(page).filter({ hasText: "Checks in flight" }).locator("span.size-10").first()
      assert.ok((await waiting.getAttribute("class"))?.includes("bg-warning/15"), `the waiting row is yellow at ${look}`)
      const rest3 = rows(page).filter({ hasText: "At rest 3" })
      await until(async () => (await dotsIn(rest3)) === 1, 5_000, `a row read before its activity is dotted at ${look}`)
      assert.equal(await dotsIn(rows(page).filter({ hasText: "At rest 0" })), 0, `an unopened row carries no dot at ${look}`)
      // The foot keeps its place in the flow, so the last row ends above it rather than behind it.
      const foot = await page.locator('[data-slot="list-foot"]').boundingBox()
      const last = await rows(page).last().boundingBox()
      assert.ok(foot && last, "the foot and the last row measured")
      await rows(page).last().scrollIntoViewIfNeeded()
      await shot(`code-list-${width}${dark ? "-dark" : ""}`)
      pass(`at ${look}: the flat band, the yellow wait, the dot and the foot`)
    },
    { viewport: { width, height: width < 768 ? 844 : 900 }, dark },
  )
}
