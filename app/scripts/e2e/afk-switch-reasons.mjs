// AFK's switch where it can't be offered: a host with no GitHub account says why — once, rather
// than as both the switch's reason and the frontier's refusal — and a plugin that lists a project's
// tasks but was never able to switch AFK on says that instead. Phone and tablet, light and dark.
import { app, assert, flow, mock, pass, runId } from "./lib.mjs"

const NO_GITHUB = "No GitHub account on the server."
const NO_SWITCH = "This plugin can't switch AFK on."

/** A project the mock has finished cloning, so its screen offers the options menu; answers its id. */
async function makeProject(until) {
  const created = await fetch(`${mock}/api/plugins/memento/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: `AFK reasons ${runId()}`, repos: ["mock-user/memento"] }),
  })
  const pending = await created.json()
  const ready = await until(
    async () => {
      const listed = await (await fetch(`${mock}/api/plugins/memento/projects`)).json()
      const found = listed.projects.find((project) => project.slug === pending.slug)
      return found?.status === "ready" ? found : null
    },
    20_000,
    "the mock to finish cloning the project",
  )
  return ready.id
}

const run = async ({ page, profileId, shot, until }) => {
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  const screen = `${app}/projects/${profileId}/${await makeProject(until)}`
  const openAfk = async () => {
    await page.goto(screen)
    const options = page.getByRole("button", { name: "Project options" })
    await options.waitFor({ timeout: 15_000 })
    await options.click()
    await page.getByRole("menuitem", { name: "AFK" }).click()
  }

  // A host with no GitHub account can't read or claim a task, so it says so once: the frontier's own
  // refusal is the same answer, and the sheet doesn't say it twice.
  await page.route("**/api/plugins/memento/projects/*/afk", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          status: 200,
          headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
          body: JSON.stringify({ object: "memento.afk", on: false, reason: NO_GITHUB }),
        })
      : route.continue(),
  )
  await page.route("**/api/plugins/memento/projects/*/tasks", (route) =>
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
  await openAfk()
  await refusedTasks
  await page.getByText(NO_GITHUB, { exact: true }).waitFor({ timeout: 15_000 })
  assert.equal(
    await page.getByText(NO_GITHUB, { exact: true }).count(),
    1,
    "the reason is said once, not as both the switch's and the frontier's",
  )
  assert.equal(await page.getByRole("switch", { name: "Work on its own" }).count(), 0, "no switch")
  // Nothing is coming for the frontier either, so it isn't left spinning under the reason.
  assert.equal(
    await page.getByText("Reading tasks…", { exact: true }).count(),
    0,
    "no spinner under the reason",
  )
  await page.waitForTimeout(450)
  await shot("no-github")
  await page.unroute("**/api/plugins/memento/projects/*/afk")
  await page.unroute("**/api/plugins/memento/projects/*/tasks")

  // A plugin that lists a project's tasks but never advertised the switch offers no switch, and says
  // why rather than leaving the row silently empty.
  await page.route("**/api/plugins/memento/info", async (route) => {
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
  await openAfk()
  await page.getByText(NO_SWITCH, { exact: true }).waitFor({ timeout: 15_000 })
  assert.equal(await page.getByRole("switch", { name: "Work on its own" }).count(), 0, "no switch")
  await page.waitForTimeout(450)
  await shot("no-switch")
  await page.unroute("**/api/plugins/memento/info")

  // A project already left to work keeps its switch when its reason comes back: turning it off is
  // still the user's to do, so the reason sits under the switch rather than in place of it.
  await page.route("**/api/plugins/memento/projects/*/afk", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          status: 200,
          headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
          body: JSON.stringify({ object: "memento.afk", on: true, reason: NO_GITHUB }),
        })
      : route.continue(),
  )
  await page.getByRole("button", { name: "Close" }).click()
  await page.unroute("**/api/plugins/memento/info")
  await openAfk()
  await page.getByRole("switch", { name: "Work on its own" }).waitFor({ timeout: 15_000 })
  assert.equal(
    await page.getByRole("switch", { name: "Work on its own" }).getAttribute("aria-checked"),
    "true",
    "a project left on keeps its switch",
  )
  assert.equal(
    await page.getByText(NO_GITHUB, { exact: true }).count(),
    1,
    "and says why under it",
  )
  await page.waitForTimeout(450)
  await shot("on-with-reason")
  await page.unroute("**/api/plugins/memento/projects/*/afk")

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
  "AFK's pop-up says why it can't offer the switch — no GitHub account, said once, a project left on keeping its switch with the reason under it, and a plugin too old to switch it — at 390 and 1024px, light and dark",
)
