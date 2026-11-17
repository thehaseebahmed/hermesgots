// A new chat, in the flat layout: the list's New chat opens the blank surface, a bare Enter in its
// composer inserts a line and starts no run, the chord sends, and the reply lands with the chat a row
// of the list it was started from. The browser's own default action on Enter is the claim, so the
// flow runs in a browser (ADR 0019); the flat layout is the one with a New chat on a list (ADR 0162).
import { assert, app, flow, pass } from "./lib.mjs"

await flow("chat-message", async ({ page, profileId, until, shot }) => {
  await page.evaluate(async () => {
    const { saveSettings } = await import("/src/lib/db.ts")
    await saveSettings({ legacyChat: true })
  })
  // Home is the active bot's entry, which under this layout is its one list.
  await page.goto(app)
  await page.waitForURL(`**/b/${profileId}`, { timeout: 15_000 })
  await page.getByRole("button", { name: "New", exact: true }).click()
  await page.getByRole("button", { name: "New chat", exact: true }).click()
  await page.waitForURL("**/c/**", { timeout: 15_000 })
  const composer = page.getByLabel("Message", { exact: true })
  await composer.waitFor({ timeout: 15_000 })
  const started = new URL(page.url()).pathname

  await composer.fill("a first line")
  await composer.press("Enter")
  assert.equal(await composer.inputValue(), "a first line\n", "Enter inserted a line, not a send")
  assert.equal(new URL(page.url()).pathname, started, "and no second chat was started")
  assert.equal(
    await page.evaluate(async (id) => {
      const { db } = await import("/src/lib/db.ts")
      return db.messages.where("conversationId").equals(id.slice(3)).count()
    }, started),
    0,
    "nothing was said",
  )

  await composer.fill("sent by the chord")
  await composer.press("Control+Enter")
  await page.getByText("sent by the chord").first().waitFor({ timeout: 15_000 })
  assert.equal(await composer.inputValue(), "", "the chord sent, so the field let the words go")
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
  await shot("reply")

  // The chat is a row of the list it was started from, which is the one screen of the layout.
  await page.getByRole("button", { name: "Back to Test bot" }).click()
  await page.waitForURL(`**/b/${profileId}`, { timeout: 15_000 })
  await page.locator(`main ul a[href="${started}"]`).first().waitFor({ timeout: 15_000 })
  pass(`a new chat sent its message and got a ${reply.length}-character reply`)
})
