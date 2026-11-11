import { app, assert, flow, mock, pass, startRun } from "./lib.mjs"

const CHATS = [
  { id: "e2e-lisbon", title: "Trip to Lisbon" },
  { id: "e2e-garden", title: "Garden plan" },
]

/**
 * Where a bot opens, and where back goes from there: the chat the reader left it in, and a list
 * behind that chat whose own press back leaves the app — with the list itself for a bot this device
 * has never opened.
 *
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
    /** How deep in the browser's history the page stands: 0 is a press from leaving the app. */
    const rung = () => page.evaluate(() => window.history.state?.idx ?? null)
    // The list's own rows, read in the main pane: the sidebar's Rooms section holds rooms at
    // `/c/<room>`, which are no rows of a bot's chats.
    const rows = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('main ul a[href^="/c/"]')].map((row) =>
          row.getAttribute("href"),
        ),
      )
    const header = () =>
      page.evaluate(() => {
        const title = document.querySelector('[data-slot="header-title"]')
        return title?.textContent?.trim() ?? ""
      })
    const back = () => page.getByRole("button", { name: "Back to Test bot" })
    // The rooms this device seats the bot in: they are rows of its list, beside its chats.
    const rooms = () =>
      page.evaluate(async () => {
        const { db } = await import("/src/lib/db.ts")
        return (await db.conversations.filter((chat) => Boolean(chat.room)).toArray()).map(
          (chat) => `/c/${chat.id}`,
        )
      })

    // A bot this device has never opened: nothing is remembered, so its list is what draws — the
    // rooms it is seated in are already rows of it — and it stands alone in the history.
    await until(async () => here() === list, 20_000, "the bot's own address")
    await until(async () => (await rows()).length > 0, 20_000, "the list's rows")
    assert.deepEqual(
      (await rows()).sort(),
      (await rooms()).sort(),
      "a room the bot is seated in is a row of its list",
    )
    assert.equal(await rung(), 0, "a bot opens at the app's only entry")
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
    assert.equal(await rung(), 1, "the chat stands on the list it was opened from")
    await shot("chat")
    pass("a row opens its chat, on an address of its own")

    // Back from a chat is the list, and the list is the whole of the history behind it: the next press
    // is the app's to take.
    await back().click()
    await page.waitForURL(`**${list}`, { timeout: 20_000 })
    await until(async () => (await rows()).length === expected.length, 20_000, "the list again")
    assert.equal(await rung(), 0, "and nothing stands behind the list")
    pass("back from a chat lands the list, and the list is the app's first entry")

    // Away in the app and back: the chat the reader left is where they land.
    await page.locator('aside a[href="/code"]').first().click()
    await page.waitForURL("**/code", { timeout: 20_000 })
    await page.locator(`aside a[href="${list}"]`).first().click()
    await page.waitForURL(`**${chat}`, { timeout: 20_000 })
    await until(async () => (await header()) === CHATS[1].title, 20_000, "the chat left open here")
    assert.equal(await rung(), 1, "with the list behind it, as when the bot was first opened")
    await shot("returned")
    pass("a bot opens the chat this device left it in, from anywhere in the app")

    await page.reload()
    await until(async () => (await header()) === CHATS[1].title, 30_000, "the chat after a reload")
    assert.equal(here(), chat, "a reload keeps the chat it was on")
    pass("a reload keeps the reader where they were")

    // The browser's own back, twice: the chat's entry steps to the list the landing put behind it,
    // and the list is where the app's history begins, so the next press takes the page off the app.
    await page.goBack()
    await page.waitForURL(`**${list}`, { timeout: 20_000 })
    await until(async () => (await rows()).length === expected.length, 20_000, "the list behind it")
    assert.equal(await rung(), 0, "the list is the app's first entry")
    await shot("behind")
    pass("the browser's back walks the chat to its bot's list")

    await page.goBack()
    await until(async () => !here().startsWith("/"), 10_000, "the app to be left")
    pass("back from the list leaves the app")
  },
  { viewport: { width: 1024, height: 900 } },
)
