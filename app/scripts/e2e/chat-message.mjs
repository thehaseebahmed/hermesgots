// A new chat: type a message, send it, get the whole reply, and find the chat in Recents.
import { assert, app, flow, pass } from "./lib.mjs"

await flow("chat-message", async ({ page, send, lastReply, until, shot }) => {
  await page.goto(app)
  await send("hello there")
  await page.waitForURL("**/c/**", { timeout: 15_000 })
  const chatId = new URL(page.url()).pathname.split("/").at(-1)
  await page.getByText("hello there").first().waitFor()
  const reply = await until(
    async () => {
      const reply = await lastReply(chatId)
      return reply?.status === "done" ? reply : null
    },
    20_000,
    "the reply to finish",
  )
  assert.ok(reply.length > 0, "the reply has text")
  await page.getByRole("navigation", { name: "Recents" }).getByRole("link").first().waitFor()
  await shot("reply")
  pass(`a new chat sent its message and got a ${reply.length}-character reply`)
})
