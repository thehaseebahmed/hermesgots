import { app, assert, flow, pass, rung, settled } from "./lib.mjs"

/**
 * A bot's list is the way into every conversation (ADR 0153, ADR 0154): a bot pressed from the sidebar
 * always draws its list, the list is ordered by the last message *received* in each row, every row
 * opens in the pane beside it at 1280px, the bot's face is drawn once on that screen, and the corner
 * control takes the reader back to the list with nothing beside it — a large chat mark over "No chat
 * selected", centred on both axes. From a phone a row opens one step above the list, and the corner
 * control or the drawer's bot row lands that list.
 *
 * The clocks are written here rather than left to the seed's "now", because the order is the claim:
 * the chat the reader spoke in last was answered first, so it is the list's last row.
 */
const LANE = '[data-slot="list-lane"]'
const ITEM = '[data-slot="item-lane"]'
const rowsIn = (scope) => `${scope} ul a[href^="/c/"]`
const FACES = '[data-slot="header-row"] [role="img"]'
/** The bot's row in the phone's drawer: the only link to a bot's address a screen draws. */
const DRAWER_BOT_ROW = (id) => `a[href="/b/${id}"]`

const ANSWERED = "e2e-answered"
const SPOKEN = "e2e-spoken"
const RUN = "e2e-run"
const ROOM = "e2e-room"

