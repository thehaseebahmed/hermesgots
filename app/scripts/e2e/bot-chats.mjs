import { app, assert, flow, pass, rung } from "./lib.mjs"

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

    await page.locator(`main ul a[href="${chat}"]`).click()
    await page.waitForURL(`**${chat}`, { timeout: 20_000 })
    await until(async () => (await header()) === CHATS[1].title, 20_000, "the chat's own title")
    assert.equal(await rung(page), 1, "the chat stands on the list it was opened from")
    await shot("chat")
    pass("a row opens its chat, on an address of its own")

    const chatRung = await rung(page)
    await page.getByRole("link", { name: "Chats with Test bot" }).click()
    await page.waitForURL(`**${list}`, { timeout: 20_000 })
    await until(async () => (await rows()).length === expected.length, 20_000, "the list again")
    assert.equal(await rung(page), chatRung + 1, "the list stands a rung above the chat it covers")
    assert.equal(
      await page.evaluate(
        () => document.querySelector('main ul a[aria-current="page"]')?.getAttribute("href") ?? null,
      ),
      chat,
      "with the chat's row marked as the one it covers",
    )
    await shot("list-over-chat")
    pass("the chat's list control opens the bot's chats above it, the chat's row marked")

    await back().click()
    await page.waitForURL(`**${chat}`, { timeout: 20_000 })
    await until(async () => (await header()) === CHATS[1].title, 20_000, "the chat it led back to")
    assert.equal(await rung(page), chatRung, "back on the rung the chat stands at, nothing left over")
    pass("back from the pushed list returns the chat it covers")

    await page.getByRole("link", { name: "Chats with Test bot" }).click()
    await page.waitForURL(`**${list}`, { timeout: 20_000 })
    await until(async () => (await rows()).length === expected.length, 20_000, "the list once more")
    const listRung = await rung(page)
    await page.locator(`main ul a[href="/c/${CHATS[0].id}"]`).click()
    await page.waitForURL(`**/c/${CHATS[0].id}`, { timeout: 20_000 })
    await until(async () => (await header()) === CHATS[0].title, 20_000, "the chat picked")
    assert.equal(await rung(page), listRung, "the chat picked stands on the list's own rung")
    assert.equal(await rung(page), chatRung + 1, "one above the chat the reader started in, not two")
    await shot("picked")
    pass("a row picked in a list over a chat takes the list's entry, not a rung of its own")

    await page.goBack()
    await page.waitForURL(`**${chat}`, { timeout: 20_000 })
    await until(async () => (await header()) === CHATS[1].title, 20_000, "the chat started in")
    assert.equal(await rung(page), chatRung, "back on the chat the reader started in")
    pass("back from the chat picked returns the chat the reader started in")

    await page.locator('aside a[href="/code"]').first().click()
    await page.waitForURL("**/code", { timeout: 20_000 })
    await page.locator(`aside a[href="${list}"]`).first().click()
    await page.waitForURL(`**${chat}`, { timeout: 20_000 })
    await until(async () => (await header()) === CHATS[1].title, 20_000, "the chat left open here")
    assert.equal(await rung(page), 0, "at the app's only entry, with nothing behind it")
    await shot("returned")
    pass("a bot opens the chat this device left it in, at the app's own entry")

    await page.reload()
    await until(async () => (await header()) === CHATS[1].title, 30_000, "the chat after a reload")
    assert.equal(here(), chat, "a reload keeps the chat it was on")
    assert.equal(await rung(page), 0, "and the entry it stood on, the chat being the address")
    pass("a reload keeps the reader where they were")

    await page.getByRole("link", { name: "Chats with Test bot" }).click()
    await page.waitForURL(`**${list}`, { timeout: 20_000 })
    await until(async () => (await rows()).length === expected.length, 20_000, "the list above it")
    assert.equal(await rung(page), 1, "the list stands a rung above the chat at the app's entry")
    await shot("list-over-root")
    pass("the chat at the app's entry opens its bot's chats above it")

    await back().click()
    await page.waitForURL(`**${chat}`, { timeout: 20_000 })
    await until(async () => (await header()) === CHATS[1].title, 20_000, "the chat it led back to")
    assert.equal(await rung(page), 0, "back at the app's entry, nothing left over")
    pass("back from the pushed list returns the chat, at the app's entry")

    await page.goBack()
    await until(async () => !here().startsWith("/"), 10_000, "the app to be left")
    pass("back from the chat at the app's entry leaves the app")
  },
  { viewport: { width: 1024, height: 900 } },
)
