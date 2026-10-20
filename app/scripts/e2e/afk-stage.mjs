// AFK's pop-up names the stage a staged task is in — the stage's own name from the task's snapshot,
// Build, Test and Review on the default workflow — read from
// the host on its own poll, so the sheet says how far the work got without opening its session. A
// project with no critique skill is one run, and its task has no stage to name. The mock's claimed
// task is staged, and a flow moves it between the stages the way the host's pipeline does.
import { afkOn, app, assert, flow, makeProject, mock, openAfk, pass, say } from "./lib.mjs"

const STAGES = [
  ["gate", "Test"],
  ["critique", "Review"],
]

const choose = (projectId, critique) =>
  fetch(`${mock}/api/plugins/memento/projects/${projectId}/afk`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ build_skill: critique.length ? "plan" : null, critique_skills: critique }),
  })

const run = async ({ page, profileId, shot, until }) => {
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  // The mock keeps a project's stages between passes; this pass wants only its own.
  await say({ reset: true })
  const projectId = await makeProject(until, "AFK stage")
  const screen = `${app}/projects/${profileId}/${projectId}`
  // A critique skill is what turns the pipeline on. The sheet's pickers write it; this is that same
  // write, without opening the menu.
  assert.equal((await choose(projectId, ["code-review"])).status, 200, "the critique is chosen")

  // Turning it on wakes the sweep, so the claim lands on the sheet's next read.
  const control = await afkOn(page, screen, until)
  const working = page.locator("[data-working]")
  // The row's own text, without the "Working" heading above it. `textContent`, not
  // `innerText`: the row is a flex line, so innerText breaks it at every item.
  const rowText = () => working.locator("a[data-task]").textContent()
  const leads = async (label) =>
    new RegExp(`^#\\d+${label}: `).test(await rowText())
  await working.getByText("Build").waitFor({ timeout: 20_000 })
  assert.equal(
    await working.getAttribute("data-stage"),
    "build",
    "the Working row says the task is building",
  )
  assert.ok(await leads("Build"), "the task's title is prefixed with Build:")
  await page.waitForTimeout(450)
  await shot("building")

  for (const [stage, label] of STAGES) {
    await say({ project_id: projectId, stage })
    await working.getByText(label).waitFor({ timeout: 20_000 })
    assert.equal(await working.getAttribute("data-stage"), stage, `the Working row says ${label}`)
    assert.ok(await leads(label), `the task's title is prefixed with ${label}:`)
    await page.waitForTimeout(450)
    await shot(stage)
  }

  // The stage belongs to the claimed task's own record, not to the pickers: clearing the critique
  // skills leaves this task where it stands — its session was staged when it claimed it — so the
  // row goes on naming the stage until that task is done.
  assert.equal((await choose(projectId, [])).status, 200, "the critique is cleared")
  await openAfk(page, screen)
  await control.waitFor({ timeout: 15_000 })
  await working.getByText("Review").waitFor({ timeout: 20_000 })
  assert.equal(
    await working.getAttribute("data-stage"),
    "critique",
    "a task already claimed keeps the stage it was claimed in",
  )
  assert.ok(await leads("Review"), "and its title still says so")
  await page.waitForTimeout(450)
  await shot("stage-kept")

  assert.deepEqual(errors, [], `no console error (${errors.join("; ")})`)
}

for (const width of [390, 1024]) {
  for (const dark of [false, true]) {
    const look = `${width}${dark ? "-dark" : ""}`
    await flow(`afk-stage-${look}`, run, {
      viewport: { width, height: width < 768 ? 844 : 768 },
      dark,
    })
  }
}
pass(
  "AFK's pop-up names the stage its held task is in, by the stage's own name from the task's snapshot — Build, Test, Review on the default workflow — as the host moves it on, and keeps it when the pickers change under a claimed task, at 390 and 1024px, light and dark",
)
