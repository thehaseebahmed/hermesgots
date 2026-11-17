// A routine's delivery is a marker in its bot's Main: the host publishes one record per run, Main draws
// it as one line saying what ran and for how long, and opening it draws the run's transcript read-only
// — no composer, and the sentence saying why — at 390 and 1024px in both themes. The way back is Main.
import { app, assert, flow, pass } from "./lib.mjs"

const MARKER = "[data-slot=routine-marker]"
const LINK = "[data-slot=routine-marker-link]"
const SCREEN = "[data-routine-chat]"
const NOTE = "[data-slot=routine-note]"
const SAID = "The tide turns at 06:40"
/** The run's own prompt: the transcript on its screen is its session, read whole. */
const ASKED = "Watch the tide and tell me in a chat when it turns."
const MAIN = "e2e-main"

/** The same claims at every look: the marker in Main, then the run read-only where it leads. */
async function drive({ page, profileId, seed, send, newChat, lastReply, until, shot }) {
  // The routine is asked for in a chat of its own; its delivery is a marker in Main, not a row of a
  // list and not something said in this thread.
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
  // Main is the host's record, written to the device the way the plugin's list answer leaves it.
  await seed([{ id: MAIN, title: "Bot Chat", main: true, createdAt: 1, updatedAt: 2 }])
  await page.goto(`${app}/b/${profileId}`)
  await until(async () => (await page.locator(MARKER).count()) > 0, 30_000, "the routine's marker")
  const marker = page.locator(MARKER).first()
  assert.equal(
    (await marker.innerText()).trim(),
    'Routine "Morning watch" ran for 2 min 5 secs',
    "Main says what ran and for how long",
  )
  // The mock keeps every delivery of the flows before this one, so a marker is one per run, not one.
  assert.equal(
    await page.locator(MARKER).locator(LINK).count(),
    await page.locator(MARKER).count(),
    "and each marker is its own press",
  )
  assert.equal(
    await page.locator('a[href^="/c/routine-"]:not([data-slot=routine-marker-link])').count(),
    0,
    "while no list draws a row for a run",
  )
  await shot("main")

  await page.locator(LINK).first().click()
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

  // The way back is Main, where the marker that opened the run stands.
  await page.getByRole("button", { name: /^Back to / }).click()
  await until(
    async () => (await page.locator(MARKER).count()) > 0,
    10_000,
    `the bot's Main (at ${page.url()})`,
  )
  assert.equal(await page.locator(SCREEN).count(), 0, "and the run's screen is what was left")
  await shot("back")
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

pass("a routine's delivery drawn as a marker in Main, and its run opened read-only with no composer")
