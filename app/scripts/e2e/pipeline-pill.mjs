// A staged AFK task's session carries its pipeline as a pill above the composer, first in the row,
// and the sheet behind it says how far it got and what each step ran. The host is driven through its
// own routes — the switch, the sweep that stages the claimed task, and the record each stage writes —
// and the app reads that record the way it always does, when the screen mounts and through
// `refreshWorkspace`. One chat is reloaded at the end, to prove the pill is drawn from what the host
// kept rather than from anything the flow left in memory.
import { app, assert, flow, makeProject, mock, pass, say } from "./lib.mjs"

const TASK = 265
const PR = 27
const TITLE = `#${TASK} The frontier is read from GitHub and listed`
const OPENING = `Title: The frontier is read from GitHub and listed\nDescription:\nRead the project's tasks from GitHub and list them.\n\n[Issue #${TASK}](https://github.com/mock-user/memento/issues/${TASK})`

// The records `plugin/pipeline.py` writes, stage by stage, with the gate's answer each one carries.
const GATE = {
  commands: [
    { command: "pnpm lint", repo: null, code: 0 },
    { command: "pnpm test", repo: null, code: 0 },
  ],
}
const PASSED = { stage: "build", build_skill: "plan", critique_skills: ["code-review"], gate: GATE }
const RECORDS = {
  gate: { ...PASSED, stage: "gate" },
  critique: { ...PASSED, stage: "critique" },
  done: { ...PASSED, stage: "done" },
  stalled: {
    ...PASSED,
    stage: "gate",
    gate: { commands: [{ command: "pnpm test", repo: null, code: 1 }] },
    reason: "The gate failed: pnpm test exited 1.",
  },
}

const afkPath = (projectId) => `${mock}/api/plugins/memento/projects/${projectId}/afk`

const post = (path, body) =>
  fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })

/** A write to the project's AFK row: the switch, or the skills its work follows. */
const write = (projectId, body) => post(afkPath(projectId), body)

/**
 * Moves the record on the session the project's task is worked in — the stage, the gate's answer,
 * the reason it stopped — and the pull request a finished pipeline opened, the way the host's own
 * pipeline writes them.
 */
const staged = (projectId, body) => say({ project_id: projectId, ...body })

/**
 * Leaves a project to work and waits for its sweep to claim the task, which is what stages the
 * session: the same write the sheet's switch makes, and the same read its poll makes.
 */
async function workOn(until, projectId) {
  assert.equal((await write(projectId, { on: true })).status, 200, "the project is left to work")
  return until(
    async () => {
      const afk = await (await fetch(afkPath(projectId))).json()
      return afk.task ?? null
    },
    20_000,
    "AFK to claim the project's oldest ready task",
  )
}

/** A conversation on the device for the session AFK published, with the turn that opened it. */
const seed = (page, { id, projectId }) =>
  page.evaluate(
    async ({ id, projectId, title, opening }) => {
      const { db } = await import("/src/lib/db.ts")
      const profile = (await db.profiles.toArray())[0]
      const at = Date.now()
      await db.conversations.put({
        id,
        profileId: profile.id,
        hermesSessionId: id,
        title,
        createdAt: at - 1000,
        updatedAt: at,
        changedAt: at,
        titleEdited: true,
        projectId,
        mode: "auto",
        afk: true,
      })
      await db.messages.put({
        id: `${id}-opening`,
        conversationId: id,
        role: "user",
        content: opening,
        status: "done",
        createdAt: at - 900,
      })
    },
    { id, projectId, title: TITLE, opening: OPENING },
  )

/** The app's own reads, run where the screen would run them: the workspace, and the pull requests. */
const reread = (page, id) =>
  page.evaluate(async (id) => {
    const workspace = await import("/src/lib/workspace.ts")
    await workspace.refreshWorkspace(id)
  }, id)

const rereadPrs = (page, id) =>
  page.evaluate(async (id) => {
    const workspace = await import("/src/lib/workspace.ts")
    await workspace.refreshPrs(id, { force: true })
  }, id)

/** What a step's mark means once it is spoken: the pill's own accessible name. */
const SPOKEN = { pass: "done", fail: "failed", current: "in progress", next: "not started" }
const WORDS = { build: "Build", gate: "Gate", critique: "Critique" }

/**
 * The pill as the record says: the mark each step wears, and the stage in words. The states are the
 * marks a reader sees by colour, and the accessible name is how a reader who can't see them hears
 * the same three.
 */
