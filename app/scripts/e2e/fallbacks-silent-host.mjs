// A host that takes a fallback write and never answers it: the field is given up on and comes back
// on its own, rather than staying greyed out with a save that never lands.
import { app, assert, flow, mock, pass } from "./lib.mjs"

await flow("fallbacks-silent-host", async ({ page, profileId, until, shot }) => {
  const add = page.getByRole("button", { name: "Add fallback" })
  const field = page.getByRole("group", { name: "Fallback providers" })
  // The host's own record, so an answer it gave can be told from a pick the app made.
  const hosted = async () => {
    const response = await fetch(`${mock}/api/plugins/memento/fallbacks`)
    return (await response.json()).fallbacks
  }

  // A dev's mock may be holding another run's fallbacks, so start from none.
  await fetch(`${mock}/api/plugins/memento/fallbacks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fallbacks: [] }),
  })
  assert.deepEqual(await hosted(), [])

  await page.goto(`${app}/settings/bots/${profileId}/models`)
  await add.waitFor({ timeout: 15_000 })

  // Reads are answered as usual; the write is left hanging, as a host that took it and stalled.
  await page.route("**/api/plugins/memento/fallbacks", (route) =>
    route.request().method() === "POST" ? new Promise(() => {}) : route.continue(),
  )

  await add.click()
  const picker = page.getByRole("dialog")
  await picker.getByRole("textbox", { name: "Search models" }).fill("gpt-5-mini")
  await picker.getByRole("button", { name: "openai/gpt-5-mini" }).first().click()

  // While it waits, the pick is on show, greyed out, with the heading saving.
  await page.locator("#fallback-1").waitFor({ timeout: 15_000 })
  assert.ok(await page.locator("#fallback-1").isDisabled(), "the pick on show is greyed out")
  assert.equal(await field.getByRole("status").count(), 1, "with the heading saying a save is on")
  await shot("waiting")

  // `WRITE_TIMEOUT_MS` (src/lib/freshness.ts) is the window: past it the field has to be usable
  // again, and the pick that never landed off the rows rather than left on them for good.
  await until(async () => !(await add.isDisabled()), 40_000, "the field to come back on its own")
  assert.equal(await field.getByRole("status").count(), 0, "the heading is quiet again")
  assert.deepEqual(await hosted(), [], "the host, which never answered, holds what it did")
  assert.equal(await page.locator("#fallback-1").count(), 0, "and no row is left from the pick")
  await shot("recovered")
  pass("a host that never answers its write gives the field back instead of wedging it")
})
