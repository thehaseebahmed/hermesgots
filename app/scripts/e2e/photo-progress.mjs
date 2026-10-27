// A message sent with a photo shows the reply's progress (its tool calls) while it runs, on a Hermes
// whose events stream the browser can't read, so the app follows the turn in the transcript.
import { assert, flow, pass } from "./lib.mjs"

await flow("photo-progress", async ({ page, newChat, until, shot }) => {
  const chatId = await newChat({ title: "Photo" })
  await page.evaluate(async (id) => {
    const { prepareAttachment } = await import("/src/lib/attachments.ts")
    const { sendMessage } = await import("/src/lib/chat.ts")
    const canvas = Object.assign(document.createElement("canvas"), { width: 8, height: 8 })
    const blob = await new Promise((done) => canvas.toBlob(done, "image/png"))
    const photo = await prepareAttachment(new File([blob], "photo.png", { type: "image/png" }))
    void sendMessage(id, "what's in this photo?", { attachments: [photo] })
  }, chatId)
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
