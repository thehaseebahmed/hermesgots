import { app, assert, flow, pass, rung, startRun } from "./lib.mjs"

const MAIN = "e2e-main"
const CHATS = [
  { id: "e2e-lisbon", title: "Trip to Lisbon" },
  { id: "e2e-garden", title: "Garden plan" },
]

/**
 * Where a bot's screens stand, rung by rung (ADR 0161): a bot's entry is its **Main** — Home and the
 * sidebar's row both land that chat, at the app's only entry, whatever this device was last in — and
 * the **Side Chat List** is a screen the chat opens above it. So the ways back — a chat's leading
 * control, the list's own control and the platform's back button — walk Main, the list, the chat, and
 * each lands the rung behind it. The claims are the browser's own history stack: `history.state.idx`,
 * the address it shows, and its own back button, which no DOM without a session history and no faked
 * `history.back` has (ADR 0019).
 *
 * A tablet's width, where the sidebar is on screen and nothing stands beside the list: a laptop's
 * splits the list from Main into panes, which `bot-list` measures.
 *
 * The rows are measured here too, since the list is a real page: a long reply keeps to one line, cut
 * at the row's edge, and a room's cluster of faces stands on the same centre line as a chat's icon.
 * A run is no row of this list — the routines page is its screen (ADR 0161) — so a run in flight is
 * watched on a chat's row instead.
 */