await flow(
  "bot-list",
  async ({ page, profileId, shot, until }) => {
    const here = () => new URL(page.url()).pathname
    const rows = (scope = LANE) =>
      page.evaluate(
        (selector) =>
          [...document.querySelectorAll(selector)].map((row) => row.getAttribute("href") ?? ""),
        rowsIn(scope),
      )
    // The mock keeps what earlier runs left in it, so a list holds rows this flow never wrote: the
    // order is read over the four it did.
    const written = [`/c/${ANSWERED}`, `/c/${RUN}`, `/c/${ROOM}`, `/c/${SPOKEN}`]
    const mine = async (scope = LANE) => (await rows(scope)).filter((href) => written.includes(href))
    const laneOpen = () => page.evaluate((selector) => Boolean(document.querySelector(selector)), LANE)
    const itemPane = () =>
      page.evaluate(
        (selector) => Boolean(document.querySelector(`${selector} [data-slot="chat-pane"]`)),
        ITEM,
      )
    const faces = () => page.evaluate((selector) => document.querySelectorAll(selector).length, FACES)
    const heightOf = (selector) =>
      page.evaluate((selector) => {
        const row = document.querySelector(selector)
        return row ? Math.round(row.getBoundingClientRect().height) : null
      }, selector)
    const press = async (selector) => {
      await page.locator(selector).first().click()
      await settled(page)
    }

    // Four rows of one list: a chat answered 2 minutes ago, a routine's delivery 3 minutes ago, a room
    // 6 minutes ago and a chat the reader wrote in 30 seconds ago that was answered 10 minutes ago.
    await page.evaluate(
      async ({ profileId, ANSWERED, SPOKEN, RUN, ROOM }) => {
        const { db } = await import("/src/lib/db.ts")
        const now = Date.now()
        const min = 60_000
        const chat = (id, title, updatedAt, patch = {}) => ({
          id,
          profileId,
          title,
          titleEdited: true,
          hermesSessionId: `gots-${id}`,
          createdAt: now - 60 * min,
          updatedAt,
          changedAt: updatedAt,
          ...patch,
        })
        await db.conversations.bulkPut([
          chat(ANSWERED, "Answered two minutes ago", now - 2 * min),
          chat(SPOKEN, "Spoken in half a minute ago", now - 0.5 * min),
          chat(RUN, "Morning watch", now - 3 * min, {
            routine: true,
            line: "The tide turns at 06:40.",
          }),
          chat(ROOM, "Standup", now - 6 * min, {
            room: { id: ROOM, members: [{ profile: "default" }] },
          }),
        ])
        await db.messages.bulkPut([
          {
            id: `${ANSWERED}-said`,
            conversationId: ANSWERED,
            role: "assistant",
            content: "Two minutes ago, in so many words.",
            status: "done",
            createdAt: now - 2 * min,
          },
          {
            id: `${SPOKEN}-said`,
            conversationId: SPOKEN,
            role: "assistant",
            content: "The bot's last word here.",
            status: "done",
            createdAt: now - 10 * min,
          },
          {
            id: `${SPOKEN}-typed`,
            conversationId: SPOKEN,
            role: "user",
            content: "and one more thing please",
            status: "done",
            createdAt: now - 0.5 * min,
          },
        ])
      },
      { profileId, ANSWERED, SPOKEN, RUN, ROOM },
    )

    // From the sidebar: the bot's own address, at the app's only entry, drawing its list.
    await page.goto(app)
    await page.waitForURL(`**/b/${profileId}`, { timeout: 20_000 })
    await until(async () => (await mine()).length === 4, 20_000, "the four rows this flow wrote")
    assert.deepEqual(
      await mine(),
      written,
      "the list is ordered by what was received in each row: the chat the reader spoke in last is last",
    )
    assert.equal(await rung(page), 0, "and it stands at the app's only entry")
    const line = await page.evaluate(
      (selector) => document.querySelector(`${selector} [data-slot="row-line"]`)?.textContent ?? "",
      `${LANE} ul a[href="/c/${SPOKEN}"]`,
    )
    assert.match(line, /The bot's last word here/, "a row the reader spoke in keeps the bot's words")
    await shot("list")
    pass("a bot pressed from the sidebar draws its list, ordered by what was received")

    // A bot's own chat opens in the pane beside the list, which keeps its lane and its mark.
    await press(`${LANE} ul a[href="/c/${ANSWERED}"]`)
    await page.waitForURL(`**/c/${ANSWERED}`, { timeout: 20_000 })
    await until(itemPane, 20_000, "the chat in the pane beside the list")
    assert.ok(await laneOpen(), "the list keeps its lane")
    assert.equal(
      await page.evaluate(
        (selector) => document.querySelector(selector)?.getAttribute("href"),
        `${LANE} ul a[aria-current="page"]`,
      ),
      `/c/${ANSWERED}`,
      "with the chat's row marked as the one open beside it",
    )
    assert.equal(await faces(), 1, "and the bot's face drawn once on the screen, in the list's bar")
    await shot("chat")
    pass("a row opens in the second pane, and the bot's face is drawn once")

    // A room's row is a row of the list too: it opens beside it rather than over the whole screen.
    await press(`${LANE} ul a[href="/c/${ROOM}"]`)
    await page.waitForURL(`**/c/${ROOM}`, { timeout: 20_000 })
    await until(itemPane, 20_000, "the room in the pane beside the list")
    assert.ok(await laneOpen(), "the list stays beside a room as well")
    assert.equal(here(), `/c/${ROOM}`, "and the room is what the pane holds")
    await shot("room")
    pass("a room's row opens in the second pane, the list still beside it")

    // A routine's run, the same.
    await press(`${LANE} ul a[href="/c/${RUN}"]`)
    await page.waitForURL(`**/c/${RUN}`, { timeout: 20_000 })
    await until(itemPane, 20_000, "the run in the pane beside the list")
    assert.ok(await laneOpen(), "the list stays beside a run too")
    await shot("run")
    pass("a routine's run opens in the second pane, the list still beside it")

    // The corner control asks for the list with nothing beside it, and the item lane says so: a large
    // chat mark above the words, centred on both axes of the lane — geometry, so it is measured here.
    await page.getByRole("button", { name: "Back to Test bot" }).click()
    await page.waitForURL(`**/b/${profileId}`, { timeout: 20_000 })
    await until(
      async () => Boolean(await page.locator(`${ITEM} [data-slot="bot-chats-empty"]`).count()),
      20_000,
      "the item lane's empty state",
    )
    const empty = await page.evaluate((selector) => {
      const slot = document.querySelector(`${selector} [data-slot="bot-chats-empty"]`)
      const lane = document.querySelector(selector)
      if (!slot || !lane) return null
      const box = slot.getBoundingClientRect()
      const pane = lane.getBoundingClientRect()
      return {
        words: (slot.textContent ?? "").trim(),
        hasMark: Boolean(slot.querySelector("svg")),
        dx: Math.abs(box.left + box.width / 2 - (pane.left + pane.width / 2)),
        dy: Math.abs(box.top + box.height / 2 - (pane.top + pane.height / 2)),
      }
    }, ITEM)
    assert.ok(empty, "the list beside nothing draws the item lane's empty state")
    assert.equal(empty.words, "No chat selected", "in the words it says")
    assert.ok(empty.hasMark, "with a chat's mark above them")
    assert.ok(
      empty.dx <= 2 && empty.dy <= 2,
      `both centred on the lane (${empty.dx} across, ${empty.dy} down)`,
    )
    assert.ok(await laneOpen(), "the list keeps its lane beside it")
    assert.equal(
      await page.evaluate(
        (selector) => document.querySelectorAll(`${selector} ul a[aria-current]`).length,
        LANE,
      ),
      0,
      "and marks no row, since none is open beside it",
    )
    await shot("empty-pane")
    pass("returning to the list beside nothing shows the mark and no chat selected")

    // The bots band's rows sit at the app's own row height: no extra room between one bot and the next.
    const botRow = await heightOf(`aside a[href="/b/${profileId}"]`)
    assert.equal(botRow, 44, `a bot's row is the app's 44px target, not a taller one (${botRow})`)
    pass("a bot's row in the sidebar is the app's row height")

    // A phone: the same bot draws the same list, and a row opens its chat one step above it.
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`${app}/b/${profileId}`)
    // Below the split width the list is the screen, so its rows are read in the main pane.
    await until(async () => (await mine("main")).length === 4, 20_000, "the list on a phone")
    assert.deepEqual(await mine("main"), written, "the one order, at a phone's width too")
    await press(`main ul a[href="/c/${ANSWERED}"]`)
    await page.waitForURL(`**/c/${ANSWERED}`, { timeout: 20_000 })
    assert.equal(await rung(page), 1, "a chat picked on a phone stands one step above the list")
    assert.equal(await laneOpen(), false, "with no list beside it at this width")
    await shot("phone-chat")
    pass("a row picked on a phone opens its chat one step above the list")

    // The bar's corner control is the way back, and it lands the list in the entry the chat stood in.
    await page.getByRole("button", { name: "Back to Test bot" }).click()
    await page.waitForURL(`**/b/${profileId}`, { timeout: 20_000 })
    await until(async () => (await mine("main")).length === 4, 20_000, "the list again")
    assert.equal(await rung(page), 0, "in the entry the conversation stood in")
    await shot("phone-back-to-list")
    pass("a phone's conversation carries its way back in the corner")

    // The sidebar is the way to the list as well, and it lands there rather than in another chat.
    await page.getByRole("button", { name: "Open conversations" }).click()
    await page.locator(`aside, [role="dialog"]`).first().waitFor({ timeout: 10_000 })
    await press(DRAWER_BOT_ROW(profileId))
    await page.waitForURL(`**/b/${profileId}`, { timeout: 20_000 })
    await until(async () => (await mine("main")).length === 4, 20_000, "the list again")
    assert.equal(await rung(page), 0, "at the app's only entry, whatever the bot was last in")
    await shot("phone-list")
    pass("a bot pressed from the sidebar always lands on its list")
  },
  { viewport: { width: 1280, height: 900 } },
)
