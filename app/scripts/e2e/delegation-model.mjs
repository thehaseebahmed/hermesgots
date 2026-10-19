// A bot's second-opinion model: its settings screen records it as the host's delegation model,
// greys the field out while the write is on its way, clears it back to the bot's own model, and
// links each of the bot's projects beside it.
import { app, assert, flow, mock, pass } from "./lib.mjs"

await flow("delegation-model", async ({ page, profileId, until, shot, held }) => {
  // The host's own record, which is what the screen must be writing.
  const hosted = async () => {
    const response = await fetch(`${mock}/api/plugins/memento/delegation`)
    return (await response.json()).delegation
  }
  // The picker is a dialog over the settings screen, where a row for the same model may already be
  // on show, so every pick inside it is scoped to it.
  const picker = page.getByRole("dialog")
  const pick = async (query, label) => {
    await picker.getByRole("textbox", { name: "Search models" }).fill(query)
    await picker.getByRole("button", { name: label }).first().click()
  }
  // The whole field, so the heading's saving icon and the field are read where they render.
  const field = page.getByRole("group", { name: "Second opinion" })
  const opener = page.locator("#delegation-model")
  // Every delegation write the page sends, so the greying out is checked against what goes to the
  // host and not only against how the field looks.
  const writes = []
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/plugins/memento/delegation"))
      writes.push(request.url())
  })

  // A dev's mock may be holding another run's pick, so start from none.
  await fetch(`${mock}/api/plugins/memento/delegation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ delegation: null }),
  })
  assert.equal(await hosted(), null)

  await page.goto(`${app}/settings/bots/${profileId}/models`)
  await opener.waitFor({ timeout: 15_000 })
  // Nothing recorded: every delegated task runs on the bot's own model.
  await opener.getByText("Same as the bot").waitFor()
  await shot("inherited")

  // A pick is written whole, so while it is on its way the field is greyed out and says so.
  const write = await held("**/api/plugins/memento/delegation")
  write.hold()
  await opener.click()
  await pick("gpt-5-mini", "openai/gpt-5-mini")
  assert.ok(await opener.isDisabled(), "the field is greyed out while saving")
  assert.equal(await field.getByRole("status").count(), 1, "the heading shows a save is happening")
  await page.waitForTimeout(300)
  assert.equal(writes.length, 1, "and only the one write went out")
  await shot("saving")
  write.release()
  await until(
    async () => (await hosted())?.model === "openai/gpt-5-mini",
    10_000,
    "the host to record the second-opinion model",
  )
  assert.deepEqual(await hosted(), { provider: "openrouter", model: "openai/gpt-5-mini" })
  await opener.getByText("openrouter/openai/gpt-5-mini").waitFor()
  assert.equal(await field.getByRole("status").count(), 0, "the heading is quiet once it landed")
  assert.ok(!(await opener.isDisabled()), "and the field is usable again")
  await shot("picked")
  // Read back from the host, not from what this page remembers: a reload shows its record.
  await page.reload()
  await opener.getByText("openrouter/openai/gpt-5-mini").waitFor({ timeout: 15_000 })

  // Clearing it puts every delegated task back on the bot's own model.
  await opener.click()
  await picker.getByRole("button", { name: "Same as the bot" }).first().click()
  await until(async () => (await hosted()) === null, 10_000, "the host to clear the pick")
  await opener.getByText("Same as the bot").waitFor()
  assert.equal(writes.length, 2, "the clear is a write of its own")
  await shot("cleared")

  // The bot's projects are beside it as links, one tap from the switch the user is thinking about.
  const link = page.getByRole("link", { name: "Gots" })
  assert.equal(await link.getAttribute("href"), `/projects/${profileId}/p_1a2b3c4d`)
  await page.getByRole("link", { name: "Maze" }).waitFor()
  await shot("projects")

  // A host whose plugin can't record a delegation model shows no field at all — and its projects
  // are still one tap away.
  await page.route("**/api/plugins/memento/info", async (route) => {
    const info = await (await route.fetch()).json()
    await route.fulfill({
      json: { ...info, features: info.features.filter((name) => name !== "delegation_model") },
    })
  })
  await page.reload()
  await page.getByRole("link", { name: "Gots" }).waitFor({ timeout: 15_000 })
  assert.equal(await page.locator("#delegation-model").count(), 0, "no picker without the feature")
  assert.equal(await field.count(), 0, "and no field around it")
  await shot("no-picker")
  await page.unroute("**/api/plugins/memento/info")
  await page.reload()
  await opener.waitFor({ timeout: 15_000 })

  await page.getByRole("link", { name: "Gots" }).click()
  await page.waitForURL(`**/projects/${profileId}/p_1a2b3c4d`)
  pass("the host recorded the second-opinion model, cleared it, and the projects open from here")
})
