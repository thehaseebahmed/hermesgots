// AFK's switch: a project opened to its options menu offers it in the AFK pop-up, turning it on is
// the host's answer, and a reload reads that same answer back — the setting is the project's, not
// the device's. Phone and tablet, light and dark, with no console error.
import { app, assert, flow, mock, pass, runId } from "./lib.mjs"

/** A project the mock has finished cloning, so its screen offers the options menu; answers its id. */
async function makeProject(until) {
  const created = await fetch(`${mock}/api/plugins/memento/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: `AFK switch ${runId()}`, repos: ["mock-user/memento"] }),
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
  const control = () => page.getByRole("switch", { name: "Work on its own" })
  // The switch shows the host's answer, so it flips when the write lands — never before.
  const reads = (state) =>
    until(
      async () => (await control().getAttribute("aria-checked")) === state,
      15_000,
      `the switch to read ${state}`,
    )
  // The sheet slides in on a phone and a drawer on a tablet: let it settle before a shot.
  const snap = async (name) => {
    await page.waitForTimeout(450)
    await shot(name)
  }

  // The switch starts off, and turning it on is the host's answer rather than the device's.
  await openAfk()
  await control().waitFor({ timeout: 15_000 })
  assert.equal(await control().getAttribute("aria-checked"), "false", "AFK starts off")
  await snap("off")
  await control().click()
  await reads("true")
  assert.equal(await control().getAttribute("aria-checked"), "true", "the switch is on")
  await snap("on")

  // The setting is the project's, kept on the host: a reload reads it back, and off is its write.
  await openAfk()
  await control().waitFor({ timeout: 15_000 })
  assert.equal(
    await control().getAttribute("aria-checked"),
    "true",
    "a reload reads the setting back from the host",
  )
  await control().click()
  await reads("false")
  assert.equal(await control().getAttribute("aria-checked"), "false", "the switch is off")
  await snap("turned-off")

  assert.deepEqual(errors, [], `no console error (${errors.join("; ")})`)
}

for (const width of [390, 1024]) {
  for (const dark of [false, true]) {
    const look = `${width}${dark ? "-dark" : ""}`
    await flow(`afk-switch-${look}`, run, {
      viewport: { width, height: width < 768 ? 844 : 768 },
      dark,
    })
  }
}
pass(
  "a project's AFK pop-up switches it on and off on its host, and a reload reads the setting back, at 390 and 1024px, light and dark",
)
