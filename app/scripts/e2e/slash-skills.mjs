// The composer's `/` menu lists the bot's skills from the Gots plugin, not from Hermes's /v1/skills.
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

  await page.getByRole("textbox").last().fill("/")
  const menu = page.getByRole("listbox", { name: "Commands and skills" })
  await menu.waitFor({ timeout: 15_000 })
  for (const name of FIXTURE) {
    await menu.getByRole("option", { name: new RegExp(`/${name}\\b`) }).waitFor({ timeout: 10_000 })
  }
  await shot("menu")

  assert.ok(plugin.length > 0, "the menu asked the plugin's /skills route")
  assert.equal(hermes.length, 0, "the menu never asked Hermes's /v1/skills")
  pass(`the / menu listed ${FIXTURE.length} skills from the plugin route`)
})
