// A room of two bots of one Host: the sidebar lists it without ever having opened it, a message sent
// into it runs the members' rounds on the Host with no client attached, and the screen draws each
// reply with its member's name and picture, the who-is-working line while a turn runs, the third
// round's bound, and a member that passes as nothing at all. A reload lands on the same transcript,
// read from the device rather than the Host.
import { assert, flow, mock, pass } from "./lib.mjs"

const SENT = "Plan the next release."
const FIRST = "I'll take the API and the routes."
const SECOND = "Coder here. I'll take the screen and the tests."
const BOUND = "The room stopped at its round limit."

await flow("rooms", async ({ page, until, shot }) => {
  // The room's members are Hermes profiles, so this device holds a bot for each of them: the bot the
  // flow set up is the Host's own profile, and a second one stands for the other member.
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

  // The room's row reaches every device from the Host's own projection into the chat list.
  const row = page.getByRole("link", { name: /Planning/ })
  await row.waitFor({ timeout: 20_000 })
  await row.click()
  await page.waitForURL("**/c/room-planning", { timeout: 15_000 })

  const field = page.getByLabel("Message the room", { exact: true })
  await field.waitFor({ timeout: 15_000 })
  await field.fill(SENT)
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await page.getByText(SENT).first().waitFor({ timeout: 15_000 })

  // While a member's turn runs, the room says who is working — and only while it does.
  const working = page.locator('[data-slot="room-working"]')
  await working.waitFor({ timeout: 15_000 })
  assert.match(await working.innerText(), /is working…/, "the working line names the member")

  // The first member answers, the second passes (which draws nothing), and the second round's reply
  // lands after it; the third round is the Host's bound.
  await page.getByText(FIRST).first().waitFor({ timeout: 20_000 })
  await page.getByText(BOUND).first().waitFor({ timeout: 20_000 })
  const rows = page.locator('[data-slot="room-row"]:not([data-kind="notice"])')
  await until(
    async () => ((await rows.count()) === 3 ? true : null),
    20_000,
    "the room's three rows",
  )

  const drawn = await rows.allInnerTexts()
  assert.deepEqual(
    drawn.map((text) => text.split("\n").at(-1).trim()),
    [SENT, FIRST, SECOND],
    "the pass drew nothing: a round of two members, one of whom stayed silent, is three rows",
  )

  // Each member's reply carries its name and its bot's picture; the user's own message carries
  // neither, and the screen's header names the room and its members.
  const hermes = rows.filter({ hasText: FIRST })
  const coder = rows.filter({ hasText: SECOND })
  assert.match(await hermes.innerText(), /Hermes/, "the reply names its member")
  assert.match(await coder.innerText(), /Coder/, "the other reply names its member")
  assert.equal(await hermes.locator("img").count(), 1, "a member's bubble draws its bot's picture")
  assert.equal(await coder.locator("img").count(), 1, "and the other member's its own")
  assert.notEqual(
    await hermes.locator("img").getAttribute("src"),
    await coder.locator("img").getAttribute("src"),
    "two members, two pictures",
  )
  await page.getByText("Hermes, Coder").first().waitFor({ timeout: 5_000 })
  assert.equal(
    await working.count(),
    0,
    "the room is at rest once its rounds have settled, so no line is drawn",
  )
  await shot("transcript")

  // A reload lands on the same transcript: what the device read is what it draws, and the Host is
  // asked only for what came after it.
  await page.reload()
  await page.getByText(FIRST).first().waitFor({ timeout: 20_000 })
  await page.getByText(SECOND).first().waitFor({ timeout: 20_000 })
  await page.getByText(BOUND).first().waitFor({ timeout: 20_000 })
  const again = await page
    .locator('[data-slot="room-row"]:not([data-kind="notice"])')
    .allInnerTexts()
  assert.deepEqual(
    again.map((text) => text.split("\n").at(-1).trim()),
    [SENT, FIRST, SECOND],
    "a reload reads the same rows back from the device",
  )
  await shot("reloaded")
  pass(
    `a room's message ran three rounds — ${FIRST.length} and ${SECOND.length} characters of reply`,
  )
})
