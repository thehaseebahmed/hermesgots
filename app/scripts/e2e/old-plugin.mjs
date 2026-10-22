// A host that hasn't moved to the Gots plugin answers only at /api/plugins/memento. The app asks
// at the new name first, finds the old name answers as the old plugin, and carries on there: the
// chat list syncs and a chat sends, with the new name asked a few times at most, not on every call.
import { app, assert, flow, pass } from "./lib.mjs"

await flow("old-plugin", async ({ page, send, until }) => {
  const mockPort = new URL(process.env.MOCK_URL).port
  const seen = { gots: 0, memento: 0, mementoOk: 0 }
  page.on("request", (request) => {
    const url = new URL(request.url())
    if (url.port !== mockPort || request.method() === "OPTIONS") return
    if (url.pathname.startsWith("/api/plugins/gots/")) seen.gots++
    if (url.pathname.startsWith("/api/plugins/memento/")) seen.memento++
  })
  page.on("response", (response) => {
    const url = new URL(response.url())
    if (url.port === mockPort && url.pathname.startsWith("/api/plugins/memento/") && response.ok())
      seen.mementoOk++
  })
  await page.goto(app)
  await send("hello there")
  await page.waitForURL("**/c/**", { timeout: 15_000 })
  const chatId = new URL(page.url()).pathname.split("/").at(-1)
  await until(
    () =>
      page.evaluate(async (id) => {
        const { db } = await import("/src/lib/db.ts")
        const messages = await db.messages.where("conversationId").equals(id).toArray()
        return messages.some((m) => m.role === "assistant" && m.status === "done")
      }, chatId),
    30_000,
    "the reply to finish",
  )
  await page.waitForTimeout(3_000)
  assert.ok(seen.mementoOk > 0, "no plugin route was answered at the old name")
  assert.ok(
    seen.gots <= 6,
    `the new name was asked ${seen.gots} times; the app should remember the old one after the first miss`,
  )
  pass(
    `answered at the old name ${seen.mementoOk} times, the new name asked ${seen.gots} times in all`,
  )
})