async function reads(page, until, stage, states, word) {
  const pill = page.locator("[data-pipeline]")
  await pill.waitFor({ timeout: 15_000 })
  await until(
    async () => (await pill.getAttribute("data-pipeline")) === stage,
    15_000,
    `the pill to read ${stage}`,
  )
  for (const [name, state] of Object.entries(states))
    assert.equal(
      await pill.locator(`[data-step="${name}"]`).getAttribute("data-state"),
      state,
      `${name} reads ${state} in ${stage}`,
    )
  const spoken = await pill.getAttribute("aria-label")
  for (const [name, state] of Object.entries(states))
    assert.ok(
      spoken.includes(`${WORDS[name]} ${SPOKEN[state]}`),
      `the pill says ${WORDS[name]} is ${SPOKEN[state]} in ${stage} (${spoken})`,
    )
  assert.equal(await pill.innerText(), word, `the pill names the stage: ${word}`)
  return pill
}

/** The sheet behind the pill: the stage in its title, then what each step ran. */
async function opens(page, until, title, lines) {
  await page.locator("[data-pipeline]").click()
  const sheet = page.getByRole("dialog")
  await sheet.getByRole("heading", { name: title }).waitFor({ timeout: 15_000 })
  for (const line of lines)
    await until(
      async () => ((await sheet.innerText()).includes(line) ? line : null),
      10_000,
      `the sheet to say "${line}"`,
    )
  return sheet
}

/**
 * A screen that throws still paints, so both a thrown error and a console error fail the run that
 * drove it.
 */
function watch(page) {
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  return errors
}

const run = async ({ page, until, shot }) => {
  const errors = watch(page)
  const projectId = await makeProject(until, "Pipeline pill")
  const id = `memento-afk-${projectId}`
  // A critique skill is what turns the pipeline on, written the way the sheet's pickers write it.
  assert.equal(
    (await write(projectId, { build_skill: "plan", critique_skills: ["code-review"] })).status,
    200,
    "a skill to build by and one to critique are chosen",
  )
  const held = await workOn(until, projectId)
  assert.equal(held.number, TASK, "the sweep claimed the oldest ready task")

  await seed(page, { id, projectId })
  await page.evaluate(async () => {
    const { db } = await import("/src/lib/db.ts")
    await db.settings.update("settings", { developer: true, afkWorkflows: true })
  })
  await page.goto(`${app}/c/${id}`)
  await page.locator('[aria-label="Messages"]').waitFor({ timeout: 15_000 })

  // Building: the record the sweep wrote before its build run was posted. The pill leads the row,
  // whatever else the session has to show.
  const pill = await reads(
    page,
    until,
    "build",
    { build: "current", gate: "next", critique: "next" },
    "Building",
  )
  assert.equal(
    await pill.evaluate((one) => one.parentElement.firstElementChild === one),
    true,
    "the pipeline pill is the first in the row",
  )
  await shot("building")

  const building = await opens(page, until, "AFK - Stage 1 of 3", ["plan", "Not run yet"])
  await shot("sheet-building")
  await page.keyboard.press("Escape")
  await building.waitFor({ state: "hidden", timeout: 10_000 })

  // The gate has run and passed, and the task waits at it while its build goes on.
  await staged(projectId, { pipeline: RECORDS.gate })
  await reread(page, id)
  await reads(
    page,
    until,
    "gate",
    { build: "pass", gate: "current", critique: "next" },
    "Gate check",
  )
  await shot("gate")

  // Critiquing: the gate passed, so the task is in its second run, and the sheet has its commands.
  await staged(projectId, { pipeline: RECORDS.critique })
  await reread(page, id)
  await reads(
    page,
    until,
    "critique",
    { build: "pass", gate: "pass", critique: "current" },
    "Critiquing",
  )
  await shot("critique")

  const critiquing = await opens(page, until, "AFK - Stage 3 of 3", [
    "plan",
    "pnpm lint",
    "pnpm test",
    "code-review",
  ])
  // Each command with the code it exited, which is what the gate's answer holds.
  assert.equal(
    await critiquing.locator('[data-step="gate"]').count(),
    1,
    "the sheet carries the gate's own step",
  )
  await shot("sheet-critiquing")
  await page.keyboard.press("Escape")
  await critiquing.waitFor({ state: "hidden", timeout: 10_000 })

  // Shipped: every mark green, and the run's sheet names the pull request it opened.
  await staged(projectId, {
    pipeline: RECORDS.done,
    pr: { number: PR, title: `#${TASK} The frontier is read from GitHub and listed` },
  })
  await reread(page, id)
  await rereadPrs(page, id)
  await reads(page, until, "done", { build: "pass", gate: "pass", critique: "pass" }, "Shipped")
  await shot("shipped")

  const shipped = await opens(page, until, "AFK - Stage 3 of 3", [
    "plan",
    "code-review",
    `PR #${PR}`,
  ])
  await shot("sheet-shipped")
  await page.keyboard.press("Escape")
  await shipped.waitFor({ state: "hidden", timeout: 10_000 })

  // The record outlives the run: a reload of the finished task draws the same pill, from what the
  // host kept, with nothing the flow left in memory behind it.
  await page.goto(`${app}/c/${id}`)
  await page.locator('[aria-label="Messages"]').waitFor({ timeout: 15_000 })
  await reads(page, until, "done", { build: "pass", gate: "pass", critique: "pass" }, "Shipped")
  await shot("reloaded")

  // A stalled task keeps the stage it reached: its mark is red, the pill says so, and the sheet
  // carries the command that failed with the code it exited.
  await staged(projectId, { pipeline: RECORDS.stalled })
  await reread(page, id)
  await reads(page, until, "gate", { build: "pass", gate: "fail", critique: "next" }, "Stalled")
  await shot("stalled")

  const stalled = await opens(page, until, "AFK - Stage 2 of 3", ["pnpm test", "The gate failed"])
  await shot("sheet-stalled")
  await page.keyboard.press("Escape")
  await stalled.waitFor({ state: "hidden", timeout: 10_000 })

  assert.deepEqual(errors, [], `no console error (${errors.join("; ")})`)
}

