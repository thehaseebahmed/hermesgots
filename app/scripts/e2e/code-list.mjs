// The Code list arranged by session state: the four groups in their fixed order under headings with
// their counts, empty groups absent until a session gives one, Closed collapsed and holding Resolved
// and Discarded told apart by their icons, the sort menu choosing Title A–Z and remembering it over a
// reload, and a search dropping the headers for one flat list in that same order. Then the unread
// dot — the geometry no DOM without layout can prove: its corner on the round icon, cleared by the
// thread rendering when the row is opened, and back when activity lands while the list sits open.
import { app, assert, flow, pass } from "./lib.mjs"

const PROJECT = "p_1a2b3c4d"
const ORDER = ["Waiting for You", "Working", "Idle", "Closed"]

const group = (page, label) => page.getByRole("region", { name: label, exact: true })

/** Every group heading on screen, in the order they draw, in the list's own vocabulary. */
const headings = (page) =>
  page.locator("section[aria-label]").evaluateAll((sections, wanted) => {
    const labels = sections.map((one) => one.getAttribute("aria-label") ?? "")
    return labels.filter((label) => wanted.includes(label))
  }, ORDER)

const countIn = async (page, label) => {
  const span = group(page, label).locator("h2 span").first()
  return (await span.count()) ? await span.innerText() : null
}

