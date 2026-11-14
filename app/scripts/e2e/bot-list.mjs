import { app, assert, flow, pass, rung, settled } from "./lib.mjs"

/**
 * A bot's list is the way into every conversation (ADR 0153): a bot pressed from the sidebar always
 * draws its list, the list is ordered by the last message *received* in each row, every row opens in
 * the pane beside it at 1280px, the bot's face is drawn once on that screen, and from a phone a row
 * opens its chat as the app's only entry with the sidebar the way back to the list.
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
    // How far a row's picture sits from the row's own centre line: 0 when it hangs on the line.
    const pictureOffsetOf = (selector) =>
      page.evaluate((selector) => {
        const row = document.querySelector(selector)
        const picture = row?.querySelector('[role="img"]')
        if (!row || !picture) return null
        const box = row.getBoundingClientRect()
        const face = picture.getBoundingClientRect()
        return Math.round((face.top + face.height / 2 - (box.top + box.height / 2)) * 100) / 100
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

    // A bot's row is the row the design gives a title with a line under it — 56px, taller than the
    // 44px menu above it because it carries a picture and two lines — and the picture hangs on the
    // row's own centre line rather than on the top of the line box it was drawn in.
    const botRow = await heightOf(`aside a[href="/b/${profileId}"]`)
    assert.equal(botRow, 56, `a bot's row is the app's 56px row for a title and a line (${botRow})`)
    const pictureOffset = await pictureOffsetOf(`aside a[href="/b/${profileId}"]`)
    assert.ok(
      Math.abs(pictureOffset) <= 0.5,
      `the bot's picture sits on the row's centre line (${pictureOffset}px off)`,
    )
    pass("a bot's row in the sidebar is the app's row, with its picture centred in it")

    // A phone: the same bot draws the same list, and a row opens its chat as the app's only entry.
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`${app}/b/${profileId}`)
    // Below the split width the list is the screen, so its rows are read in the main pane.
    await until(async () => (await mine("main")).length === 4, 20_000, "the list on a phone")
    assert.deepEqual(await mine("main"), written, "the one order, at a phone's width too")
    await press(`main ul a[href="/c/${ANSWERED}"]`)
    await page.waitForURL(`**/c/${ANSWERED}`, { timeout: 20_000 })
    assert.equal(await rung(page), 0, "a chat picked is the app's only entry, the list gone")
    assert.equal(await laneOpen(), false, "with no list beside it at this width")
    await shot("phone-chat")
    pass("a row picked on a phone opens its chat as the app's only entry")

    // The sidebar is the way back to the list, and it lands there rather than in another chat.
    await page.getByRole("button", { name: "Open conversations" }).click()
    await page.locator(`aside, [role="dialog"]`).first().waitFor({ timeout: 10_000 })
    // The drawer draws the same row: the same 56px, the same picture on its centre line.
    await page.locator(DRAWER_BOT_ROW(profileId)).first().waitFor({ timeout: 10_000 })
    await settled(page)
    const drawerRow = await heightOf(DRAWER_BOT_ROW(profileId))
    assert.equal(drawerRow, 56, `the drawer's bot row is the same 56px row (${drawerRow})`)
    const drawerOffset = await pictureOffsetOf(DRAWER_BOT_ROW(profileId))
    assert.ok(
      Math.abs(drawerOffset) <= 0.5,
      `the drawer's bot picture sits on the row's centre line (${drawerOffset}px off)`,
    )
    await press(DRAWER_BOT_ROW(profileId))
    await page.waitForURL(`**/b/${profileId}`, { timeout: 20_000 })
    await until(async () => (await mine("main")).length === 4, 20_000, "the list again")
    assert.equal(await rung(page), 0, "at the app's only entry, whatever the bot was last in")
    await shot("phone-list")
    pass("a bot pressed from the sidebar always lands on its list")
  },
  { viewport: { width: 1280, height: 900 } },
)
