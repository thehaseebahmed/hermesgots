// AFK: a project's options menu carries an AFK row, and the pop-up it opens lists that project's
// tasks as AFK reads them from GitHub — the ready ones oldest first, the claimed ones marked with
// who has them, and the blocked ones naming the open task they wait on. The read is the plugin's
// own route, so the whole pop-up is covered against the mock. A plugin that doesn't advertise `afk`
// offers no row, and a Host whose GitHub refuses shows its reason instead of a list. Phone and
// tablet, light and dark, with no console error.
import { app, assert, flow, mock, pass, runId } from "./lib.mjs"

/** A project the mock has finished cloning, so its screen offers the options menu; answers its id. */
async function makeProject(until) {
  const created = await fetch(`${mock}/api/plugins/gots/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: `AFK ${runId()}`, repos: ["mock-user/memento"] }),
  })
  const pending = await created.json()
  const ready = await until(
    async () => {
      const listed = await (await fetch(`${mock}/api/plugins/gots/projects`)).json()
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

  // The options menu carries the row, and it opens the pop-up.
  await page.goto(screen)
  const options = page.getByRole("button", { name: "Project options" })
  await options.waitFor({ timeout: 15_000 })
  await options.click()
  const afk = page.getByRole("menuitem", { name: "AFK" })
  await afk.waitFor({ timeout: 15_000 })
  await shot("menu")
  await afk.click()

  // Ready: the oldest first, which is the order AFK works them in.
  const ready = page.locator('[data-group="ready"]')
  await ready.waitFor({ timeout: 15_000 })
  const order = await ready
    .locator("[data-task]")
    .evaluateAll((nodes) => nodes.map((node) => Number(node.dataset.task)))
  assert.deepEqual(order, [265, 266], `ready tasks are listed oldest first (${order})`)

  // Claimed: marked, with the account that has it.
  const claimed = page.locator('[data-group="claimed"]')
  assert.ok(
    await claimed.locator('[data-task="267"]').getByText("mock-user", { exact: true }).isVisible(),
    "a claimed task is marked with who has it",
  )

  // Blocked: the task it waits on is named, not just counted.
  const blocked = page.locator('[data-group="blocked"]')
  assert.ok(
    await blocked.getByText("Blocked by #267", { exact: true }).isVisible(),
    "a blocked task names its open blocker",
  )
  assert.equal(
    await blocked.locator('[data-task="268"]').getByText("The claimed task is worked in its own session", {
      exact: true,
    }).count(),
    1,
    "the blocked task is the one its blocker holds back",
  )
  await shot("tasks")

  // A plugin that can't read a project's tasks has no row, rather than one that could only fail.
  await page.route("**/api/plugins/gots/info", async (route) => {
    if (route.request().method() !== "GET") return route.continue()
    const response = await route.fetch()
    const body = await response.json()
    await route.fulfill({
      response,
      json: { ...body, features: (body.features ?? []).filter((feature) => feature !== "afk") },
    })
  })
  await page.goto(screen)
  await options.click()
  await page.getByRole("menuitem").first().waitFor({ timeout: 15_000 })
  assert.equal(await page.getByRole("menuitem", { name: "AFK" }).count(), 0, "no AFK row")
  await shot("no-row")
  await page.unroute("**/api/plugins/gots/info")

  // A Host whose GitHub refuses says why, in place of a list.
  const REFUSAL = "No GitHub account on the server."
  await page.route("**/api/plugins/gots/projects/*/tasks", (route) => {
    if (route.request().method() !== "GET") return route.continue()
    return route.fulfill({
      status: 409,
      headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
      body: JSON.stringify({ error: { message: REFUSAL } }),
    })
  })
  await page.goto(screen)
  await options.click()
  await page.getByRole("menuitem", { name: "AFK" }).click()
  await page.getByText(REFUSAL, { exact: true }).waitFor({ timeout: 15_000 })
  await shot("refused")
  await page.unroute("**/api/plugins/gots/projects/*/tasks")

  // The one 409 this flow provokes on purpose is the refusal; the browser logs it as a failed
  // resource, which is the assertion above passing rather than the app misbehaving.
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
    await flow(`afk-${look}`, run, {
      viewport: { width, height: width < 768 ? 844 : 768 },
      dark,
    })
  }
}
pass(
  "a project's options menu opens AFK's frontier — ready oldest first, claimed marked, blocked naming its open blocker — with no row for a plugin that can't read it and a refusal shown as it is, at 390 and 1024px, light and dark",
)
