// The list beside what it opened, for Meetings and Research: one pane on a phone and on a tablet in
// portrait, two on a tablet in landscape with the sidebar as a rail, one again with the sidebar
// open, and the list beside the item (the sidebar a third pane) from 1280px. The item pane opens the
// one opened last, and New research asks in it. With no console errors.
import { app, assert, flow, pass } from "./lib.mjs"

const errors = []
// [width, sidebar collapsed, panes]
const CASES = [
  [390, false, 1],
  [820, true, 1],
  [1024, false, 1],
  [1024, true, 2],
  [1280, false, 2],
  [1280, true, 2],
  [1440, false, 2],
]

for (const [width, collapsed, panes] of CASES) {
  await flow(
    `panes-${width}${collapsed ? "-rail" : ""}`,
    async ({ page, shot: take }) => {
      const shot = async (step) => {
        await page.waitForTimeout(400)
        return take(step)
      }
      page.on("pageerror", (error) => errors.push(`${width}: ${error.message}`))
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(`${width}: ${message.text()}`)
      })
      const look = `${width}${collapsed ? " with the rail" : ""}`
      await page.evaluate(
        async (collapsed) =>
          (await import("/src/lib/db.ts")).db.settings.update("settings", {
            developer: true,
            meetings: true,
            sidebarCollapsed: collapsed,
          }),
        collapsed,
      )

      // Meetings: with room the top meeting opens beside the list.
      await page.goto(`${app}/meetings`)
      await page.getByText("Weekly product sync").first().waitFor({ timeout: 15_000 })
      if (panes === 2) {
        await page.waitForURL("**/meetings/m_*", { timeout: 5_000 })
        await shot("meetings")
        assert.equal(await page.getByRole("button", { name: "Back to Meetings" }).count(), 0)
        // Opening another takes the place of the one open, and it's the one open next time.
        const first = page.url()
        await page.getByText("Landing page review").first().click()
        await page.waitForURL((url) => url.href !== first)
        const last = page.url()
        await page.waitForFunction(
          ([key, id]) => localStorage.getItem(key) === id,
          ["memento:last-meetings", last.split("/").at(-1)],
        )
        await page.goto(`${app}/meetings`)
        await page.waitForURL(last, { timeout: 5_000 })
        pass(`${look}: meetings list beside the meeting, reopening the last one`)
      } else {
        assert.equal(new URL(page.url()).pathname, "/meetings", "stays on the list")
        await shot("meetings")
        pass(`${look}: meetings is one pane`)
      }

      // Research.
      await page.goto(`${app}/research`)
      await page.getByText("How transformers work").first().waitFor({ timeout: 15_000 })
      if (panes === 2) {
        await page.waitForURL("**/research/*", { timeout: 5_000 })
        await shot("research")
        assert.equal(await page.getByRole("button", { name: "Back to Research" }).count(), 0)
        const first = page.url()
        await page.getByRole("button", { name: /What kidneys do/ }).click()
        await page.waitForURL((url) => url.href !== first)
        const last = page.url()
        await page.waitForFunction(
          ([key, id]) => localStorage.getItem(key) === id,
          ["memento:last-research", last.split("/").at(-1)],
        )
        await page.goto(`${app}/research`)
        await page.waitForURL(last, { timeout: 5_000 })
        // New research asks in the item pane, beside the list.
        await page.getByRole("button", { name: "New research" }).click()
        await page.getByRole("textbox", { name: "What to research" }).waitFor({ timeout: 5_000 })
        assert.equal(new URL(page.url()).pathname, "/research")
        await shot("research-new")
        pass(`${look}: research list beside the mission, New research asks beside it`)
      } else {
        assert.equal(new URL(page.url()).pathname, "/research", "stays on the list")
        await page.getByRole("textbox", { name: "What to research" }).waitFor()
        await shot("research")
        pass(`${look}: research is one pane`)
      }
    },
    { viewport: { width, height: width < 768 ? 844 : 900 } },
  )
}

const real = errors.filter((e) => !/Failed to load resource|CORS policy/.test(e))
assert.deepEqual(real, [], "no console errors")
pass("no console errors")
