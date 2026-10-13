// A streaming reply is written to IndexedDB in batches, not on every token: each write re-runs
// every live query over the chat. Counts the reply's writes per second while it streams.
import { app, assert, flow, pass } from "./lib.mjs"

await flow("stream-writes", async ({ page, send, until }) => {
  await page.goto(app)
  await page.evaluate(async () => {
    const { db } = await import("/src/lib/db.ts")
    window.__writes = []
    db.messages.hook("updating", (changes, id, message) => {
      if (message.role === "assistant" && message.status === "streaming")
        window.__writes.push(Date.now())
    })
  })
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
  const writes = await page.evaluate(() => window.__writes)
  const seconds = Math.max(1, (writes.at(-1) - writes[0]) / 1000)
  const rate = writes.length / seconds
  assert.ok(writes.length > 1, "the reply was written while it streamed")
  assert.ok(rate <= 6, `${writes.length} writes in ${seconds.toFixed(1)}s is ${rate.toFixed(1)}/s`)
  pass(
    `${writes.length} writes in ${seconds.toFixed(1)}s while the reply streamed (${rate.toFixed(1)}/s)`,
  )
})
