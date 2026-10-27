// The agent's todo list shows above the composer while the reply that wrote it still runs, whether
// the app follows the run's events or (a Hermes whose events stream the browser can't read) the
// transcript.
import { assert, flow, pass } from "./lib.mjs"

await flow("todos", async ({ page, newChat, until, shot }) => {
  const chatId = await newChat({ title: "Todos" })
  await page.evaluate(async (id) => {
    const { sendMessage } = await import("/src/lib/chat.ts")
    void sendMessage(id, "plan where the disk space went")
  }, chatId)
  const shown = await until(
    () =>
      page.evaluate(async (id) => {
        const { db } = await import("/src/lib/db.ts")
        const conversation = await db.conversations.get(id)
        const messages = await db.messages.where("conversationId").equals(id).toArray()
        const reply = messages.find((m) => m.role === "assistant")
        const items = conversation?.todos?.items ?? []
        return items.length && reply?.status === "streaming" ? { items: items.length } : null
      }, chatId),
    20_000,
    "the todo list while the reply runs",
  )
  await page.getByRole("button", { name: /\d+\/\d+ todos/ }).first().waitFor({ timeout: 5_000 })
  await shot("running")
  assert.ok(shown.items > 0)
  pass(`the todo list showed ${shown.items} items while the reply ran`)
})
