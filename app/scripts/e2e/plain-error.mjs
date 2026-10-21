// A turn Hermes can't finish, before it says anything: the chat shows why as an error line on the
// page, marked, with no bubble and no picture of the bot — the way every reply is drawn.
import { app, assert, flow, pass, runId } from "./lib.mjs"

const REFUSED = "The model provider didn't respond."

async function body({ page, seed, send, shot, until, lastReply }) {
  const chat = `e2e-plain-error-${runId()}`
  await seed([{ id: chat, title: "A turn that fails" }])
  await page.goto(`${app}/c/${chat}`)
  const row = (text) => page.locator("[data-slot=message]").filter({ hasText: text })

  // A reply that lands: the bot answers on the page, with no bubble and no picture beside it.
  await send("sort the logs by size")
  await until(async () => (await lastReply(chat))?.status === "done", 30_000, "the first reply")
  const landed = row("clean up the rotated files")
  await landed.waitFor({ timeout: 10_000 })
  assert.equal(await landed.locator("[data-slot=message-avatar]").count(), 0, "no picture of the bot")
  assert.equal(await landed.locator("[data-slot=bubble]").count(), 0, "no bubble")

  // A turn that dies before it says anything: the error is the whole row, and what tells it apart
  // from the reply above is its mark, not its shape.
  await send("fail the turn")
  await until(async () => (await lastReply(chat))?.status === "error", 30_000, "the failed turn")
  const failed = row(REFUSED)
  await failed.waitFor({ timeout: 10_000 })
  assert.equal(await failed.locator("[data-slot=message-avatar]").count(), 0, "no picture of the bot")
  assert.equal(await failed.locator("[data-slot=bubble]").count(), 0, "no bubble either")
  const mark = failed.locator("[role=img][aria-label='Failed']")
  assert.equal(await mark.count(), 1, "and a mark that says it went wrong")
  await shot("error")
}

// The error line has to read right on a laptop and on a phone in the dark.
for (const width of [1440, 390]) {
  const look = width < 768 ? "phone-dark" : "laptop"
  await flow(`plain-error-${look}`, body, {
    viewport: { width, height: width < 768 ? 844 : 900 },
    dark: width < 768,
  })
}

pass("a failed turn reads as an error line on the page, marked, with no bubble or picture")
