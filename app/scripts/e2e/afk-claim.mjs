// AFK's claim: turning a project on has the host claim its oldest ready task — assigned to the
// account and marked — so the pop-up says what it is working and the frontier no longer offers it.
// A GitHub refusal leaves the switch on and shows its reason in the same pop-up. The read is the
// plugin's own route, so the whole thing is covered against the mock. Phone and tablet, light and
// dark, with no console error.
import { afkOn, app, assert, flow, makeProject, openAfk, pass } from "./lib.mjs"

const HELD = 265
const HELD_TITLE = "The frontier is read from GitHub and listed"
const REFUSAL = "Couldn't reach GitHub from the server."

const run = async ({ page, profileId, shot, until }) => {
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  const screen = `${app}/projects/${profileId}/${await makeProject(until, "AFK claim")}`
  // The sheet slides in on a phone and a drawer on a tablet: let it settle before a shot.
  const snap = async (name) => {
    await page.waitForTimeout(450)
    await shot(name)
  }

  // Turning it on is the host's; the task its sweep claims lands on the next read of the sheet.
  const control = await afkOn(page, screen, until)
  const working = page.locator("[data-working]")
  await working.waitFor({ timeout: 15_000 })
  assert.ok(
    await working.locator(`[data-task="${HELD}"]`).getByText(HELD_TITLE, { exact: true }).isVisible(),
    "the pop-up names the task AFK is holding",
  )
  await snap("working")

  // A claimed task leaves the frontier: the list is read again once AFK names what it holds.
  await until(
    async () => (await page.locator('[data-group="ready"] [data-task]').count()) === 1,
    15_000,
    "the claimed task to leave the ready list",
  )
  assert.equal(
    await page.locator(`[data-group="claimed"] [data-task="${HELD}"]`).count(),
    1,
    "the task AFK took is listed as claimed",
  )
  await snap("frontier")

  // The claim is the host's, so a reload reads the same task back rather than an empty sheet.
  await openAfk(page, screen)
  await control.waitFor({ timeout: 15_000 })
  assert.equal(await control.getAttribute("aria-checked"), "true", "a reload reads the switch on")
  await working.locator(`[data-task="${HELD}"]`).waitFor({ timeout: 15_000 })
  await snap("reloaded")

  // GitHub refusing leaves the switch on and its reason in the pop-up; nothing turns itself off.
  await page.route("**/api/plugins/memento/projects/*/afk", (route) => {
    if (route.request().method() !== "GET") return route.continue()
    return route.fulfill({
      status: 200,
      headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
      body: JSON.stringify({
        object: "memento.afk",
        on: true,
        reason: null,
        task: null,
        refusal: REFUSAL,
      }),
    })
  })
  await openAfk(page, screen)
  const refused = page.locator("[data-refusal]")
  await refused.waitFor({ timeout: 15_000 })
  assert.equal(await refused.textContent(), REFUSAL, "the refusal is its own line under the switch")
  assert.equal(
    await control.getAttribute("aria-checked"),
    "true",
    "a refusal leaves the project left to work",
  )
  assert.equal(await page.locator("[data-working]").count(), 0, "and holds no task to name")
  await snap("refused")
  await page.unroute("**/api/plugins/memento/projects/*/afk")

  assert.deepEqual(errors, [], `no console error (${errors.join("; ")})`)
}

for (const width of [390, 1024]) {
  for (const dark of [false, true]) {
    const look = `${width}${dark ? "-dark" : ""}`
    await flow(`afk-claim-${look}`, run, {
      viewport: { width, height: width < 768 ? 844 : 768 },
      dark,
    })
  }
}
pass(
  "AFK claims the oldest ready task when a project is turned on — the pop-up naming it, the frontier dropping it — and a GitHub refusal leaves the switch on with its reason shown, at 390 and 1024px, light and dark",
)