await flow("code-list", async ({ page, seed, shot, until }) => {
  const now = Date.now()
  await seed([
    { id: "cl-checks", title: "Checks in flight", projectId: PROJECT, createdAt: now - 5_000, updatedAt: now,
      prs: [{ repo: "acme/gots", number: 7, title: "A change", state: "open", checks: "pending",
        url: "https://example.test/7", at: now }] },
    { id: "cl-working", title: "Working turn", projectId: PROJECT, createdAt: now - 4_000, updatedAt: now - 1_000 },
    { id: "cl-idle", title: "At rest", projectId: PROJECT, createdAt: now - 3_000, updatedAt: now - 2_000 },
    { id: "cl-idle2", title: "Another idle", projectId: PROJECT, createdAt: now - 2_000, updatedAt: now - 3_000 },
    { id: "cl-resolved", title: "Finished work", projectId: PROJECT, createdAt: now - 1_500, updatedAt: now - 4_000,
      resolvedAt: now },
    { id: "cl-discarded", title: "Dropped work", projectId: PROJECT, createdAt: now - 1_000, updatedAt: now - 5_000,
      discardedAt: now },
  ])

  // The list opens with one session beside it (the untouched auto-open rule), which reads that
  // session here and so clears its dot; every other row stays as this device last left it.
  await page.goto(`${app}/code`)
  await until(async () => (await group(page, "Waiting for You").count()) > 0, 20_000, "the waiting group")

  assert.deepEqual(await headings(page), ["Waiting for You", "Idle", "Closed"],
    "the three groups with sessions, in order; Working has none, so it has no heading")
  assert.equal(await countIn(page, "Waiting for You"), "1", "the waiting count")
  assert.equal(await countIn(page, "Idle"), "3", "the idle count — the session with no message yet")
  assert.equal(await countIn(page, "Closed"), "2", "the closed count")
  pass("groups run Waiting for You, Idle, Closed with their counts, and the empty one stays hidden")

  // A turn starting elsewhere gives Working its session: it moves out of Idle and into the
  // heading between the others.
  await page.evaluate(async () => {
    const { db } = await import("/src/lib/db.ts")
    await db.messages.put({
      id: "cl-work-msg",
      conversationId: "cl-working",
      role: "assistant",
      content: "Working on it.",
      status: "streaming",
      createdAt: Date.now(),
    })
  })
  await until(async () => (await group(page, "Working").count()) > 0, 15_000, "the working group")
  assert.deepEqual(await headings(page), ORDER, "all four, in their fixed order")
  assert.equal(await countIn(page, "Working"), "1", "the working count")
  assert.equal(await countIn(page, "Idle"), "2", "the idle count, one session the fewer")
  pass("a running session sits in Working, whatever the clock says, and the empty heading appears")

  // Closed starts collapsed: its two sessions are out of sight until the heading is tapped, and
  // inside they sit side by side, the check and the archive saying which is which.
  const closed = group(page, "Closed")
  assert.equal(await closed.getByText("Finished work").isVisible(), false, "Closed starts collapsed")
  await closed.locator("h2 button").click()
  await until(async () => (await closed.getByText("Finished work").isVisible()), 5_000, "Closed to open")
  const glyph = async (row) =>
    (await row.locator("span.size-10 svg").first().getAttribute("class")) ?? ""
  assert.ok((await glyph(closed.locator("li").filter({ hasText: "Finished work" }))).includes("lucide-check"),
    "Resolved wears the check")
  assert.ok((await glyph(closed.locator("li").filter({ hasText: "Dropped work" }))).includes("lucide-archive-x"),
    "Discarded wears the archive")
  assert.equal(await closed.locator("[data-unread]").count(), 2,
    "both closed rows are dotted: neither has been read on this device")
  await shot("closed")
  pass("Closed collapses by default and holds Resolved and Discarded under their own icons, dotted")

  // The sort menu: Title A–Z turns the idle group over, and the choice survives a reload.
  await page.getByRole("button", { name: /^Sort sessions by/ }).click()
  await page.getByText("Sort by").waitFor()
  await page.getByRole("menuitemradio", { name: "Title A–Z" }).click()
  await until(async () => {
    const titles = await group(page, "Idle").locator("li").allTextContents()
    return titles[0]?.includes("Another idle") && titles[1]?.includes("At rest")
  }, 5_000, "the idle group in title order")
  assert.match(await page.getByRole("button", { name: /^Sort sessions by/ }).getAttribute("aria-label") ?? "",
    /Title A–Z/, "the menu says the choice it made")
  await shot("sorted")
  pass("the sort menu orders each group by title and says which order it chose")

  // Filtering: the headers drop away and one flat list runs in the chosen order.
  const search = page.getByLabel("Search sessions")
  await search.fill("work")
  await until(async () => (await group(page, "Idle").count()) === 0, 5_000, "the headers to drop")
  for (const label of ORDER) assert.equal(await group(page, label).count(), 0, `no ${label} while filtering`)
  const flat = await page.locator('a[href^="/c/"]').evaluateAll((links) =>
    links.map((link) => link.textContent ?? "").filter((text) => /Dropped work|Finished work|Working turn/.test(text)),
  )
  assert.equal(flat.length, 3, "the three sessions the search finds")
  assert.ok(flat[0]?.includes("Dropped work") && flat[1]?.includes("Finished work") &&
    flat[2]?.includes("Working turn"), "flat, in the chosen title order")
  await search.fill("")
  await until(async () => (await group(page, "Idle").count()) > 0, 5_000, "the headers back")
  pass("a search drops the group headers for one flat list in the same order")

  // The unread dot's corner: on the icon's top-right, which a DOM without layout cannot place.
  // It rides an idle session that never changes state and never opens before its turn.
  const idleRows = group(page, "Idle")
  const target = idleRows.locator("li").filter({ hasText: "Another idle" })
  const dot = target.locator("[data-unread]")
  await until(async () => (await dot.count()) > 0, 5_000, "the unread dot")
  const dotBox = await dot.boundingBox()
  const iconBox = await target.locator("span.size-10").boundingBox()
  assert.ok(dotBox && iconBox, "both boxes measured")
  assert.ok(dotBox.x + dotBox.width / 2 > iconBox.x + iconBox.width / 2,
    "the dot is on the icon's right half")
  assert.ok(dotBox.y + dotBox.height / 2 < iconBox.y + iconBox.height / 2,
    "the dot is on the icon's top half")
  assert.ok(dotBox.x + dotBox.width <= iconBox.x + iconBox.width + 6, "and hugs its right edge")
  assert.ok(dotBox.y >= iconBox.y - 6, "and its top edge")
  await shot("dot")

  // Opening the thread reads it: the mark is written where the thread rendered and the row, drawn
  // beside it, has nothing left to say. Then, with another session open, activity landing on the
  // one left behind dots it again without a reload.
  await target.locator("a").first().click()
  await page.waitForURL("**/c/cl-idle2", { timeout: 10_000 })
  await until(async () => (await dot.count()) === 0, 5_000,
    "the dot to clear once the thread renders")
  await idleRows.locator("li").filter({ hasText: "At rest" }).locator("a").first().click()
  await page.waitForURL("**/c/cl-idle", { timeout: 10_000 })
  await page.evaluate(async () => {
    const { db } = await import("/src/lib/db.ts")
    await db.conversations.update("cl-idle2", { updatedAt: Date.now() })
  })
  await until(async () => (await dot.count()) === 1, 10_000,
    "the dot to come back when activity lands")
  pass("the dot sits at the icon's corner, clears when the thread is read and returns with new activity")

  // The choice survives this device's own reload: the groups come back under their headings,
  // Closed folded again, and the rows still in title order. (The seeded streaming message does
  // not outlive the reload — the app reconciles it against the host — so it runs last.)
  await page.reload()
  await until(async () => (await group(page, "Idle").count()) > 0, 20_000, "the list after a reload")
  assert.match(await page.getByRole("button", { name: /^Sort sessions by/ }).getAttribute("aria-label") ?? "",
    /Title A–Z/, "this device remembers the sort")
  const reloaded = await group(page, "Idle").locator("li").allTextContents()
  assert.ok(reloaded[0]?.includes("Another idle"), "and the rows still run by it")
  assert.equal(await closed.getByText("Finished work").isVisible(), false, "Closed is folded again")
  pass("the sort choice is kept on this device and the groups come back folded after a reload")
})
