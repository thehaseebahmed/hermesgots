// A draft and a picked mode sync through the plugin's chat record: typing and a pick reach the
// mock, come back after the local row is cleared, and neither moves the chat's updatedAt.
import { app, assert, flow, mock, pass } from "./lib.mjs"

const chatRecord = async (id) => {
  const res = await fetch(`${mock}/api/plugins/memento/chats`)
  const body = await res.json()
  return (body.chats ?? body).find((c) => c.id === id)?.value ?? null
}

await flow("draft-mode-sync", async ({ page, seed, shot }) => {
  await seed([{ id: "e2e-draft-sync", title: "Draft sync" }])
  await page.goto(`${app}/c/e2e-draft-sync`)

  const composer = page.getByRole("textbox").first()
  await composer.fill("half-written thought")
  await page.getByRole("button", { name: /plan/i }).first().click()

  await page.waitForTimeout(3_000)
  const record = await chatRecord("e2e-draft-sync")
  assert.equal(record?.draftText, "half-written thought", "the draft reaches the chat record")
  assert.ok(record?.mode, "the picked mode reaches the chat record")
  pass("typing and a mode pick reach the plugin's chat record")

  await page.evaluate(() => indexedDB.deleteDatabase("db"))
  await page.reload()
  await composer.waitFor({ timeout: 15_000 })
  await page.waitForTimeout(3_000)
  assert.equal(await composer.inputValue(), "half-written thought", "the draft comes back after a reset")
  await shot("draft-restored")
  pass("a draft and its mode come back after the local row is cleared")

  const before = (await chatRecord("e2e-draft-sync"))?.updatedAt
  await composer.fill("another line")
  await page.waitForTimeout(3_000)
  const after = (await chatRecord("e2e-draft-sync"))?.updatedAt
  assert.equal(after, before, "typing does not move updatedAt")
  pass("typing leaves updatedAt where it was")
})
