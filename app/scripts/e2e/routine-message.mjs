// A routine's delivery is a row of the bot's own list (G4): the host publishes one record per run,
// the list draws it wearing the routine's icon and the delivery's first line, and opening it draws
// the run's transcript read-only — no composer, and the sentence saying why — at 390 and 1024px in
// both themes.
//
// This flow used to assert the other premise: a delivery written into the chat that asked for it as an
// assistant row of the bot's own, opening as an aside, with a chip above it that opened the run in a
// sheet. The chip and the sheet are gone and a delivery no longer lands in a chat at all, so what the
// browser's own width is needed for survives: the record the host publishes reaching the device's
// list, and the run's own screen reading the session it names.
import { app, assert, flow, pass } from "./lib.mjs"

const ROW = 'a[href^="/c/routine-"]'
const SCREEN = "[data-routine-chat]"
const NOTE = "[data-slot=routine-note]"
const TITLE = "Morning watch"
const SAID = "The tide turns at 06:40"
/** The run's own prompt: the transcript on its screen is its session, read whole. */
const ASKED = "Watch the tide and tell me in a chat when it turns."

/** The same claims at every look: the list's row, then the run read-only where the row leads. */
async function drive({ page, profileId, send, newChat, lastReply, until, shot }) {
  // The routine is asked for in a chat of its own; its delivery is a row of the bot's list, not
  // something said in this thread.
  const chatId = await newChat({ title: "Watching the tide" })
  await send("routine message")
  await page
    .locator("[aria-label=Messages]")
    .getByText("I'll watch the tide and tell you when it turns.")
    .waitFor({ timeout: 30_000 })
  await until(
    async () => {
      const reply = await lastReply(chatId)
      return reply?.status === "done"
    },
    20_000,
    "the reply to finish",
  )
  // The row is the host's record, and this device reads its chats when the app starts: the list is
  // reached by its own address, the way a reader finds it after closing the app.
  await page.goto(`${app}/b/${profileId}`)
  await until(async () => (await page.locator(ROW).count()) > 0, 30_000, "the routine's row")
  const row = page.locator(ROW).first()
  const words = await row.innerText()
  assert.match(words, new RegExp(TITLE), "the row names the routine")
  assert.match(words, new RegExp(SAID), "and carries the delivery's first line")
  assert.equal(
    await row.locator("svg.lucide-timer").count(),
    1,
    "the row wears the routine's icon rather than a chat's",
  )
  assert.equal(await row.locator("svg.lucide-message-circle").count(), 0, "no chat's icon on it")
  await shot("list")

  await row.click()
  await until(async () => (await page.locator(SCREEN).count()) === 1, 20_000, "the run's screen")
  const screen = page.locator(SCREEN)
  await screen.getByText(SAID).first().waitFor({ timeout: 20_000 })
  assert.ok(
    (await screen.innerText()).includes(ASKED),
    "the run's own session is what was read, its prompt as well as its answer",
  )
  assert.equal(await screen.getByRole("textbox").count(), 0, "a run's screen carries no composer")
  assert.match(
    await page.locator(NOTE).innerText(),
    /won't take a reply/i,
    "and the composer's place says why nothing can be sent",
  )
  await shot("run")

  // The way back is the bot's list, where this screen is the one the list pushed; where the list keeps
  // its lane beside the run, there is nothing to lead back to and the row stays on screen.
  const back = page.getByRole("button", { name: /^Back to / })
  if (await back.count()) {
    await back.click()
    await until(
      async () => new URL(page.url()).pathname === `/b/${profileId}`,
      10_000,
      "the bot's list",
    )
    assert.equal(await page.locator(SCREEN).count(), 0, "and the run's screen is what was left")
    await shot("back")
  } else {
    assert.ok(await page.locator(ROW).first().isVisible(), "the list stays beside the run")
  }
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

pass("a routine's delivery listed as its own row, and its run opened read-only with no composer")
