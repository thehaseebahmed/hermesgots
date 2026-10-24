// AFK's pop-up picks the skills a project's work follows: one to build by and the ones to critique,
// both listed from the bot's own skills — only what its host can run now — and kept on the host, so a
// reload reads the same choice back and another project has its own. Either clears back to nothing.
// A plugin that predates the pickers shows the pop-up it has, its switch still working — a flow of
// its own, since each browser here loads the app a few times and no more. The pickers are a plugin's
// from before the Prompt (ADR 0027): where the host holds a Prompt, its words name the skills and no
// picker is drawn, so this flow's host answers as that older plugin, without `afk_prompt`.
import { app, assert, flow, makeProject, mock, openAfk, pass } from "./lib.mjs"

const BUILD = "plan"
const CRITIQUE = ["github-pr-workflow", "log-triage"]
// The mock's profile holds these, and the pickers offer the ones its host can run now: a row
// switched off (`weekly-digest`) or one that doesn't load (`legacy-importer`) is not among them
// (ADR 0044), while a plugin's skill and an essential one are.
const OFFERED = [
  "code-review",
  "code-review-deep",
  "github-pr-workflow",
  "gots:ship",
  "hub-audit",
  "identity",
  "log-triage",
  "log-rotation",
  "pinned-notes",
  "plan",
]

/** The host's `info` answered without these features: a plugin from before they were added. */
async function withoutFeatures(page, ...missing) {
  await page.route("**/api/plugins/memento/info", async (route) => {
    if (route.request().method() !== "GET") return route.continue()
    const response = await route.fetch()
    const body = await response.json()
    await route.fulfill({
      response,
      json: {
        ...body,
        features: (body.features ?? []).filter((feature) => !missing.includes(feature)),
      },
    })
  })
}

function pickers(page, until) {
  const build = () => page.getByRole("combobox", { name: "Build skill" })
  const critique = () => page.getByRole("button", { name: "Critique skills" })
  return {
    build,
    critique,
    // The host's answer is what the pickers show, so each write is waited for rather than assumed.
    reads: (locator, text) =>
      until(
        async () => (await locator().innerText()).trim() === text,
        15_000,
        `the picker to read ${text}`,
      ),
    openBuild: async () => {
      await build().click()
      await page.getByRole("option").first().waitFor({ timeout: 15_000 })
    },
    openCritique: async () => {
      await critique().click()
      await page.getByRole("menuitemcheckbox").first().waitFor({ timeout: 15_000 })
    },
    closeMenu: () => page.keyboard.press("Escape"),
  }
}