await flow(
  "bot-chats",
  async ({ page, profileId, seed, until, shot }) => {
    const main = `/c/${MAIN}`
    const list = `/b/${profileId}/sidechats`
    const here = () => new URL(page.url()).pathname
    const title = () =>
      page.evaluate(
        () => document.querySelector('[data-slot="header-title"]')?.textContent?.trim() ?? "",
      )
    // The list's own rows, read in the main pane: at this width the list is the screen.
    const rows = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('main ul a[href^="/c/"]')].map((row) =>
          row.getAttribute("href"),
        ),
      )
    const openList = async (why) => {
      await page.locator('[data-slot="side-chats-button"]').first().click()
      await page.waitForURL(`**${list}`, { timeout: 20_000 })
      await until(async () => (await title()) === "Sidechats", 20_000, why)
    }
    const rooms = () =>
      page.evaluate(async () => {
        const { db } = await import("/src/lib/db.ts")
        return (await db.conversations.filter((chat) => Boolean(chat.room)).toArray()).map(
          (chat) => `/c/${chat.id}`,
        )
      })

    // Main, which the plugin publishes, and two chats of the bot's: what the bot's address opens on,
    // and what its list draws. Main's record is written to the device the way the plugin's list
    // answer leaves it — the mock speaks Hermes's own routes, and a Bot Chat is the profile's.
    await seed([
      { id: MAIN, title: "Bot Chat", main: true, createdAt: 1, updatedAt: 2 },
      ...CHATS.map((one, at) => ({ ...one, createdAt: 3 + at, updatedAt: 4 + at })),
    ])
    // The room this bot is seated in, written here rather than taken from the mock: a room is a row of
    // every bot its roster seats, and this flow reads its mark and its way back.
    await page.evaluate(async (ids) => {
      const { db } = await import("/src/lib/db.ts")
      const profile = (await db.profiles.toArray())[0]
      const at = Date.now()
      await db.conversations.put({
        id: "e2e-standup",
        profileId: profile.id,
        title: "Standup",
        titleEdited: true,
        hermesSessionId: "gots-e2e-standup",
        createdAt: at - 10_000,
        updatedAt: at - 5_000,
        changedAt: at - 5_000,
        room: { id: "e2e-standup", members: [{ profile: "default" }] },
      })
      await db.messages.bulkPut(
        ids.map((id) => ({
          id: `${id}-said`,
          conversationId: id,
          role: "assistant",
          content: "Said in it",
          status: "done",
          createdAt: at - 2_000,
        })),
      )
    }, [MAIN, ...CHATS.map((one) => one.id)])

    // Home lands on the bot's Main, at the app's only entry, with nothing of the doorway left behind.
    await page.goto(app)
    await page.waitForURL(`**${main}`, { timeout: 20_000 })
    await until(async () => (await title()) === "Main", 20_000, "the bot's Main")
    assert.equal(await rung(page), 0, "a bot opens on its Main at the app's only entry")
    assert.equal(
      await page.getByRole("button", { name: /^Back to / }).count(),
      0,
      "and Main is the bot's entry, so nothing leads back from it",
    )
    await shot("main")
    pass("Home lands on the bot's Main, at the app's only entry")

    // The sidebar's row lands there too, whatever this device was last in.
    await page.locator(`aside a[href="/b/${profileId}"]`).first().click()
    await page.waitForURL(`**${main}`, { timeout: 20_000 })
    assert.equal(await rung(page), 0, "the bot's own row lands its Main, at the app's only entry")
    pass("a bot pressed from the sidebar lands on its Main")

    // Main's control opens the list one step above it.
    await openList("the bot's Side Chat List")
    assert.equal(await rung(page), 1, "the list stands one step above Main")
    const seated = await rooms()
    assert.ok(seated.length > 0, "this device seats the bot in a room, to be listed")
    assert.deepEqual(
      (await rows()).filter((href) => seated.includes(href)).sort(),
      [...seated].sort(),
      "a room the bot is seated in is a row of its side chats",
    )
    assert.deepEqual(
      (await rows()).filter((href) => CHATS.some((one) => href === `/c/${one.id}`)).sort(),
      CHATS.map((one) => `/c/${one.id}`).sort(),
      "beside every chat of the bot's",
    )
    assert.ok(
      !(await rows()).includes(main),
      "and Main is the chat the list was opened from, never one of its rows",
    )
    await shot("list")
    pass("Main's control opens the Side Chat List, its chats and rooms among the rows")

    // A row's line is one line whatever the bot said, and a room's faces stand where a chat's icon does.
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

    // A run the host reports in flight for a chat this device has not seen arrive draws its spinner.
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
    await shot("working")
    pass("a run in flight, reported by the host, is a spinner on the row")

    // A row opens its chat one step above the list, and its bar leads with that list.
    const picked = `/c/${CHATS[0].id}`
    await page.locator(`main ul a[href="${picked}"]`).click()
    await page.waitForURL(`**${picked}`, { timeout: 20_000 })
    await until(async () => (await title()) === CHATS[0].title, 20_000, "the chat picked")
    assert.equal(await rung(page), 2, "a side chat picked from the list stands one step above it")
    assert.equal(
      await page.getByRole("button", { name: "Back to Test bot" }).count(),
      1,
      "and the bar leads with its way back",
    )
    await shot("chat")
    pass("a row opens its chat one step above the list")

    // The control is that way back by another name: it steps onto the list, and the list's own press
    // steps up to Main.
    await page.getByRole("button", { name: "Back to Test bot" }).click()
    await page.waitForURL(`**${list}`, { timeout: 20_000 })
    assert.equal(await rung(page), 1, "the control leading the bar steps onto the list")
    await page.goBack()
    await page.waitForURL(`**${main}`, { timeout: 20_000 })
    assert.equal(await rung(page), 0, "and the list's press steps up to Main, which is the app's edge")
    await shot("browser-back")
    pass("the list's press lands Main")

    // A reload keeps the reader where they were, and the list's control still lands Main.
    await openList("the list again")
    await page.reload()
    await until(async () => (await title()) === "Sidechats", 30_000, "the list after a reload")
    assert.equal(here(), list, "a reload keeps the list it was on")
    await page.getByRole("button", { name: "Back to Main" }).first().click()
    await page.waitForURL(`**${main}`, { timeout: 20_000 })
    await until(async () => (await title()) === "Main", 20_000, "the bot's Main")
    assert.equal(await rung(page), 0, "and the list's control lands Main in the list's own entry")
    pass("a reload keeps the reader where they were, and the list still leads Main")

    // A side chat opened cold answers back with the list, in the chat's own entry.
    await page.goto(`${app}/c/${CHATS[1].id}`)
    await page.waitForURL(`**/c/${CHATS[1].id}`, { timeout: 20_000 })
    await until(async () => (await title()) === CHATS[1].title, 20_000, "the cold side chat")
    assert.equal(await rung(page), 0, "opened at the app's only entry")
    await page.getByRole("button", { name: "Back to Test bot" }).click()
    await page.waitForURL(`**${list}`, { timeout: 20_000 })
    assert.equal(await rung(page), 0, "the list takes the chat's entry rather than the app leaving")
    pass("a side chat opened cold lands its bot's Side Chat List")
  },
  { viewport: { width: 1024, height: 900 } },
)
