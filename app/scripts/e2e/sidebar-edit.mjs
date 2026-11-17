// The sidebar's edit mode arranged by the pointer: a row dragged by its own grip past its neighbour
// and dropped — sent as real pointer events, so the gesture's capture and the grip's `touch-action`
// decide what happens, not a handler's own idea of it — the order read back off the nav, a reload
// reading the same order again, and the same drag with a finger in the phone's drawer.
import { app, assert, flow, pass, settled, swipeBy } from "./lib.mjs"

/** A box's middle in the page's own px, and the height a drag has to cross to take a row's place. */
const boxOf = (locator) =>
  locator.evaluate((el) => {
    const box = el.getBoundingClientRect()
    return {
      x: Math.round(box.left + box.width / 2),
      y: Math.round(box.top + box.height / 2),
      height: Math.round(box.height),
    }
  })

/** The rows the mode draws, by the id the account's record files them under. */
const modeRows = (page) =>
  page
    .locator("[data-sidebar-row]")
    .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-sidebar-row")))

/** The rows the resting sidebar draws, by address: what a reader presses, in the order they meet it. */
const navRows = (page) =>
  page
    .locator('nav[aria-label="Main"] a')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute("href")))

/** One row's grip — the pointer's way into the order. */
const gripOf = (page, id) => page.locator(`[data-sidebar-row="${id}"] [data-sidebar-grip]`)

/** Opens the mode and answers the rows it drew, so the drag's before and after can be compared. */
async function openMode(page) {
  await page.getByRole("button", { name: "Edit sidebar" }).click()
  await page.locator("[data-sidebar-row]").first().waitFor({ timeout: 5_000 })
  await gripOf(page, "projects").waitFor({ timeout: 5_000 })
  return modeRows(page)
}

/** What the drag left: the first two rows swapped, and every other row where it stood. */
const swapped = (before) => [before[1], before[0], ...before.slice(2)]

await flow(
  "sidebar-edit-docked",
  async ({ page, shot }) => {
    await page.goto(`${app}/code`)
    await page.getByRole("link", { name: "Code" }).first().waitFor({ timeout: 15_000 })
    const atRest = await navRows(page)
    assert.deepEqual(
      atRest.slice(0, 2),
      ["/projects", "/code"],
      "today's order, the two rows this drag moves between",
    )
    assert.equal(
      await page.locator("[data-sidebar-grip]").count(),
      0,
      "a sidebar at rest draws no grip",
    )

    const before = await openMode(page)
    await shot("editing")

    // The gesture: press the grip, carry the row over its neighbour, and let go. The row is lifted
    // and the place it would land is marked while the button is still down.
    const grip = await boxOf(gripOf(page, "projects"))
    const neighbour = await boxOf(page.locator('[data-sidebar-row="code"]'))
    await page.mouse.move(grip.x, grip.y)
    await page.mouse.down()
    await page.mouse.move(grip.x, grip.y + Math.round(neighbour.height / 2), { steps: 4 })
    await page.mouse.move(neighbour.x, neighbour.y, { steps: 6 })
    assert.equal(
      await page.locator('[data-sidebar-row="projects"]').getAttribute("data-dragging"),
      "",
      "the row lifts under the pointer",
    )
    assert.equal(
      await page.locator('[data-sidebar-row="code"]').getAttribute("data-drop-at"),
      "",
      "and the place it would take is marked under it",
    )
    await shot("dragging")
    await page.mouse.up()
    await settled(page)

    // One write on release: the mode draws the drop, and the order reads the same way it will rest.
    assert.deepEqual(await modeRows(page), swapped(before), "the row took its neighbour's place")
    assert.equal(
      await page.locator("[data-sidebar-row] [data-dragging]").count(),
      0,
      "nothing is left lifted once the gesture is over",
    )
    assert.equal(
      await page.locator("[data-sidebar-row] [data-drop-at]").count(),
      0,
      "and no place is marked",
    )
    await shot("dropped")

    // A gesture given up writes nothing, whichever way it is given up: the account's record is read
    // before and after each, and neither a drag let go of outside the list nor one Escape cuts short
    // may leave a mark on it.
    const stored = () =>
      page.evaluate(async () => {
        const { db } = await import("/src/lib/db.ts")
        return (await db.settings.get("settings"))?.sidebarLayout ?? null
      })
    const written = await stored()

    const carried = await boxOf(gripOf(page, "projects"))
    const outside = await boxOf(page.locator('[data-sidebar-row="research"]'))
    await page.mouse.move(carried.x, carried.y)
    await page.mouse.down()
    await page.mouse.move(outside.x, outside.y, { steps: 8 })
    assert.equal(
      await page.locator('[data-sidebar-row="projects"]').getAttribute("data-dragging"),
      "",
      "the row is in the air",
    )
    // Well off the sidebar's list, over the page the mode does not cover.
    await page.mouse.move(700, 400, { steps: 4 })
    await page.mouse.up()
    await settled(page)
    assert.deepEqual(await stored(), written, "a release outside the list writes nothing")
    assert.deepEqual(await modeRows(page), swapped(before), "and the row stands where it stood")

    const again = await boxOf(gripOf(page, "projects"))
    await page.mouse.move(again.x, again.y)
    await page.mouse.down()
    await page.mouse.move(again.x, again.y + neighbour.height, { steps: 8 })
    assert.equal(
      await page.locator('[data-sidebar-row="projects"]').getAttribute("data-dragging"),
      "",
      "a second gesture is in the air",
    )
    await page.keyboard.press("Escape")
    await page.mouse.up()
    await settled(page)
    assert.deepEqual(await stored(), written, "Escape during a drag writes nothing either")
    assert.deepEqual(
      await modeRows(page),
      swapped(before),
      "and the row stands where it stood, the mode still open on the list",
    )

    await page.getByRole("button", { name: "Done editing sidebar" }).click()
    await page.getByRole("link", { name: "Code" }).first().waitFor({ timeout: 5_000 })
    const resting = await navRows(page)
    assert.deepEqual(
      resting,
      ["/code", "/projects", ...atRest.slice(2)],
      "the sidebar a reader rests on draws the order the drag made",
    )
    await shot("resting")

    // The account carries it: the same order is read again after a reload.
    await page.reload()
    await page.getByRole("link", { name: "Code" }).first().waitFor({ timeout: 15_000 })
    assert.deepEqual(await navRows(page), resting, "the order survived the reload")
    await shot("reloaded")

    pass("A row dragged by its grip takes its neighbour's place, and stays there, at 1024px")
  },
  { viewport: { width: 1024, height: 768 } },
)

