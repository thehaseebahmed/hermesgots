// AFK works the task it claimed in a session of its own. The host publishes the chat record that
// makes that session appear in Code, titled after the task and marked AFK, and opening it shows the
// run's first message — one short line naming the task, not the brief. The mock's sweep publishes
// the session the way the plugin does, so the whole thing is covered without GitHub. Phone and
// tablet, light and dark, with no console error.
import { app, assert, flow, makeProject, openAfk, pass } from "./lib.mjs"

const HELD = 265
const TITLE = "#265 The frontier is read from GitHub and listed"
const BRIEF = "You are working this task while the user is away"

const run = async ({ page, profileId, shot, until }) => {
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  const screen = `${app}/projects/${profileId}/${await makeProject(until, "AFK session")}`
  const control = () => page.getByRole("switch", { name: "Work on its own" })

  // Turning it on has the host claim the oldest task and start the session that works it.
  await openAfk(page, screen)
  await control().waitFor({ timeout: 15_000 })
  await control().click()
  await until(
    async () => (await control().getAttribute("aria-checked")) === "true",
    15_000,
    "the switch to read on",
  )

  // The session appears where sessions are listed, titled after the task and marked as AFK's. The
  // mock keeps its chat list between flows, so an earlier pass of this flow's own session is there
  // too; the newest is this run's, and Code lists newest first.
  await page.goto(`${app}/code`)
  const row = page.locator("a", { hasText: TITLE }).first()
  await until(async () => (await row.count()) === 1, 15_000, "the AFK session to appear in Code")
  assert.equal(
    await row.locator("[data-afk]").textContent(),
    "AFK",
    "the session is marked as AFK's where sessions are listed",
  )
  await shot("code")

  // It opens, and the thread begins with the line naming the task — the brief isn't a message.
  await row.click()
  await page.waitForURL("**/c/**")
  const messages = page.locator('[aria-label="Messages"]')
  const opener = messages.getByText(TITLE, { exact: true }).first()
  await opener.waitFor({ timeout: 15_000 })
  assert.equal(
    await messages.getByText(BRIEF, { exact: false }).count(),
    0,
    "the task's brief arrives as the run's instructions, not as a message",
  )
  // Let the pane's slide-in finish, so the capture is the screen and not the move to it.
  await page.waitForTimeout(450)
  await shot("session")

  // The record carries the session's mode, which the app pushes back to the host's workspace — the
  // one the plugin made for the task — so nothing here is refused or ignored.
  assert.deepEqual(errors, [], `no console error (${errors.join("; ")})`)
}

for (const width of [390, 1024]) {
  for (const dark of [false, true]) {
    const look = `${width}${dark ? "-dark" : ""}`
    await flow(`afk-session-${look}`, run, {
      viewport: { width, height: width < 768 ? 844 : 768 },
      dark,
    })
  }
}
pass(
  `AFK's claimed task (${HELD}) is worked in a session of its own: it appears in Code marked AFK, opens, and its first message is the line naming the task at 390 and 1024px, light and dark`,
)
