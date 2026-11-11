import { app, assert, flow, pass } from "./lib.mjs"

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
