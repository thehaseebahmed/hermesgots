// AFK works the task it claimed in a session of its own. The host publishes the chat record that
// makes that session appear in Code, titled after the task and marked AFK, and opening it shows the
// run's first message — the issue and where it is, not the issue's text. The mock's sweep publishes
// the session the way the plugin does, so the whole thing is covered without GitHub. Phone and
// tablet, light and dark, with no console error.
import { app, assert, flow, makeProject, openAfk, pass } from "./lib.mjs"

const HELD = 265
const TITLE = "#265 The frontier is read from GitHub and listed"
const OPENER = "Implement Issue #265 (https://github.com/mock-user/memento/issues/265)"

const run = async ({ page, profileId, shot, until }) => {
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  const screen = `${app}/projects/${profileId}/${await makeProject(until, "AFK session")}`
  const control = () => page.getByRole("switch", { name: "Work on its own" })

  await openAfk(page, screen)
  await control().waitFor({ timeout: 15_000 })
  await control().click()
  await until(
    async () => (await control().getAttribute("aria-checked")) === "true",
    15_000,
    "the switch to read on",
  )

  await page.goto(`${app}/code`)
  const row = page.locator("a", { hasText: TITLE }).first()
  await row.waitFor({ timeout: 15_000 })
  assert.equal(
    await row.locator("[data-afk]").textContent(),
    "AFK",
    "the session is marked as AFK's where sessions are listed",
  )
  await shot("code")

  await row.click()
  await page.waitForURL("**/c/**")
  const messages = page.locator('[aria-label="Messages"]')
  await messages.getByText(OPENER, { exact: true }).first().waitFor({ timeout: 15_000 })
  assert.equal(
    await messages.getByText("The frontier is read from GitHub and listed", { exact: true }).count(),
    0,
    "the issue's title is the row's, not a message",
  )
  // Let the pane's slide-in finish, so the capture is the screen and not the move to it.
  await page.waitForTimeout(450)
  await shot("session")

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
  `AFK's claimed task (${HELD}) is worked in a session of its own: it appears in Code marked AFK, opens, and its first message names the issue and its url at 390 and 1024px, light and dark`,
)
