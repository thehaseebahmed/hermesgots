// A turn Hermes can't finish, before it says anything: the chat shows why as plain text, with no
// picture of the bot beside it. The reply that landed there a moment before still wears one, so the
// check says something.
import { app, assert, flow, pass, runId } from "./lib.mjs"

const REFUSED = "The model provider didn't respond."

async function body({ page, seed, send, shot, until, lastReply }) {
  const chat = `e2e-plain-error-${runId()}`
  await seed([{ id: chat, title: "A turn that fails" }])
  await page.goto(`${app}/c/${chat}`)
  const row = (text) => page.locator("[data-slot=message]").filter({ hasText: text })

  // A reply that lands: the bot answers, its picture beside the bubble.
  await send("sort the logs by size")
  await until(async () => (await lastReply(chat))?.status === "done", 30_000, "the first reply")
  const landed = row("clean up the rotated files")
  await landed.waitFor({ timeout: 10_000 })
  assert.equal(
    await landed.locator("[data-slot=message-avatar]").count(),
    1,
    "a landed reply shows the bot beside it",
  )

  // A turn that dies before it says anything: the error is the whole row, and it is text.
  await send("fail the turn")
  await until(async () => (await lastReply(chat))?.status === "error", 30_000, "the failed turn")
  const failed = row(REFUSED)
  await failed.waitFor({ timeout: 10_000 })
  assert.equal(await failed.locator("[data-slot=message-avatar]").count(), 0, "no bot beside an error")
  assert.equal(await failed.locator("[data-slot=bubble]").count(), 0, "an error is plain text")
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

pass("a failed turn reads as plain text, with no bot beside it")
