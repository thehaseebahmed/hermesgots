// The sidebar's collapse button on the docked sidebar: it shrinks to an icon rail, hides the labels
// and the Bots heading, keeps an accessible name and a 44px target on every row, remembers the choice
// across a reload, and puts the width back; the phone drawer has no such button.
import { app, assert, flow, pass } from "./lib.mjs"

const asideWidth = (page) =>
  page.locator("aside").evaluate((el) => Math.round(el.getBoundingClientRect().width))

const waitForWidth = (page, width) =>
  page.waitForFunction(
    (want) => {
      const aside = document.querySelector("aside")
      return aside && Math.round(aside.getBoundingClientRect().width) === want
    },
    width,
    { timeout: 5_000 },
  )

/**
 * The rail's rows, as boxes, to prove each one is still a 44px touch target on the rail's centre.
 * Playwright hands back element handles that outlive detachment, and the sidebar's list re-renders
 * while it reads (a sweep's shared mock hands it chats this flow never seeded), so a row the app has
 * already removed comes back with no box; `connected` tells the two apart.
 */
const railRows = (page) =>
  page.locator("aside a, aside button").evaluateAll((rows) => {
    const rail = document.querySelector("aside").getBoundingClientRect()
    return rows.map((row) => {
      const box = row.getBoundingClientRect()
      return {
        name: row.getAttribute("aria-label") ?? row.textContent.trim(),
        connected: row.isConnected,
        width: Math.round(box.width),
        height: Math.round(box.height),
        offCentre: Math.round(box.left + box.width / 2 - (rail.left + rail.width / 2)),
      }
    })
  })

/** The rows the rail is showing: one the app has already removed is not a target anyone can press. */
const shownRows = (rows) => {
  const shown = rows.filter((row) => row.connected)
  const gone = rows.filter((row) => !row.connected)
  if (gone.length)
    console.log(
      `note: ${gone.length} row(s) the rail had removed: ${gone.map((r) => r.name).join(", ")}`,
    )
  return shown
}