const choosing = async ({ page, profileId, shot, until }) => {
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  await withoutFeatures(page, "afk_prompt")
  const project = await makeProject(until, "AFK skills")
  const screen = `${app}/projects/${profileId}/${project}`
  const other = await makeProject(until, "AFK skills other")
  const { build, critique, reads, openBuild, openCritique, closeMenu } = pickers(page, until)
  // Every read of the setting the app made, so "a reload reads it back" is a read of the host's.
  const afkReads = []
  page.on("request", (request) => {
    if (request.method() === "GET" && request.url().endsWith("/afk")) afkReads.push(request.url())
  })

  await openAfk(page, screen)
  await build().waitFor({ timeout: 15_000 })
  await critique().waitFor({ timeout: 15_000 })
  assert.equal((await build().innerText()).trim(), "None", "nothing is chosen to build by")
  assert.equal((await critique().innerText()).trim(), "None", "nothing is chosen to critique")
  await shot("empty")

  await openBuild()
  await shot("build-menu")
  const offered = await page
    .getByRole("option")
    .evaluateAll((nodes) => nodes.map((node) => node.textContent.trim()))
  assert.deepEqual(
    offered.filter((name) => name !== "None").sort(),
    [...OFFERED].sort(),
    `the build picker lists the bot's skills (${offered})`,
  )
  await page.getByRole("option", { name: BUILD, exact: true }).click()
  await reads(build, BUILD)
  await openCritique()
  await shot("critique-menu")
  const lenses = await page
    .getByRole("menuitemcheckbox")
    .evaluateAll((nodes) => nodes.map((node) => node.textContent.trim()))
  assert.deepEqual(
    lenses.sort(),
    [...OFFERED].sort(),
    `the critique picker lists the bot's skills (${lenses})`,
  )
  await page.getByRole("menuitemcheckbox", { name: CRITIQUE[0], exact: true }).click()
  await page.getByRole("menuitemcheckbox", { name: CRITIQUE[1], exact: true }).click()
  await reads(critique, CRITIQUE.join(", "))
  await closeMenu()
  await shot("chosen")

  // The write landed on this project alone: another's AFK row is the one it always was.
  const neighbour = await (
    await fetch(`${mock}/api/plugins/memento/projects/${other}/afk`)
  ).json()
  assert.equal(neighbour.build_skill, null, "another project builds by nothing")
  assert.deepEqual(neighbour.critique_skills, [], "and critiques by nothing")

  // Posted straight at the host, since the app never builds either body.
  for (const [body, why] of [
    [{ critique_skills: [] }, "a body naming one of the two"],
    [{ on: true, build_skill: null, critique_skills: [] }, "a body naming both"],
  ]) {
    const refused = await fetch(`${mock}/api/plugins/memento/projects/${project}/afk`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    assert.equal(refused.status, 400, `${why} is refused`)
  }

  // The choice is the project's, kept on the host: a reload reads it back, and asks the host for it —
  // then either clears back to nothing, the build's None and the critique's Clear.
  const asked = afkReads.length
  await openAfk(page, screen)
  await build().waitFor({ timeout: 15_000 })
  await reads(build, BUILD)
  await reads(critique, CRITIQUE.join(", "))
  assert.ok(afkReads.length > asked, "the reload asked the host rather than remembering on the device")
  await openBuild()
  await page.getByRole("option", { name: "None", exact: true }).click()
  await reads(build, "None")
  await openCritique()
  await page.getByRole("menuitem", { name: "Clear", exact: true }).click()
  await reads(critique, "None")
  await closeMenu()
  await shot("cleared")

  // A failed fetch the browser logs on its own (a 404 with no CORS headers) isn't the app's error.
  assert.deepEqual(
    errors.filter((e) => !/Failed to load resource|CORS policy/.test(e)),
    [],
    `no console error (${errors.join("; ")})`,
  )
}

const olderPlugin = async ({ page, profileId, shot, until }) => {
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  const screen = `${app}/projects/${profileId}/${await makeProject(until, "AFK skills old")}`
  const { build, critique } = pickers(page, until)
  await withoutFeatures(page, "afk_skills")
  await openAfk(page, screen)
  const control = page.getByRole("switch", { name: "Work on its own" })
  await control.waitFor({ timeout: 15_000 })
  assert.equal(
    await page.locator("[data-afk-skills]").count(),
    0,
    "a plugin without the feature has no pickers",
  )
  assert.equal(await build().count(), 0, "no build picker")
  assert.equal(await critique().count(), 0, "no critique picker")
  await control.click()
  await until(
    async () => (await control.getAttribute("aria-checked")) === "true",
    15_000,
    "the switch to read on",
  )
  await shot("without-feature")
  await control.click()
  await until(
    async () => (await control.getAttribute("aria-checked")) === "false",
    15_000,
    "the switch to read off",
  )
  await page.unroute("**/api/plugins/memento/info")

  // A failed fetch the browser logs on its own (a 404 with no CORS headers) isn't the app's error.
  assert.deepEqual(
    errors.filter((e) => !/Failed to load resource|CORS policy/.test(e)),
    [],
    `no console error (${errors.join("; ")})`,
  )
}

for (const width of [390, 1024]) {
  for (const dark of [false, true]) {
    const look = `${width}${dark ? "-dark" : ""}`
    const viewport = { width, height: width < 768 ? 844 : 768 }
    await flow(`afk-skills-${look}`, choosing, { viewport, dark })
    await flow(`afk-skills-old-${look}`, olderPlugin, { viewport, dark })
  }
}
pass(
  "AFK's pop-up picks one skill to build by and any number to critique, from the bot's own list, kept on the host across a reload and apart from another project's, either clearing back to nothing, with no pickers on a plugin that predates them and its switch still working, at 390 and 1024px, light and dark",
)
