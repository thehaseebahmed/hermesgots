// AFK works the task it claimed in a session of its own. The host publishes the chat record that
// makes that session appear in Code, titled after the task and marked AFK, and opening it shows the
// run's first message — the issue itself: its title, its description and a link. The mock's sweep publishes
// the session the way the plugin does, so the whole thing is covered without GitHub. Phone and
// tablet, light and dark, with no console error.
import { afkOn, app, assert, flow, makeProject, pass } from "./lib.mjs"

const HELD = 265
const TITLE = "#265 The frontier is read from GitHub and listed"
const ISSUE_LINK = "Issue #265"
const ISSUE_BODY = "Read the project's tasks from GitHub and list them."

const run = async ({ page, profileId, shot, until }) => {
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  const screen = `${app}/projects/${profileId}/${await makeProject(until, "AFK session")}`

  await afkOn(page, screen, until)

  await page.goto(`${app}/code`)
  // Code lists newest first, so the first row titled after the task is this pass's session.
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
  await messages.getByText(ISSUE_LINK, { exact: true }).first().waitFor({ timeout: 15_000 })
  assert.ok(
    (await messages.getByText("Title: The frontier is read from GitHub and listed").count()) > 0,
    "the run opens with the issue's own title",
  )
  assert.ok(
    (await messages.getByText(ISSUE_BODY, { exact: true }).count()) > 0,
    "and its description in the issue's own words, not a summary of them",
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
