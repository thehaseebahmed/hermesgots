// The room needs the user, and the user answers there (F4): a member's approval answered Once and
// then Denied, a member's question answered with one of its choices, a reply addressed to @user
// drawing the room's needs-you mark, and Stop cancelling a round the transcript then says was
// stopped. The rounds run on the Host with no client attached, so every card here came from a read
// of the Host's own state.
import { app, assert, flow, mock, pass, settled } from "./lib.mjs"

const CLEAN = "clean the build"
const APPROVED = "Approved — clearing the build."
const DENIED = "A member's turn was stopped."
const ASK = "which database do we pick?"
const ANSWERED = "Postgres it is — I'll take that."
const HANDOFF = "hand it to @user"
const NEEDS_YOU = "That one is yours to call, @user."
const HOLD = "hold a while"
const STOPPED = "The room was stopped."

/** Waits for the card a room's wait holds the composer's place with, and answers it there. */
async function card(page, kind) {
  const found = page.locator(`[data-slot="room-card"][data-card="${kind}"]`)
  await found.waitFor({ timeout: 20_000 })
  return found
}

await flow("room-waiting", async ({ page, profileId, until, shot }) => {
  // The room's members are Hermes profiles, so this device holds a bot for each of them.
  await page.evaluate(async (baseUrl) => {
    const { addProfile, db } = await import("/src/lib/db.ts")
    const [bot] = await db.profiles.toArray()
    await db.profiles.update(bot.id, { hermesProfile: "default" })
    await addProfile({
      name: "Coder",
      model: "hermes-agent",
      baseUrl: `${baseUrl}/v1`,
      apiKey: (await db.profiles.get(bot.id)).apiKey,
      hermesProfile: "coder",
      pluginChats: true,
    })
  }, mock)

  // The room's row reaches every device from the Host's own projection into the chat list, and it is
  // a row of this bot's list, among its chats.
  await page.goto(`${app}/b/${profileId}`)
  const row = page.getByRole("link", { name: /Planning/ })
  await row.waitFor({ timeout: 20_000 })
  await row.click()
  await page.waitForURL("**/c/room-planning", { timeout: 15_000 })
  const field = page.getByLabel("Message", { exact: true })
  await field.waitFor({ timeout: 15_000 })

  // An approval: the member's turn opens one and waits, the room draws it with the Host's own
  // command, and Once answers it through the Host's own approve.
  await field.fill(CLEAN)
  await page.getByRole("button", { name: "Send", exact: true }).click()
  const approval = await card(page, "approval")
  assert.match(await approval.innerText(), /Approval needed/, "the chat's own approval card")
  assert.match(await approval.innerText(), /Hermes/, "and it names the member asking")
  assert.match(await approval.innerText(), /rm -rf build/, "and the command it asks about")
  assert.equal(
    await approval.getByRole("button", { name: "Always allow" }).count(),
    0,
    "the card offers the two answers the Host's approve takes, and no third",
  )
  await shot("approval")
  await approval.getByRole("button", { name: "Allow once", exact: true }).click()
  await page.getByText(APPROVED).first().waitFor({ timeout: 20_000 })
  await until(
    async () => ((await page.locator('[data-slot="room-card"]').count()) === 0),
    20_000,
    "the approval card to go",
  )

  // The same approval, denied: the Host stops that member's turn, and the transcript says so.
  await field.fill(CLEAN)
  await page.getByRole("button", { name: "Send", exact: true }).click()
  const again = await card(page, "approval")
  await again.getByRole("button", { name: "Deny", exact: true }).click()
  await page.getByText(DENIED).first().waitFor({ timeout: 20_000 })
  await shot("denied")

  // A question: the member asks it with two choices, and the user picks one there.
  await field.fill(ASK)
  await page.getByRole("button", { name: "Send", exact: true }).click()
  const question = await card(page, "question")
  assert.match(await question.innerText(), /Question/, "the chat's own question card")
  assert.match(await question.innerText(), /Coder/, "naming the member asking")
  assert.match(await question.innerText(), /Which database\?/, "and asks the Host's question")

  // The card holds the composer's place and takes the reading column's box at either width: that it
  // is at the foot, and no wider than the column, is geometry no DOM without layout measures.
  for (const { width, height } of [
    { width: 390, height: 844 },
    { width: 1024, height: 900 },
  ]) {
    await page.setViewportSize({ width, height })
    await settled(page)
    const box = await page.evaluate(() => {
      const card = document.querySelector('[data-slot="room-card"] > *')?.getBoundingClientRect()
      const field = document.querySelector('[aria-label="Message"]')?.getBoundingClientRect()
      return {
        viewport: window.innerWidth,
        height: window.innerHeight,
        card: card
          ? { left: card.left, right: card.right, width: card.width, bottom: card.bottom }
          : null,
        field: field ? { left: field.left, right: field.right } : null,
        overflow: document.documentElement.scrollWidth > window.innerWidth,
      }
    })
    assert.ok(box.card, `the question card is drawn at ${width}px`)
    assert.ok(box.card.width <= 672 + 1, `it takes the reading column at ${width}px (${box.card.width}px)`)
    assert.ok(box.card.left >= -1 && box.card.right <= box.viewport + 1, `it stays on screen at ${width}px`)
    assert.equal(box.field, null, `the card holds the composer's place at ${width}px`)
    assert.ok(box.card.bottom <= box.height + 1, `it sits at the foot of the room at ${width}px`)
    assert.ok(!box.overflow, `nothing scrolls sideways at ${width}px`)
    await shot(`question-${width}`)
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await settled(page)
  await question.getByRole("button", { name: /Postgres/ }).click()
  await question.getByRole("button", { name: "Send", exact: true }).click()
  await page.getByText(ANSWERED).first().waitFor({ timeout: 20_000 })
  await until(
    async () => ((await page.locator('[data-slot="room-card"]').count()) === 0),
    20_000,
    "the question card to go",
  )
  await page.getByLabel("Message", { exact: true }).waitFor({ timeout: 15_000 })

  // A reply addressed to @user: the round settles on it, and the room asks for the user.
  await field.fill(HANDOFF)
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await page.getByText(NEEDS_YOU).first().waitFor({ timeout: 20_000 })
  const mark = page.locator('[data-slot="room-needs-you"]')
  await mark.waitFor({ timeout: 20_000 })
  assert.match(await mark.innerText(), /Hermes needs you/, "the mark names the member who asked")
  await shot("needs-you")

  // Stop ends the round where it is, and the room's own log is what says so.
  await field.fill(HOLD)
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await page.locator('[data-slot="room-working"]').waitFor({ timeout: 20_000 })
  const stop = page.getByRole("button", { name: "Stop", exact: true })
  await stop.waitFor({ timeout: 20_000 })
  await stop.click()
  await page.getByText(STOPPED).first().waitFor({ timeout: 20_000 })
  await until(
    async () => ((await page.locator('[data-slot="room-working"]').count()) === 0),
    20_000,
    "the working line to go",
  )
  await shot("stopped")

  // A reload draws the same transcript: what the room said is the Host's log, read back.
  await page.reload()
  await page.getByText(STOPPED).first().waitFor({ timeout: 20_000 })
  await settled(page)


  pass(
    "a room's approval answered Once and Denied, a question answered with its choice, an @user reply drawing needs-you, and a stopped round",
  )
})
