import { app, assert, flow, mock, pass } from "./lib.mjs"

await flow("delegation-model", async ({ page, profileId, until, shot, held }) => {
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
  // The row is the control: no chevron, no button inside it (ADR 0055).
  const field = page.locator('[data-setting="subagent-model"]')
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

  await page.goto(`${app}/settings/bots/${profileId}/general`)
  await field.waitFor({ timeout: 15_000 })
  await field.getByText("Default model").waitFor()
  await shot("inherited")

  // A pick is written whole, so while it is on its way the field is greyed out and says so.
  const write = await held("**/api/plugins/memento/delegation")
  write.hold()
  await field.click()
  await pick("gpt-5-mini", "openai/gpt-5-mini")
  assert.ok(await field.isDisabled(), "the field is greyed out while saving")
  assert.equal(await field.getAttribute("aria-busy"), "true", "the row says a save is happening")
  await until(async () => writes.length >= 1, 5_000, "the pick's write to go out")
  assert.equal(writes.length, 1, "and only the one write went out")
  await shot("saving")
  write.release()
  await until(
    async () => (await hosted())?.model === "openai/gpt-5-mini",
    10_000,
    "the host to record the subagent model",
  )
  assert.deepEqual(await hosted(), { provider: "openrouter", model: "openai/gpt-5-mini" })
  await field.getByText("openrouter/openai/gpt-5-mini").waitFor()
  assert.equal(await field.getAttribute("aria-busy"), null, "the row is quiet once it landed")
  assert.ok(!(await field.isDisabled()), "and the field is usable again")
  await shot("picked")
  // Read back from the host, not from what this page remembers: a reload shows its record.
  await page.reload()
  await field.getByText("openrouter/openai/gpt-5-mini").waitFor({ timeout: 15_000 })

  await field.click()
  await picker.getByRole("button", { name: "Default model" }).first().click()
  await until(async () => (await hosted()) === null, 10_000, "the host to clear the pick")
  await field.getByText("Default model").waitFor()
  assert.equal(writes.length, 2, "the clear is a write of its own")
  await shot("cleared")

  await page.route("**/api/plugins/memento/info", async (route) => {
    const info = await (await route.fetch()).json()
    await route.fulfill({
      json: { ...info, features: info.features.filter((name) => name !== "delegation_model") },
    })
  })
  await page.reload()
  await page.getByRole("button", { name: "Test connection" }).waitFor({ timeout: 15_000 })
  assert.equal(await field.count(), 0, "no picker without the feature")
  assert.equal(await field.count(), 0, "and no row around it")
  await shot("no-picker")

  pass("the host recorded the subagent model, cleared it, and offered no row without it")
})
