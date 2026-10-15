// A bot's fallback models: its settings screen records them on the host, in order, moves one up,
// takes one away, and never offers a third.
import { app, assert, flow, mock, pass } from "./lib.mjs"

await flow("fallback-models", async ({ page, profileId, until, shot }) => {
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

  // A dev's mock may be holding another run's fallbacks, so start from none.
  await fetch(`${mock}/api/plugins/memento/fallbacks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fallbacks: [] }),
  })
  assert.deepEqual(await hosted(), [])

  await page.goto(`${app}/settings/bots/${profileId}`)
  const add = page.getByRole("button", { name: "Add fallback" })
  await add.waitFor({ timeout: 15_000 })

  await add.click()
  await pick("gpt-5-mini", "openai/gpt-5-mini")
  await until(async () => (await hosted()).length === 1, 10_000, "the host to record the first fallback")
  await page.locator("#fallback-1").getByText("openrouter/openai/gpt-5-mini").waitFor()

  await add.click()
  await pick("claude-opus-4-1", "claude-opus-4-1")
  await until(async () => (await hosted()).length === 2, 10_000, "the host to record the second fallback")
  assert.deepEqual(await hosted(), [
    { provider: "openrouter", model: "openai/gpt-5-mini" },
    { provider: "anthropic", model: "claude-opus-4-1" },
  ])
  await page.locator("#fallback-2").getByText("anthropic/claude-opus-4-1").waitFor()
  await shot("two")
  // Two is what a bot takes: with both recorded there is no row to add a third.
  assert.equal(await add.count(), 0)

  await page.getByRole("button", { name: "Move fallback 2 up" }).click()
  await until(
    async () => (await hosted())[0]?.model === "claude-opus-4-1",
    10_000,
    "the host to hold the two the other way round",
  )
  assert.deepEqual(await hosted(), [
    { provider: "anthropic", model: "claude-opus-4-1" },
    { provider: "openrouter", model: "openai/gpt-5-mini" },
  ])

  await page.getByRole("button", { name: "Remove fallback 1" }).click()
  await until(async () => (await hosted()).length === 1, 10_000, "the host to drop the one that was removed")
  assert.deepEqual(await hosted(), [{ provider: "openrouter", model: "openai/gpt-5-mini" }])
  await shot("removed")
  pass("the host recorded two fallbacks in order, the move and the removal")
})
