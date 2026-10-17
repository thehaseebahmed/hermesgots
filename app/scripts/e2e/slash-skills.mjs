// The composer's `/` menu lists the bot's skills from the Gots plugin, not from Hermes's /v1/skills:
// the list is kept on the device, a slash that begins any word opens it, and picking a skill puts it
// at the front of the message, which is the only place the host runs one from.
import { assert, flow, pass } from "./lib.mjs"

const FIXTURE = ["github-pr-workflow", "log-triage", "plan"]

await flow("slash-skills", async ({ page, shot }) => {
  const plugin = []
  const hermes = []
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname
    if (path.endsWith("/skills") && path.includes("plugins/memento")) plugin.push(path)
    if (path === "/v1/skills") hermes.push(path)
  })
  const composer = page.getByLabel("Message")
  const menu = page.getByRole("listbox", { name: "Commands and skills" })

  await composer.fill("/")
  await menu.waitFor({ timeout: 15_000 })
  for (const name of FIXTURE) {
    await menu.getByRole("option", { name: new RegExp(`/${name}\\b`) }).waitFor({ timeout: 10_000 })
  }
  await shot("menu")

  assert.ok(plugin.length > 0, "the menu asked the plugin's /skills route")
  assert.equal(hermes.length, 0, "the menu never asked Hermes's /v1/skills")

  // A slash that begins a word mid-message opens it, and the query is what follows the slash.
  await composer.fill("fix the tests /tri")
  await menu.getByRole("option", { name: /\/log-triage\b/ }).waitFor({ timeout: 10_000 })
  await shot("mid-message")

  // Picking one puts it at the front, with the rest of the sentence after it.
  await composer.press("Enter")
  assert.equal(
    await composer.inputValue(),
    "/log-triage fix the tests",
    "a picked skill is hoisted to the front of the message",
  )

  // A slash inside a word is a path or a URL, not a skill.
  await composer.fill("see and/or the docs at https://example.com/a/b")
  await page.waitForTimeout(500)
  assert.equal(await menu.isVisible(), false, "a slash inside a word leaves the menu closed")

  // The list is on the device: with the plugin unreachable, a reload still has the skills.
  await composer.fill("/")
  await menu.waitFor({ timeout: 10_000 })
  await page.route("**/api/plugins/memento/**", (route) => route.abort())
  await page.reload()
  await composer.fill("still /pl")
  await menu.getByRole("option", { name: /\/plan\b/ }).waitFor({ timeout: 10_000 })
  await shot("cached")
  await page.unroute("**/api/plugins/memento/**")

  pass(`the / menu listed ${FIXTURE.length} skills from the plugin route, and kept them offline`)
})
