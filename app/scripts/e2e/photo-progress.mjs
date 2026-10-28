// A message sent with a photo shows the reply's progress (its tool calls) while it runs, on a Hermes
// whose events stream the browser can't read, so the app follows the turn in the transcript.
import { assert, flow, pass } from "./lib.mjs"

await flow("photo-progress", async ({ page, newChat, photo, until, shot }) => {
  const chatId = await newChat({ title: "Photo" })
  await photo(chatId, "what's in this photo?")
  const reply = await until(
    () =>
      page.evaluate(async (id) => {
        const { db } = await import("/src/lib/db.ts")
        const messages = await db.messages.where("conversationId").equals(id).toArray()
        const reply = messages.find((m) => m.role === "assistant")
        return reply?.status === "streaming" && reply.tools?.length ? reply : null
      }, chatId),
    20_000,
    "the running reply to show its tool calls",
  )
  assert.ok(reply.tools.length > 0)
  await shot("running")
  pass(`the photo's reply showed ${reply.tools.length} tool call(s) while it ran`)
})
