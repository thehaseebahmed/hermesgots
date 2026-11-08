// A room of two bots of one Host: the sidebar lists it without ever having opened it, a message sent
// into it runs the members' rounds on the Host with no client attached, and the screen draws each
// reply with its member's name and picture, the who-is-working line while a turn runs, the third
// round's bound, and a member that passes as nothing at all. A reload lands on the same transcript,
// read from the device rather than the Host.
import { assert, flow, mock, pass, settled } from "./lib.mjs"

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

  const field = page.getByLabel("Message", { exact: true })
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

  // The screen at every size a device is — a phone, a tablet and a laptop, in both themes: a room
  // draws at the app's reading measure and never past it, its rows stay on screen, and the
  // composer keeps its gutters. Geometry is what no DOM without layout measures, so it is here.
  const BOX = 672
  const sizes = [
    { name: "phone", width: 390, height: 844 },
    { name: "tablet", width: 768, height: 1024 },
    { name: "laptop", width: 1440, height: 900 },
  ]
  for (const { name, width, height } of sizes) {
    for (const scheme of ["light", "dark"]) {
      await page.setViewportSize({ width, height })
      await page.emulateMedia({ colorScheme: scheme })
      await settled(page)
      const seen = await page.evaluate(() => {
        const box = (element) => {
          const at = element?.getBoundingClientRect()
          return at ? { left: at.left, right: at.right, width: at.width } : null
        }
        const rows = [
          ...document.querySelectorAll('[data-slot="room-row"]:not([data-kind="notice"])'),
        ]
        return {
          viewport: window.innerWidth,
          rows: rows.map(box),
          field: box(document.querySelector('[aria-label="Message"]')),
          send: box(document.querySelector('button[aria-label="Send"]')),
          room: (() => {
            const at = document.querySelector('[aria-label="Room messages"]')
            const rect = at?.getBoundingClientRect()
            // clientWidth leaves the scroller's own scrollbar out of the room a row is centred in.
            return rect ? { left: rect.left, right: rect.left + at.clientWidth } : null
          })(),
          title: document.querySelector("header")?.innerText.trim() ?? "",
          overflow: document.documentElement.scrollWidth > window.innerWidth,
        }
      })
      const where = `${name} ${scheme}`
      assert.equal(seen.rows.length, 3, `three rows at ${where}`)
      assert.ok(!seen.overflow, `nothing scrolls sideways at ${where}`)
      assert.match(seen.title, /Planning/, `the room's name is on screen at ${where}`)
      assert.ok(seen.field && seen.field.width > 0, `the composer is drawn at ${where}`)
      for (const row of seen.rows) {
        assert.ok(
          row.width <= BOX + 1,
          `a row stays in the reading column at ${where} (${row.width}px)`,
        )
        assert.ok(
          row.left >= -1 && row.right <= seen.viewport + 1,
          `a row stays on screen at ${where}`,
        )
      }
      assert.ok(seen.send && seen.send.right <= seen.viewport + 1, `Send is on screen at ${where}`)
      // Where the pane is wider than the measure, the room's column sits centred in it: the same
      // gutter either side, so a message never drifts towards one edge as the window grows.
      assert.ok(seen.room, `the room's scroller is drawn at ${where}`)
      if (seen.room.right - seen.room.left > BOX + 2) {
        const column = seen.rows[0]
        assert.ok(
          Math.abs(column.left - seen.room.left - (seen.room.right - column.right)) <= 2,
          `the room's column is centred in its pane at ${where}`,
        )
      }
      // One bubble of each side, in the order they are drawn: the user's on the right.
      const user = await page.locator('[data-slot="room-row"][data-kind="user"]').boundingBox()
      const member = await page
        .locator('[data-slot="room-row"][data-kind="member"]')
        .first()
        .boundingBox()
      assert.ok(user && member, `both sides are drawn at ${where}`)
      assert.ok(
        user.x + user.width >= member.x + member.width,
        `the user's message stands right of a member's at ${where}`,
      )
      await shot(`${name}-${scheme}`)
    }
  }
  await page.emulateMedia({ colorScheme: "light" })
  await page.setViewportSize({ width: 1440, height: 900 })

  pass(
    `a room's message ran three rounds — ${FIRST.length} and ${SECOND.length} characters of reply`,
  )
})
