import { app, assert, flow, mock, pass, rung, startRun } from "./lib.mjs"

const CHATS = [
  { id: "e2e-lisbon", title: "Trip to Lisbon" },
  { id: "e2e-garden", title: "Garden plan" },
]

/**
 * The claims are the browser's own history stack, rung by rung — `window.history.state.idx`, the
 * address the browser shows, and a press of its back button — which is what no DOM without a
 * session history and no faked `history.back` has (ADR 0019). A tablet's width, where the sidebar is
 * a rail and nothing stands beside the chat: a laptop's splits the bot's list from 1280px, which is
 * the shell's business and not this flow's.
 */
await flow(
  "bot-chats",
  async ({ page, profileId, seed, until, shot }) => {
    const list = `/b/${profileId}`
    const chat = `/c/${CHATS[1].id}`
    const here = () => new URL(page.url()).pathname
    // The list's own rows, read in the main pane: the sidebar's Rooms section holds rooms at
    // `/c/<room>`, which are no rows of a bot's chats.
    const rows = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('main ul a[href^="/c/"]')].map((row) =>
          row.getAttribute("href"),
        ),
      )
    /** The chat's own control, and the list it opens with every row of it drawn. */
    const openList = async (why) => {
      await page.getByRole("link", { name: "Chats with Test bot" }).click()
      await page.waitForURL(`**${list}`, { timeout: 20_000 })
      await until(async () => (await rows()).length === expected.length, 20_000, why)
    }
    const header = () =>
      page.evaluate(() => {
        const title = document.querySelector('[data-slot="header-title"]')
        return title?.textContent?.trim() ?? ""
      })
    const back = () => page.getByRole("button", { name: "Back to chat" })
    // The rooms this device seats the bot in: they are rows of its list, beside its chats.
    const rooms = () =>
      page.evaluate(async () => {
        const { db } = await import("/src/lib/db.ts")
        return (await db.conversations.filter((chat) => Boolean(chat.room)).toArray()).map(
          (chat) => `/c/${chat.id}`,
        )
      })

    await until(async () => here() === list, 20_000, "the bot's own address")
    await until(async () => (await rows()).length > 0, 20_000, "the list's rows")
    assert.deepEqual(
      (await rows()).sort(),
      (await rooms()).sort(),
      "a room the bot is seated in is a row of its list",
    )
    assert.equal(await rung(page), 0, "a bot with nothing to open draws its list at the app's only entry")
    await shot("empty-list")
    pass("a bot this device has never opened draws its list, the rooms it seats among the rows")

    await seed(CHATS)
    const expected = [...CHATS.map((one) => `/c/${one.id}`), ...(await rooms())]
    await until(
      async () => (await rows()).length === expected.length,
      20_000,
      "the bot's chats in its list",
    )
    assert.deepEqual(
      (await rows()).sort(),
      [...expected].sort(),
      "every chat of the bot's is a row of its list, beside the rooms it seats",
    )
    await shot("list")
    pass("the list draws the bot's chats")

    // A row's line is one line whatever the bot said: a long reply is cut with an ellipsis rather than
    // wrapped onto a second line, which a list of rows scanned down cannot afford.
    const LONG =
      "The build is green and every gate passed, so I opened the draft pull request for you to read when you are back at a screen."
    await page.evaluate(
      async ([chat, text]) => {
        const { db } = await import("/src/lib/db.ts")
        await db.messages.put({
          id: `${chat}-long`,
          conversationId: chat,
          role: "assistant",
          content: text,
          status: "done",
          createdAt: Date.now(),
        })
      },
      [CHATS[0].id, LONG],
    )
    /** One row's mark and its line, as the browser laid them out. */
    const boxesOf = (href) =>
      page.evaluate((href) => {
        const row = document.querySelector(`main ul a[href="${href}"]`)
        const mark = row?.querySelector('[data-slot="row-mark"] > *')
        const line = row?.querySelector('[data-slot="row-line"]')
        const words = line?.firstElementChild
        if (!row || !mark || !line || !words) return null
        const box = (node) => {
          const { top, bottom, width, right } = node.getBoundingClientRect()
          return {
            top,
            bottom,
            width,
            right,
            height: bottom - top,
            centre: top + (bottom - top) / 2,
          }
        }
        return {
          row: box(row),
          mark: box(mark),
          line: box(line),
          words: {
            ...box(words),
            said: words.textContent ?? "",
            scroll: words.scrollWidth,
            client: words.clientWidth,
          },
        }
      }, href)

    // The room's own row says something short, so its line is the height of one line of text.
    const roomRow = (await rooms())[0]
    assert.ok(roomRow, "the room's row is on the screen to be measured")
    const room = await boxesOf(roomRow)
    assert.ok(room !== null, "the room's row draws a mark and a line")
    const oneLine = room.line.height
    assert.ok(oneLine > 0, "and that line has a height to be measured against")

    const long = () => boxesOf(`/c/${CHATS[0].id}`)
    await until(
      async () => (await long())?.words.said === LONG,
      20_000,
      "the long reply as a chat's line",
    )
    const said = await long()
    assert.ok(said !== null, "the chat's row draws a mark and a line")
    assert.ok(
      said.line.height <= oneLine * 1.5,
      `the long reply is one line high (${said.line.height} against ${oneLine})`,
    )
    assert.ok(said.words.scroll > said.words.client, "and the words past the edge are cut off")
    assert.ok(said.words.right <= said.row.right + 1, "rather than reaching past the row")
    await shot("long-line")
    pass("a long reply keeps to one line, cut at the row's edge")

    // A room's mark is a cluster of faces rather than a disc, and it stands on the same centre line as
    // every chat's icon — not on the column's top edge, where a mark shorter than a disc would sit.
    // Each mark is read against the top of its own row, since the two rows stand at different heights.
    const roomOffset = room.mark.centre - room.row.centre
    const chatOffset = said.mark.centre - said.row.centre
    assert.ok(
      Math.abs(roomOffset - chatOffset) <= 1,
      `a room's faces stand where a chat row's icon does, off the row's centre (${roomOffset} against ${chatOffset})`,
    )
    assert.equal(
      await page.evaluate(
        (href) =>
          document
            .querySelector(`main ul a[href="${href}"] [data-room-faces]`)
            ?.getAttribute("role"),
        roomRow,
      ),
      "img",
      "and the cluster names its members to a reader who cannot see the pictures",
    )
    await shot("room-mark")
    pass("a room's faces stand on the same axis as every chat's icon")

    // A run the reader did not start: the host reports one in flight for a chat whose messages this
    // device has not seen arrive, and the row shows a spinner while it works. The tool is the same one
    // Code's rows read, so a chat and its session cannot disagree about what is running.
    const busy = await page.evaluate(
      async (id) =>
        (await (await import("/src/lib/db.ts")).db.conversations.get(id)).hermesSessionId,
      CHATS[1].id,
    )
    await startRun(busy, "long one, please")
    const spinning = () =>
      page.evaluate(
        (href) =>
          Boolean(document.querySelector(`main ul a[href="${href}"] [data-slot="spinner"]`)),
        `/c/${CHATS[1].id}`,
      )
    await until(spinning, 20_000, "the spinner while the host's run is in flight")
    assert.ok(await spinning(), "a chat the host is running draws the spinner")
    assert.equal(
      await page.evaluate(
        (href) =>
          document
            .querySelector(`main ul a[href="${href}"] [data-slot="row-mark"] span.rounded-full`)
            ?.className.includes("bg-muted"),
        `/c/${CHATS[1].id}`,
      ),
      true,
      "in the grey of a row at rest, rather than a colour of its own",
    )
    await shot("working")
    pass("a run in flight, reported by the host, is a spinner on the row")

    await page.locator(`main ul a[href="${chat}"]`).click()
    await page.waitForURL(`**${chat}`, { timeout: 20_000 })
    await until(async () => (await header()) === CHATS[1].title, 20_000, "the chat's own title")
    assert.equal(await rung(page), 0, "the chat picked becomes the app's only entry, the list gone")
    await shot("chat")
    pass("a row opens its chat as the app's only entry")

    const chatRung = await rung(page)
    await openList("the list again")
    assert.equal(await rung(page), chatRung + 1, "the list stands a rung above the chat it covers")
    assert.equal(
      await page.evaluate(() => document.querySelectorAll("main ul a[aria-current]").length),
      0,
      "and no row of it is marked as the one it covers, which is not open beside it",
    )
    await shot("list-over-chat")
    pass("the chat's list control opens the bot's chats above it, with no row marked")

    await back().click()
    await page.waitForURL(`**${chat}`, { timeout: 20_000 })
    await until(async () => (await header()) === CHATS[1].title, 20_000, "the chat it led back to")
    assert.equal(await rung(page), chatRung, "back on the rung the chat stands at, nothing left over")
    pass("back from the pushed list returns the chat it covers")

    // A chat picked from a list over a chat becomes the bot's chat on screen at the app's only entry:
    // the list does not stand behind it, and neither does the chat the reader started in. So the
    // picked chat is what the bot's own row opens, and it answers the press as any root chat does.
    const picked = `/c/${CHATS[0].id}`
    await openList("the list for the pick")
    assert.equal(await rung(page), chatRung + 1, "the list stands a rung above the chat it covers")
    await page.locator(`main ul a[href="${picked}"]`).click()
    await page.waitForURL(`**${picked}`, { timeout: 20_000 })
    await until(async () => (await header()) === CHATS[0].title, 20_000, "the chat picked")
    assert.equal(
      await rung(page),
      0,
      "the chat picked is the app's only entry, not a rung above the chat it replaced",
    )
    await shot("picked")
    pass("a row picked in a list over a chat takes the app's only entry")

    await page.goBack()
    await until(async () => !here().startsWith("/"), 10_000, "the app to be left")
    pass("back from the chat picked leaves the app, with nothing behind it")

    // The chat picked is the one the bot opens from the menu, at the app's only entry.
    await page.goForward()
    await page.waitForURL(`**${picked}`, { timeout: 20_000 })
    await until(async () => (await header()) === CHATS[0].title, 20_000, "the chat picked, back on screen")
    await page.locator('aside a[href="/code"]').first().click()
    await page.waitForURL("**/code", { timeout: 20_000 })
    await page.locator(`aside a[href="${list}"]`).first().click()
    await page.waitForURL(`**${picked}`, { timeout: 20_000 })
    await until(async () => (await header()) === CHATS[0].title, 20_000, "the chat the bot was left in")
    assert.equal(await rung(page), 0, "at the app's only entry, with nothing behind it")
    await shot("returned")
    pass("a bot's menu opens the chat picked from its list")

    // A room is not a chat of the bot's, so its row keeps its own screen above the list rather than
    // taking the app's entry: the room's way back lands that list, not the chat behind it.
    await openList("the list for the room")
    const roomRung = await rung(page)
    await page.locator(`main ul a[href="${roomRow}"]`).click()
    await page.waitForURL(`**${roomRow}`, { timeout: 20_000 })
    assert.equal(await rung(page), roomRung + 1, "the room stands above the list it was picked from")
    await page.getByRole("button", { name: "Back to Test bot" }).click()
    await page.waitForURL(`**${list}`, { timeout: 20_000 })
    assert.equal(await rung(page), roomRung, "and the room's own way back lands that list")
    pass("a room picked from a pushed list keeps the list as its way back")

    // The chat the bot was left in is still the one picked, and a reload keeps the reader in it.
    await page.locator('aside a[href="/code"]').first().click()
    await page.waitForURL("**/code", { timeout: 20_000 })
    await page.locator(`aside a[href="${list}"]`).first().click()
    await page.waitForURL(`**${picked}`, { timeout: 20_000 })
    await until(async () => (await header()) === CHATS[0].title, 20_000, "the chat left open here")
    assert.equal(await rung(page), 0, "at the app's only entry, with nothing behind it")

    await page.reload()
    await until(async () => (await header()) === CHATS[0].title, 30_000, "the chat after a reload")
    assert.equal(here(), picked, "a reload keeps the chat it was on")
    assert.equal(await rung(page), 0, "and the entry it stood on, the chat being the address")
    pass("a reload keeps the reader where they were")

    await openList("the list above it")
    assert.equal(await rung(page), 1, "the list stands a rung above the chat at the app's entry")
    await shot("list-over-root")
    pass("the chat at the app's entry opens its bot's chats above it")

    await back().click()
    await page.waitForURL(`**${picked}`, { timeout: 20_000 })
    await until(async () => (await header()) === CHATS[0].title, 20_000, "the chat it led back to")
    assert.equal(await rung(page), 0, "back at the app's entry, nothing left over")
    pass("back from the pushed list returns the chat, at the app's entry")

    // The foot's New chat is the same move from the same list: the list does not stand behind the new
    // chat either, so it is the bot's chat on screen with the press a root chat answers.
    await openList("the list for a new chat")
    assert.equal(await rung(page), 1, "the list stands a rung above the chat at the app's entry")
    await page.getByRole("button", { name: "New", exact: true }).click()
    await page.getByRole("button", { name: "New chat", exact: true }).click()
    await until(
      async () => here().startsWith("/c/") && here() !== picked,
      20_000,
      "the chat the foot made",
    )
    assert.equal(await rung(page), 0, "the new chat is the app's only entry, the list gone")
    await shot("new-chat")
    pass("a chat started from a pushed list's foot takes the app's only entry")

    await page.goBack()
    await until(async () => !here().startsWith("/"), 10_000, "the app to be left")
    pass("back from the new chat at the app's entry leaves the app")
  },
  { viewport: { width: 1024, height: 900 } },
)
