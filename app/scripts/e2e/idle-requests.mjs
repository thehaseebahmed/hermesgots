// An open chat with nothing happening asks its server little: a catch-up probe on its timer, and
// the chat's details only now and then. Counts the requests over 65s on the polling mock.
import { app, assert, flow, pass } from "./lib.mjs"

await flow("idle-requests", async ({ page, send, until }) => {
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
  await page.waitForTimeout(5_000)
  const seen = []
  page.on("request", (request) => {
    const url = new URL(request.url())
    if (url.port === new URL(process.env.MOCK_URL).port && request.method() !== "OPTIONS")
      seen.push(url.pathname.replace(/memento-[\w-]+/, "<chat>"))
  })
  await page.waitForTimeout(65_000)
  const counts = Object.entries(Object.groupBy(seen, (path) => path))
    .map(([path, hits]) => `${hits.length}× ${path}`)
    .join(", ")
  assert.ok(seen.length <= 12, `${seen.length} requests in 65s: ${counts}`)
  pass(`${seen.length} requests in 65s with the chat idle: ${counts}`)
})
