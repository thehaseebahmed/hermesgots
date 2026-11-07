// A new chat in the legacy layout: type a message, send it, get the whole reply, and find the chat
// in Recents. Bot threads is the default, so `/` is the bot's Main unless the legacy switch is on.
import { assert, app, flow, pass } from "./lib.mjs"

await flow("chat-message", async ({ page, send, until, shot }) => {
  await page.evaluate(async () => {
    const { saveSettings } = await import("/src/lib/db.ts")
    await saveSettings({ legacyChat: true })
  })
  await page.goto(app)
  const composer = page.getByLabel("Message", { exact: true })
  await composer.fill("a first line")
  await composer.press("Enter")
  assert.equal(await composer.inputValue(), "a first line\n", "Enter inserted a line, not a send")
  assert.ok(!/\/c\//.test(page.url()), "and no chat was started")
  await composer.fill("sent by the chord")
  await composer.press("Control+Enter")
  await page.waitForURL("**/c/**", { timeout: 15_000 })
  assert.equal(await composer.inputValue(), "", "the chord sent, so the field let the words go")
  await page.getByText("sent by the chord").first().waitFor({ timeout: 15_000 })
  await composer.fill("")
  await send("hello there")
  await page.waitForURL("**/c/**", { timeout: 15_000 })
  await page.getByText("hello there").first().waitFor()
  const reply = await until(
    async () => {
      const replies = await page
        .locator('[data-slot="message"][data-align="start"] [data-slot="markdown"]')
        .allTextContents()
      const last = replies.at(-1)?.trim()
      return last && last.length > 0 ? last : null
    },
    20_000,
    "the reply to finish",
  )
  assert.ok(reply.length > 0, "the reply has text")
  await page.getByRole("navigation", { name: "Recents" }).getByRole("link").first().waitFor()
  await shot("reply")
  pass(`a new chat sent its message and got a ${reply.length}-character reply`)
})