await flow(
  "sidebar-edit-phone",
  async ({ page, shot }) => {
    await page.goto(`${app}/code`)
    await page.getByRole("button", { name: "Open conversations" }).waitFor({ timeout: 15_000 })
    await page.getByRole("button", { name: "Open conversations" }).click()
    await page.getByRole("link", { name: "Code" }).first().waitFor({ timeout: 15_000 })
    const atRest = await navRows(page)
    assert.deepEqual(
      atRest.slice(0, 2),
      ["/projects", "/code"],
      "today's order in the drawer too, the two rows this drag moves between",
    )
    assert.equal(
      await page.locator("[data-sidebar-grip]").count(),
      0,
      "the drawer at rest draws no grip either",
    )

    const before = await openMode(page)
    await shot("editing")

    // A finger, through the browser's own input pipeline: the grip keeps the touch, so the list does
    // not scroll under the drag and the sheet does not go with it — everywhere else on the list
    // still swipes.
    const grip = await boxOf(gripOf(page, "projects"))
    const neighbour = await boxOf(page.locator('[data-sidebar-row="code"]'))
    await swipeBy(page, grip, neighbour.height)
    await settled(page)
    assert.deepEqual(
      await modeRows(page),
      swapped(before),
      "a finger drops the row in the place a mouse would",
    )

    await page.reload()
    await page.getByRole("button", { name: "Open conversations" }).waitFor({ timeout: 15_000 })
    await page.getByRole("button", { name: "Open conversations" }).click()
    await page.getByRole("link", { name: "Code" }).first().waitFor({ timeout: 15_000 })
    assert.deepEqual(
      await navRows(page),
      ["/code", "/projects", ...atRest.slice(2)],
      "and the drawer reads the same order from the account after a reload",
    )
    await shot("reloaded")

    pass(
      "A row dragged with a finger in the drawer takes its neighbour's place, and stays there, at 390px",
    )
  },
  { viewport: { width: 390, height: 844 }, touch: true },
)
