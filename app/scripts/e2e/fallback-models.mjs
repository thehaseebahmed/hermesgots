// A bot's fallback models: its settings screen records them on the host, in order, takes one away,
// never offers a third, and greys the rows out while a write is on its way there.
import { app, assert, flow, mock, pass } from "./lib.mjs"

await flow("fallback-models", async ({ page, profileId, until, shot, held }) => {
  // The host's own record, which is what the screen must be writing.
  const hosted = async () => {
    const response = await fetch(`${mock}/api/plugins/memento/fallbacks`)
    return (await response.json()).fallbacks
  }
  // The picker is a dialog over the settings screen, where a row for the same model may already be
  // on show, so every pick inside it is scoped to it.
  const picker = page.getByRole("dialog")
  const pick = async (query, label) => {
    await picker.getByRole("textbox", { name: "Search models" }).fill(query)
    await picker.getByRole("button", { name: label }).first().click()
  }
  // The whole field, so the heading's saving icon and the rows are read where they render.
  const field = page.getByRole("group", { name: "Fallback models" })
  // Every fallback write the page sends, so the greying out is checked against what goes to the host
  // and not only against how the rows look.
  const writes = []
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/plugins/memento/fallbacks"))
      writes.push(request.url())
  })

  // A dev's mock may be holding another run's fallbacks, so start from none.
  await fetch(`${mock}/api/plugins/memento/fallbacks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fallbacks: [] }),
  })
  assert.deepEqual(await hosted(), [])

  await page.goto(`${app}/settings/bots/${profileId}/models`)
  const add = page.getByRole("button", { name: "Add fallback" })
  await add.waitFor({ timeout: 15_000 })

  // A pick is written whole, so while it is on its way the rows are greyed out and the heading says
  // so: a second pick can't overlap the one already going out.
  const write = await held("**/api/plugins/memento/fallbacks")
  write.hold()
  await add.click()
  await pick("gpt-5-mini", "openai/gpt-5-mini")
  await page.locator("#fallback-1").waitFor()
  assert.ok(await page.locator("#fallback-1").isDisabled(), "the row is greyed out while saving")
  assert.ok(
    await page.getByRole("button", { name: "Remove fallback 1" }).isDisabled(),
    "so is its remove",
  )
  assert.ok(await add.isDisabled(), "and no second pick can start")
  assert.equal(await field.getByRole("status").count(), 1, "the heading shows a save is happening")
  await page.waitForTimeout(300)
  assert.equal(writes.length, 1, "and only the one write went out")
  await shot("saving")
  write.release()
  await until(async () => (await hosted()).length === 1, 10_000, "the host to record the first fallback")
  await page.locator("#fallback-1").getByText("openrouter/openai/gpt-5-mini").waitFor()
  assert.equal(await field.getByRole("status").count(), 0, "the heading is quiet once it landed")
  assert.ok(!(await add.isDisabled()), "and the rows are usable again")

  await add.click()
  await pick("claude-opus-4-1", "claude-opus-4-1")
  await until(async () => (await hosted()).length === 2, 10_000, "the host to record the second fallback")
  assert.deepEqual(await hosted(), [
    { provider: "openrouter", model: "openai/gpt-5-mini" },
    { provider: "anthropic", model: "claude-opus-4-1" },
  ])
  await page.locator("#fallback-2").getByText("anthropic/claude-opus-4-1").waitFor()
  assert.equal(writes.length, 2, "and the second pick is a write of its own")
  await shot("two")
  // Two is what a bot takes: with both recorded there is no row to add a third, and no arrow to
  // reorder them.
  assert.equal(await add.count(), 0)
  assert.equal(await page.getByRole("button", { name: /Move fallback/ }).count(), 0)

  await page.getByRole("button", { name: "Remove fallback 1" }).click()
  await until(async () => (await hosted()).length === 1, 10_000, "the host to drop the one that was removed")
  assert.deepEqual(await hosted(), [{ provider: "anthropic", model: "claude-opus-4-1" }])
  await shot("removed")
  pass("the host recorded two fallbacks in order, and the removal")
})
