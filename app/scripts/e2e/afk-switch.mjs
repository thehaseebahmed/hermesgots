// AFK's switch: a project opened to its options menu offers it in the AFK pop-up, turning it on is
// the host's answer, and a reload reads that same answer back — the setting is the project's, not
// the device's. Phone and tablet, light and dark, with no console error.
import { app, assert, flow, makeProject, openAfk, pass } from "./lib.mjs"

const run = async ({ page, profileId, shot, until }) => {
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  const screen = `${app}/projects/${profileId}/${await makeProject(until, "AFK switch")}`
  const control = () => page.getByRole("switch", { name: "Work on its own" })

  // The switch shows the host's answer, so it flips when the write lands — never before.
  const reads = (state) =>
    until(
      async () => (await control().getAttribute("aria-checked")) === state,
      15_000,
      `the switch to read ${state}`,
    )
  // Every read of the setting the app made, so "a reload reads it back" is a read of the host's and
  // not a setting this device happened to remember.
  const afkReads = []
  page.on("request", (request) => {
    if (request.method() === "GET" && request.url().endsWith("/afk")) afkReads.push(request.url())
  })
  // The sheet slides in on a phone and a drawer on a tablet: let it settle before a shot.
  const snap = async (name) => {
    await page.waitForTimeout(450)
    await shot(name)
  }

  // The switch starts off and in reach, and the row reads that state.
  await openAfk(page, screen)
  await control().waitFor({ timeout: 15_000 })
  assert.equal(await control().getAttribute("aria-checked"), "false", "AFK starts off")
  assert.equal(
    await control().isDisabled(),
    false,
    "a project that can be worked offers the switch",
  )
  assert.equal(await page.getByText("Turned off", { exact: true }).count(), 1, "the row says off")
  await snap("off")
  await control().click()
  await reads("true")
  assert.equal(await page.getByText("Turned on", { exact: true }).count(), 1, "the row says on")
  await snap("on")
  const askedFirst = afkReads.length

  // The setting is the project's, kept on the host: a reload reads it back, and off is its write.
  await openAfk(page, screen)
  await control().waitFor({ timeout: 15_000 })
  assert.equal(
    await control().getAttribute("aria-checked"),
    "true",
    "a reload reads the setting back from the host",
  )
  assert.ok(afkReads.length > askedFirst, "the reload asked the host again rather than the device")
  await control().click()
  await reads("false")
  assert.equal(await page.getByText("Turned off", { exact: true }).count(), 1, "and back to off")
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
  "AFK's pop-up switches a project on and off on its host — the row reading Turned off and Turned on — and a reload reads the setting back, at 390 and 1024px, light and dark",
)
