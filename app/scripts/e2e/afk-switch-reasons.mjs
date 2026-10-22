// AFK's switch where it can't be offered: a host with no GitHub account says why — once, rather
// than as both the switch's reason and the frontier's refusal — and a plugin that lists a project's
// tasks but was never able to switch AFK on offers no switch at all. Phone and tablet, light and dark.
import { app, assert, flow, makeProject, openAfk, pass } from "./lib.mjs"

const NO_GITHUB = "No GitHub account on the server."

const run = async ({ page, profileId, shot, until }) => {
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  const screen = `${app}/projects/${profileId}/${await makeProject(until, "AFK reasons")}`

  // A host with no GitHub account can't read or claim a task, so the switch is off and out of reach
  // and the reason sits under it — once: the frontier's own refusal is the same answer, and the sheet
  // doesn't say it twice.
  await page.route("**/api/plugins/gots/projects/*/afk", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          status: 200,
          headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
          body: JSON.stringify({ object: "memento.afk", on: false, reason: NO_GITHUB }),
        })
      : route.continue(),
  )
  await page.route("**/api/plugins/gots/projects/*/tasks", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          status: 409,
          headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
          body: JSON.stringify({ error: { message: NO_GITHUB } }),
        })
      : route.continue(),
  )
  // The frontier's refusal lands after the reason it repeats, so wait for it before counting — the
  // wait is armed first, since the request goes out as soon as the sheet opens.
  const refusedTasks = page.waitForResponse(
    (response) => response.url().endsWith("/tasks") && response.status() === 409,
  )
  const control = page.getByRole("switch", { name: "Work on its own" })
  await openAfk(page, screen)
  await refusedTasks
  await page.getByText(NO_GITHUB, { exact: true }).waitFor({ timeout: 15_000 })
  assert.equal(
    await page.getByText(NO_GITHUB, { exact: true }).count(),
    1,
    "the reason is said once, not as both the switch's and the frontier's",
  )
  assert.equal(await control.count(), 1, "the switch is shown, not hidden")
  assert.equal(await control.isDisabled(), true, "and out of reach")
  assert.equal(await control.getAttribute("aria-checked"), "false", "off")
  assert.equal(await page.getByText("Turned off", { exact: true }).count(), 1, "reading its state")
  // Nothing is coming for the frontier either, so it isn't left spinning under the reason.
  assert.equal(
    await page.getByText("Reading tasks…", { exact: true }).count(),
    0,
    "no spinner under the reason",
  )
  await shot("no-github")
  await page.unroute("**/api/plugins/gots/projects/*/afk")
  await page.unroute("**/api/plugins/gots/projects/*/tasks")

  // A plugin that lists a project's tasks but never advertised the switch offers no switch at all:
  // the row is left out rather than carrying a line about what a plugin can't do, as the MCP screen
  // leaves out a control a Bot's Hermes can't offer.
  await page.route("**/api/plugins/gots/info", async (route) => {
    if (route.request().method() !== "GET") return route.continue()
    const response = await route.fetch()
    const body = await response.json()
    await route.fulfill({
      response,
      json: {
        ...body,
        features: (body.features ?? []).filter((feature) => feature !== "afk_switch"),
      },
    })
  })
  await openAfk(page, screen)
  await page.getByRole("button", { name: "Close" }).waitFor({ timeout: 15_000 })
  assert.equal(await control.count(), 1, "a plugin that can't switch it still shows the switch")
  assert.equal(await control.isDisabled(), true, "out of reach")
  assert.equal(await control.getAttribute("aria-checked"), "false", "off")
  assert.equal(
    await page.getByText("Turned off", { exact: true }).count(),
    1,
    "the row says so rather than explaining the plugin",
  )
  await shot("no-switch")
  await page.unroute("**/api/plugins/gots/info")

  // A project already left to work keeps its switch when its reason comes back: turning it off is
  // still the user's to do, so the reason sits under the switch rather than in place of it.
  await page.route("**/api/plugins/gots/projects/*/afk", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          status: 200,
          headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
          body: JSON.stringify({ object: "memento.afk", on: true, reason: NO_GITHUB }),
        })
      : route.continue(),
  )
  await page.getByRole("button", { name: "Close" }).click()
  await page.unroute("**/api/plugins/gots/info")
  await openAfk(page, screen)
  await page.getByRole("switch", { name: "Work on its own" }).waitFor({ timeout: 15_000 })
  assert.equal(
    await page.getByRole("switch", { name: "Work on its own" }).getAttribute("aria-checked"),
    "true",
    "a project left on keeps its switch",
  )
  assert.equal(
    await page.getByRole("switch", { name: "Work on its own" }).isDisabled(),
    false,
    "and it can still be turned off",
  )
  assert.equal(await page.getByText("Turned on", { exact: true }).count(), 1, "reading its state")
  assert.equal(await page.getByText(NO_GITHUB, { exact: true }).count(), 1, "and says why under it")
  await shot("on-with-reason")
  await page.unroute("**/api/plugins/gots/projects/*/afk")

  // The one 409 this flow provokes on purpose is the frontier's refusal; the browser logs it as a
  // failed resource, which is the assertion above passing rather than the app misbehaving.
  const refused = errors.filter((text) => /Failed to load resource.*409/.test(text))
  assert.equal(refused.length, 1, "only the deliberate refusal answered 409")
  assert.deepEqual(
    errors.filter((text) => !refused.includes(text)),
    [],
    `no other console error (${errors.join("; ")})`,
  )
}

for (const width of [390, 1024]) {
  for (const dark of [false, true]) {
    const look = `${width}${dark ? "-dark" : ""}`
    await flow(`afk-switch-reasons-${look}`, run, {
      viewport: { width, height: width < 768 ? 844 : 768 },
      dark,
    })
  }
}
pass(
  "Away From Keyboard's pop-up shows its switch off and out of reach with the reason under it where the project can't be worked — no GitHub account, said once — leaves it off and disabled for a plugin too old to switch it, and keeps it live for a project already on, at 390 and 1024px, light and dark",
)
