// The list beside what it opened, for Meetings, Projects, Code, a bot's chats and Research: one pane
// on a phone and on a tablet in portrait, two on a tablet in landscape with the sidebar as a rail, one
// again with the sidebar open, and the list beside the item (the sidebar a third pane) from 1280px.
// The item pane opens the one opened last, New research asks in it, and New session picks the project
// of the chip in use. With no console errors.
import { app, assert, environmentNoise, flow, pass } from "./lib.mjs"

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
    async ({ page, profileId, seed, shot, until }) => {
      page.on("pageerror", (error) => errors.push(`${width}: ${error.message}`))
      page.on("console", (message) => {
        if (message.type() === "error" && !environmentNoise(message.text()))
          errors.push(`${width}: ${message.text()}`)
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
        // The panes settle a frame or two after the redirect: the sidebar's own answer is read
        // asynchronously, so the meeting can be drawn once as a phone's before the list comes
        // beside it. What "with room" means is the settled screen — the list in its lane, and no
        // Back to Meetings in the meeting's header — so both are waited for rather than caught
        // mid-paint. A screen that never gets its list still fails, naming what is missing.
        await until(
          async () => {
            const lane = page.locator('[data-slot="list-lane"]')
            if ((await lane.count()) !== 1) return false
            const width = await lane.evaluate((element) => element.getBoundingClientRect().width)
            return width > 0 && width < 600
          },
          5_000,
          "the meeting's list in its lane beside it",
        )
        await until(
          async () => (await page.getByRole("button", { name: "Back to Meetings" }).count()) === 0,
          5_000,
          "the meeting drawn beside its list, no Back to Meetings in its header",
        )
        await shot("meetings")
        assert.equal(await page.getByRole("button", { name: "Back to Meetings" }).count(), 0)
        // Opening another takes the place of the one open, and it's the one open next time.
        const first = page.url()
        await page.getByText("Landing page review").first().click()
        await page.waitForURL((url) => url.href !== first)
        const last = page.url()
        await page.waitForFunction(
          ([key, id]) => localStorage.getItem(key) === id,
          ["gots:last-meetings", last.split("/").at(-1)],
        )
        await page.goto(`${app}/meetings`)
        await page.waitForURL(last, { timeout: 5_000 })
        pass(`${look}: meetings list beside the meeting, reopening the last one`)
      } else {
        assert.equal(new URL(page.url()).pathname, "/meetings", "stays on the list")
        await shot("meetings")
        pass(`${look}: meetings is one pane`)
      }

      // Projects: with room the top project opens beside the list.
      await page.goto(`${app}/projects`)
      await page.getByText("Smart Home").first().waitFor({ timeout: 15_000 })
      if (panes === 2) {
        await page.waitForURL(`**/projects/${profileId}/p_*`, { timeout: 5_000 })
        await shot("projects")
        assert.equal(await page.getByRole("button", { name: "Back to Projects" }).count(), 0)
        const first = page.url()
        await page.getByRole("link", { name: /Maze/ }).click()
        await page.waitForURL((url) => url.href !== first)
        const last = page.url()
        await page.waitForFunction(
          ([key, id]) => localStorage.getItem(key) === id,
          ["gots:last-projects", `${profileId}/p_5e6f7a8b`],
        )
        await page.goto(`${app}/projects`)
        await page.waitForURL(last, { timeout: 5_000 })
        pass(`${look}: projects list beside the project, reopening the last one`)
      } else {
        assert.equal(new URL(page.url()).pathname, "/projects", "stays on the list")
        await shot("projects")
        pass(`${look}: projects is one pane`)
      }

      // Code: every project's sessions in one list.
      await seed([
        { id: "pane-gots", title: "Rotate the logs", projectId: "p_1a2b3c4d" },
        { id: "pane-maze", title: "Add a timer", projectId: "p_5e6f7a8b" },
      ])
      await page.goto(`${app}/code`)
      if (panes === 2) {
        await page.waitForURL("**/c/pane-*", { timeout: 15_000 })
        await page.getByRole("region", { name: "Idle" }).getByText("Add a timer").waitFor()
        await shot("code")
        assert.equal(await page.getByRole("button", { name: "Back to Code" }).count(), 0)
        const first = page.url()
        const other = first.endsWith("pane-gots") ? "Add a timer" : "Rotate the logs"
        await page.getByRole("region", { name: "Idle" }).getByText(other).click()
        await page.waitForURL((url) => url.href !== first)
        const last = page.url()
        await page.waitForFunction(
          ([key, id]) => localStorage.getItem(key) === id,
          ["gots:last-code", last.split("/").at(-1)],
        )
        await page.goto(`${app}/code`)
        await page.waitForURL(last, { timeout: 5_000 })
        pass(`${look}: code list beside the session, reopening the last one`)
      } else {
        await page.getByRole("region", { name: "Idle" }).getByText("Add a timer").waitFor()
        assert.equal(new URL(page.url()).pathname, "/code", "stays on the list")
        // A chip picks the project, and New session starts there.
        await page.getByRole("button", { name: "Maze", exact: true }).click()
        // The filter lands on the next render; reading the list at the click loses the race.
        await until(
          async () => (await page.getByText("Rotate the logs").count()) === 0,
          5_000,
          "the chip's filter to apply",
        )
        assert.equal(await page.getByText("Rotate the logs").count(), 0, "the chip filters")
        await page.getByRole("button", { name: "New session" }).click()
        const picked = page.getByRole("radio", { checked: true })
        await picked.waitFor({ timeout: 5_000 })
        assert.match(await picked.innerText(), /Maze/, "New session picks the chip's project")
        await shot("code-new")
        await page.keyboard.press("Escape")
        pass(`${look}: code is one pane, New session takes the chip's project`)
      }

      // A bot's own chats: the list keeps the 412px lane beside the chat it opened, and that chat
      // carries no way back; below that width the list is a screen the chat pushes.
      await seed([
        { id: "pane-lisbon", title: "Trip to Lisbon" },
        { id: "pane-garden", title: "Garden plan" },
      ])
      await page.goto(`${app}/b/${profileId}`)
      await page.getByText("Garden plan").first().waitFor({ timeout: 15_000 })
      const botChat = `/c/pane-garden`
      await page.locator(`main ul a[href="${botChat}"]`).click()
      await page.waitForURL(`**${botChat}`, { timeout: 15_000 })
      await until(
        async () =>
          (await page.evaluate(() => document.querySelector('[data-slot="header-title"]')?.textContent?.trim())) ===
          "Garden plan",
        15_000,
        "the chat's own title",
      )
      if (panes === 2) {
        const lane = await page.evaluate(() => {
          const list = document.querySelector('[data-slot="list-lane"]')
          const row = list?.querySelector('ul a[aria-current="page"]')
          return {
            width: list ? Math.round(list.getBoundingClientRect().width) : 0,
            open: row?.getAttribute("href") ?? null,
          }
        })
        assert.ok(
          Math.abs(lane.width - 412) <= 1,
          `the bot's list keeps its 412px lane beside the chat (${lane.width})`,
        )
        assert.equal(lane.open, botChat, "and marks the chat on screen as the open one")
        assert.equal(await page.getByRole("button", { name: "Back to Test bot" }).count(), 0)
        await shot("bot-chats")
        pass(`${look}: a bot's list beside its chat, the list's row marked open`)
      } else {
        assert.equal(await page.getByRole("button", { name: "Back to Test bot" }).count(), 1)
        await shot("bot-chats")
        pass(`${look}: a bot's list is the screen its chat pushes`)
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
          ["gots:last-research", last.split("/").at(-1)],
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