for (const dark of [false, true]) {
  const look = dark ? "dark" : "light"
  await flow(
    `sidebar-collapse-${look}`,
    async ({ page, shot }) => {
      await page.goto(`${app}/code`)
      await page.getByRole("link", { name: "Code" }).first().waitFor({ timeout: 15_000 })
      // A tablet at lg: the docked sidebar is 320px before the button is pressed.
      assert.equal(await asideWidth(page), 320, "the sidebar starts at its full width")
      await shot("expanded")

      await page.getByRole("button", { name: "Collapse sidebar" }).click()
      await waitForWidth(page, 80)
      assert.equal(await asideWidth(page), 80, "the sidebar shrinks to the icon rail")

      // The wordmark, the heading and its sort control go; the rows keep their names for a reader.
      const aside = page.locator("aside")
      assert.equal(
        await aside.getByText("Bots", { exact: true }).count(),
        0,
        "the Bots heading is hidden",
      )
      assert.equal(
        await page.getByRole("button", { name: /^Sort bots by / }).count(),
        0,
        "the bots' sort control is hidden",
      )
      assert.equal(
        await aside.getByText("Gots", { exact: true }).count(),
        0,
        "the wordmark is hidden",
      )

      // Every destination is still there, still named, and still a 44px target.
      for (const name of ["Projects", "Code", "Research", "Routines", "Settings"]) {
        assert.equal(
          await page.getByRole("link", { name }).first().isVisible(),
          true,
          `${name} stays visible when collapsed`,
        )
      }
      for (const name of ["Search", "New chat", "Expand sidebar"]) {
        assert.equal(
          await page.getByRole("button", { name }).first().isVisible(),
          true,
          `${name} stays visible when collapsed`,
        )
      }
      const rows = await railRows(page)
      const shown = shownRows(rows)
      // A filter can't leave nothing to check: the rail always shows its destinations and its two
      // header controls at the least.
      assert.ok(shown.length >= 8, `the rail shows its rows: ${JSON.stringify(rows)}`)
      for (const row of shown) {
        assert.ok(
          row.width >= 44 && row.height >= 44,
          `row ${row.name} is 44px: ${JSON.stringify(row)}`,
        )
        // Every row sits on the rail's own centre line, whichever group it belongs to.
        assert.ok(
          Math.abs(row.offCentre) <= 1,
          `row ${row.name} is centred: ${JSON.stringify(row)}`,
        )
      }
      // The collapse control leads the rail, above Search.
      assert.equal(rows[0].name, "Expand sidebar", "the toggle is the top row")
      await shot("collapsed")

      // The choice is kept on the device: a reload comes back collapsed.
      await page.reload()
      await page.getByRole("link", { name: "Code" }).first().waitFor({ timeout: 15_000 })
      await waitForWidth(page, 80)
      assert.equal(await asideWidth(page), 80, "a reload comes back collapsed")

      await page.getByRole("button", { name: "Expand sidebar" }).click()
      await waitForWidth(page, 320)
      assert.equal(await asideWidth(page), 320, "the sidebar comes back")
      assert.equal(
        await aside.getByText("Gots", { exact: true }).count(),
        1,
        "the wordmark is back",
      )

      // With bot threads on, the Bots heading and its sort control go and the bots keep their icons.
      await page.evaluate(async () => {
        const { saveSettings } = await import("/src/lib/db.ts")
        await saveSettings({ developer: true, botThreads: true })
      })
      await page.reload()
      await page.getByRole("link", { name: "Test bot" }).first().waitFor({ timeout: 15_000 })
      assert.equal(
        await page.getByRole("button", { name: /^Sort bots by / }).count(),
        1,
        "the sort control is there while the sidebar is open",
      )
      await page.getByRole("button", { name: "Collapse sidebar" }).click()
      await waitForWidth(page, 80)
      assert.equal(
        await aside.getByText("Bots", { exact: true }).count(),
        0,
        "the Bots heading is hidden with bot threads on",
      )
      assert.equal(
        await page.getByRole("button", { name: /^Sort bots by / }).count(),
        0,
        "the bots' sort control is hidden with bot threads on",
      )
      assert.equal(
        await aside.getByRole("link", { name: "Test bot" }).first().isVisible(),
        true,
        "a bot keeps its icon",
      )
      assert.equal(
        await aside.getByRole("link", { name: "Link a bot" }).first().isVisible(),
        true,
        "Link a bot keeps its icon",
      )
      await shot("bots-collapsed")

      pass(`The sidebar collapses to an icon rail and back at 1024px, ${look}`)
    },
    { viewport: { width: 1024, height: 768 }, dark },
  )
}

for (const dark of [false, true]) {
  const look = dark ? "dark" : "light"
  await flow(
    `sidebar-collapse-phone-${look}`,
    async ({ page, shot }) => {
      await page.goto(`${app}/code`)
      await page.getByRole("button", { name: "Open conversations" }).waitFor({ timeout: 15_000 })
      assert.equal(await page.locator("aside").count(), 0, "phones have no docked sidebar")
      await page.getByRole("button", { name: "Open conversations" }).click()
      // The drawer is the full list: the wordmark is there and no collapse control ever is.
      await page.getByText("Gots", { exact: true }).first().waitFor({ timeout: 5_000 })
      assert.equal(
        await page.getByRole("button", { name: "Collapse sidebar" }).count(),
        0,
        "the drawer offers no collapse button",
      )
      assert.equal(
        await page.getByRole("button", { name: "Expand sidebar" }).count(),
        0,
        "the drawer offers no expand button",
      )
      // The sheet slides in: let it settle before the shot.
      await page.waitForTimeout(500)
      await shot("drawer")
      pass(`The phone drawer is always the full list, with no collapse button, ${look}`)
    },
    { viewport: { width: 390, height: 844 }, dark },
  )
}
