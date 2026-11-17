// The sidebar's edit mode arranged by the pointer: a row dragged by its own body — the whole row is
// the handle, so a mouse press anywhere on it takes the gesture — past its neighbour and dropped,
// sent as real pointer events, so the gesture's capture and the column's `touch-action` decide what
// happens, not a handler's own idea of it; the order read back off the nav, a reload reading the same
// order again, and the same drag with a finger in the phone's drawer, where a finger starts one only
// on the indicator column and Escape is the mode's one press and the sheet's the next. And the narrow
// column every row starts with, kept in both states: the row's mark and its height the same before and
// after the mode opens, and a bot's face starting where a feature's mark does — which only a laid-out
// page can say.
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

/** One row's grip — the indicator column's handle, and the keys' way into the order. */
const gripOf = (page, id) => page.locator(`[data-sidebar-row="${id}"] [data-sidebar-grip]`)

/**
 * Where a row's content starts, how wide the column before it is and how tall the row is: the mark's
 * left edge, the column's own box (zero where the row has none, which is every resting row) and the
 * row's. Read in both states, since what the column costs the row is the one thing about it only a
 * laid-out page can measure. The mark is the thing after the column, never the grip's glyph inside it.
 */
const leadingOf = (row) =>
  row.evaluate((el) => {
    const column = el.querySelector("[data-sidebar-gutter]")
    const mark = column ? column.nextElementSibling : el.firstElementChild
    const box = el.getBoundingClientRect()
    return {
      markX: Math.round(mark.getBoundingClientRect().left),
      column: column ? Math.round(column.getBoundingClientRect().width) : 0,
      height: Math.round(box.height),
    }
  })

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
    // No column at rest: the sidebar keeps the spacing it shipped with, and the mode brings its own.
    assert.equal(
      await page.locator('[data-sidebar-row="projects"] [data-sidebar-gutter]').count(),
      0,
      "and no column on a row at rest",
    )
    const leading = await leadingOf(page.locator('[data-sidebar-row="projects"]'))
    assert.equal(leading.column, 0, `the row has no column to spend (${leading.column}px)`)
    // One grid: a bot's face begins where a feature's mark does, in the same sidebar, at rest.
    const botFace = await leadingOf(page.getByRole("link", { name: "Test bot" }).first())
    assert.equal(
      botFace.markX,
      leading.markX,
      `a bot's face starts on the feature mark's x (${botFace.markX} against ${leading.markX})`,
    )

    const before = await openMode(page)
    await shot("editing")
    await settled(page)
    // The column has grown, and it is the only thing the mode spends on the row: 12px of it and the
    // 8px gap beside it, with the row's height untouched.
    const grown = await leadingOf(page.locator('[data-sidebar-row="projects"]'))
    assert.equal(grown.column, 12, `the column grows to 12px (${grown.column})`)
    assert.equal(
      grown.markX,
      leading.markX + 20,
      `and the mark moves 20px further in, the column and its gap (${grown.markX} against ${leading.markX})`,
    )
    assert.equal(grown.height, leading.height, "in a row of the same height")
    assert.equal(
      await page
        .locator('[data-sidebar-row="projects"] [data-sidebar-gutter] [data-sidebar-grip]')
        .count(),
      1,
      "with the grip standing in the resting row's empty column",
    )
    const arranged = await page.locator("[data-sidebar-row]").count()
    assert.equal(
      await page.locator("[data-sidebar-row] [data-sidebar-gutter]").count(),
      arranged,
      `one column on each of the ${arranged} rows the mode arranges, and none below the boundary`,
    )
    assert.equal(
      await page
        .getByRole("link", { name: "Test bot" })
        .first()
        .locator("[data-sidebar-gutter]")
        .count(),
      0,
      "a bot's row below the boundary carries none",
    )

    // The gesture: press the row's own body — not the column, and not a control, since the whole row
    // is the handle — carry it over its neighbour, and let go. The row is lifted and the place it
    // would land is marked while the button is still down.
    const carried = await boxOf(page.locator('[data-sidebar-row="projects"]'))
    const neighbour = await boxOf(page.locator('[data-sidebar-row="code"]'))
    await page.mouse.move(carried.x, carried.y)
    await page.mouse.down()
    assert.equal(
      await page.locator('[data-sidebar-row="projects"]').getAttribute("data-dragging"),
      "",
      "a press on the row's body lifts it, with no column pressed",
    )
    await page.mouse.move(carried.x, carried.y + Math.round(neighbour.height / 2), { steps: 4 })
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

    const body = await boxOf(page.locator('[data-sidebar-row="projects"]'))
    const outside = await boxOf(page.locator('[data-sidebar-row="research"]'))
    await page.mouse.move(body.x, body.y)
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

    const again = await boxOf(page.locator('[data-sidebar-row="projects"]'))
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

    pass("A row dragged by its body takes its neighbour's place, and stays there, at 1024px")
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
    // No column at rest in the drawer either: the sheet's list is the sidebar's list.
    await settled(page)
    const resting = await leadingOf(page.locator('[data-sidebar-row="projects"]'))
    assert.equal(resting.column, 0, `no column on a drawer row at rest (${resting.column}px)`)

    const before = await openMode(page)
    await shot("editing")
    await settled(page)
    // A box measured mid-animation is the animation's, not the row's: wait for the column to report
    // itself open before reading it.
    await page
      .locator('[data-sidebar-row="projects"] [data-sidebar-gutter][data-open]')
      .waitFor({ timeout: 5_000 })
    const leading = await leadingOf(page.locator('[data-sidebar-row="projects"]'))
    assert.equal(leading.column, 12, `the column grows to 12px at 390px too (${leading.column})`)
    assert.equal(
      leading.markX,
      resting.markX + 20,
      `and the mark moves the column and its gap (${leading.markX} against ${resting.markX})`,
    )

    // A finger, through the browser's own input pipeline: on the row's name it is the drawer's — the
    // list scrolls and the sheet swipes — and only the indicator column takes the gesture, its
    // `touch-action` keeping the touch out of both. So the drag is pressed there.
    const column = await boxOf(gripOf(page, "projects"))
    const neighbour = await boxOf(page.locator('[data-sidebar-row="code"]'))
    await swipeBy(page, column, neighbour.height)
    await settled(page)
    assert.deepEqual(
      await modeRows(page),
      swapped(before),
      "a finger on the column drops the row in the place a mouse would",
    )

    // Escape in the drawer is the mode's first: the press leaves it, its switch back at rest, and the
    // sheet the reader arranged in still stands over the screen. Only the press after that is the
    // sheet's, which is what a phone's back button does too (it sends Escape to the frontmost popup).
    await page.keyboard.press("Escape")
    await page.getByRole("button", { name: "Edit sidebar" }).waitFor({ timeout: 5_000 })
    assert.equal(
      await page.locator('[role="group"][aria-label="Sidebar layout"]').count(),
      0,
      "the press that left the mode took it with it",
    )
    assert.equal(
      await page.locator("[data-sidebar-grip]").count(),
      0,
      "and no grip is drawn at rest",
    )
    assert.equal(
      await page.locator('[role="dialog"][data-open]').count(),
      1,
      "and the drawer stayed open on the press the mode claimed",
    )
    assert.deepEqual(
      await navRows(page),
      ["/code", "/projects", ...atRest.slice(2)],
      "the drawer resting in the order the drag made",
    )
    await shot("escape-left-the-mode")

    await page.keyboard.press("Escape")
    await page.locator('[role="dialog"][data-open]').waitFor({ state: "detached", timeout: 5_000 })
    assert.equal(
      await page.locator('[role="dialog"][data-open]').count(),
      0,
      "the second press shut the drawer, as Escape closes a sheet",
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
      "A row dragged by its column with a finger takes its neighbour's place, and stays there, at 390px",
    )
  },
  { viewport: { width: 390, height: 844 }, touch: true },
)