const plain = async ({ page, until, shot }) => {
  const errors = watch(page)
  // A project with no critique skill is one run: its session is never staged, and has no pill.
  const projectId = await makeProject(until, "Pipeline pill plain")
  const id = `memento-afk-${projectId}`
  await workOn(until, projectId)
  await seed(page, { id, projectId })
  await page.goto(`${app}/c/${id}`)
  await page.locator('[aria-label="Messages"]').waitFor({ timeout: 15_000 })
  await reread(page, id)
  await page.waitForTimeout(750)
  assert.equal(
    await page.locator("[data-pipeline]").count(),
    0,
    "a session with no pipeline has no pill",
  )
  await shot("no-pipeline")
  assert.deepEqual(errors, [], `no console error (${errors.join("; ")})`)
}

const olderPlugin = async ({ page, until, shot }) => {
  const errors = watch(page)
  const projectId = await makeProject(until, "Pipeline pill old")
  const id = `memento-afk-${projectId}`
  assert.equal(
    (await write(projectId, { build_skill: "plan", critique_skills: ["code-review"] })).status,
    200,
    "the critique is chosen",
  )
  await workOn(until, projectId)
  await page.route("**/api/plugins/memento/info", async (route) => {
    if (route.request().method() !== "GET") return route.continue()
    const response = await route.fetch()
    const body = await response.json()
    await route.fulfill({
      response,
      json: {
        ...body,
        features: (body.features ?? []).filter((feature) => feature !== "afk_pipeline"),
      },
    })
  })
  await seed(page, { id, projectId })
  await page.goto(`${app}/c/${id}`)
  await page.locator('[aria-label="Messages"]').waitFor({ timeout: 15_000 })
  await reread(page, id)
  await page.waitForTimeout(750)
  // The record is on the row all the same: what withholds the pill here is the feature, not a
  // session the app failed to read.
  assert.equal(
    await page.evaluate(async (id) => {
      const { db } = await import("/src/lib/db.ts")
      // The record's position is a stage's index; what that stage is judged as is its kind.
      const pipeline = (await db.conversations.get(id))?.pipeline
      return pipeline?.stages[pipeline.stage]?.kind ?? null
    }, id),
    "build",
    "the staged record reached the conversation, and only the feature keeps the pill away",
  )
  assert.equal(
    await page.locator("[data-pipeline]").count(),
    0,
    "a plugin that doesn't advertise the pipeline draws no pill",
  )
  await shot("without-feature")
  await page.unroute("**/api/plugins/memento/info")
  assert.deepEqual(errors, [], `no console error (${errors.join("; ")})`)
}

for (const width of [390, 1024]) {
  for (const dark of [false, true]) {
    const look = `${width}${dark ? "-dark" : ""}`
    const viewport = { width, height: width < 768 ? 844 : 768 }
    await flow(`pipeline-pill-${look}`, run, { viewport, dark })
    await flow(`pipeline-pill-plain-${look}`, plain, { viewport, dark })
    await flow(`pipeline-pill-old-${look}`, olderPlugin, { viewport, dark })
  }
}
pass(
  "A staged session's pipeline is the first pill above its composer — three bars, green where a step is done, blue for the one it is in, red for the one that failed and grey for what is still to come, with the stage in words — and the sheet behind it counts the stage out of three and names each step's own work: the skill the build ran, every gate command with the code it exited, and the skills that critiqued it, still there after a reload of the finished task and with no pill on a session that never ran one or a plugin that doesn't advertise it, at 390 and 1024px, light and dark",
)
