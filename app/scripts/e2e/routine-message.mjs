// A routine's answer arrives in the chat that asked for it, as the bot's own message, with a chip
// that opens the run read-only (ADR 0081). The mock's "routine message" turn answers first and then
// delivers the routine's message into the same chat, which is what a real host does when a job fires.
import { assert, flow, pass } from "./lib.mjs"

const LINE = "[data-slot=routine-receipt] p"
const SHEET = "[data-slot=routine-run]"
const SAID = "the tide turns at 06:40"
const RAN = "The tide turns at 06:40"

/** The two claims are the same at every look: the message stands apart, and its run has no composer. */
async function drive({ page, send, lastReply, until, shot }) {
  await send("routine message")
  await page.waitForURL("**/c/**", { timeout: 15_000 })
  const chatId = new URL(page.url()).pathname.split("/").at(-1)
  await until(
    async () => {
      const reply = await lastReply(chatId)
      return reply?.status === "done" ? reply : null
    },
    20_000,
    "the reply to finish",
  )
  // The routine's row lands after the reply: a reload reads the chat's transcript again, which is
  // where a routine's message is drawn from.
  await page.waitForTimeout(500)
  await page.reload()
  await until(async () => (await page.locator(LINE).count()) === 1, 15_000, "the routine's line")
  const thread = await page.getByRole("main").innerText()
  assert.ok(thread.includes(SAID), "the routine's words are in the thread")
  // The chat was active moments ago, so the message opens as an aside rather than as an answer.
  assert.match(thread, /On a side note, |As a quick aside, /, "the aside opener is there")
  // The line above the words says which run wrote them and how long it took (ADR 0081).
  assert.match(thread, /Ran “Morning watch” in \d/, "the line says how long the run took")
  await shot("message")

  // A reader aims at the sentence, not at the name: the whole line is the target.
  await page.locator(LINE).click({ position: { x: 10, y: 20 } })
  await until(async () => (await page.locator(SHEET).count()) === 1, 10_000, "the run sheet")
  const dialog = page.locator(SHEET)
  assert.equal(await dialog.getByRole("textbox").count(), 0, "the sheet carries no composer")
  const sheet = await dialog.innerText()
  assert.ok(sheet.includes(RAN), "the run's own words are drawn")
  await shot("run")
}

for (const { width, dark } of [
  { width: 390, dark: false },
  { width: 390, dark: true },
  { width: 1024, dark: false },
  { width: 1024, dark: true },
]) {
  await flow(`routine-message-${width}-${dark ? "dark" : "light"}`, drive, {
    viewport: { width, height: width === 390 ? 844 : 768 },
    dark,
  })
}

pass("a routine's message drew as the bot's own, apart from the reply, and its run opened read-only")
