import { app, assert, flow, pass, rung, settled } from "./lib.mjs"

/**
 * The way out of a bot's chats, rung by rung (G7, ADR 0161): a bot's entry lands on its **Main** at
 * the app's only entry; Main's control opens the **Side Chat List** one step above it; a row of that
 * list opens a side chat one step above the list; and the way back walks the same rungs down — the
 * list, then Main, then the app. A side chat opened cold, with nothing behind it, steps into its
 * bot's list rather than out of the app.
 *
 * The claims are the browser's own session history and its back button — `window.history.state.idx`,
 * the address the browser shows, and a press of its own control — which no DOM without a session
 * history has (ADR 0019). Main stands on the browser's first entry, so what the flow watches is that
 * nothing of the app is behind it; the toast the app arms before it leaves is
 * `scripts/test-back-press.tsx`'s, since a browser's back at a site's first entry is not a page's to
 * answer.
 *
 * The main record is written to the device here, the way the plugin's list answer leaves it (ADR 0160):
 * the mock speaks Hermes's own routes, and a Bot Chat is a row of the profile's `state.db` that the
 * plugin publishes, not one the test host serves.
 */
const MAIN = "e2e-side-main"
const ONE = "e2e-side-one"
const TWO = "e2e-side-two"

const CONTROL = '[data-slot="side-chats-button"]'
const LIST_ROWS = '[data-slot="list-lane"] ul a[href^="/c/"], main ul a[href^="/c/"]'

await flow(
  "side-chats",
  async ({ page, profileId, seed, until, shot }) => {
    const here = () => new URL(page.url()).pathname
    const list = `/b/${profileId}/sidechats`
    const main = `/c/${MAIN}`
    const rows = () =>
      page.evaluate(
        (selector) =>
          [...document.querySelectorAll(selector)].map((row) => row.getAttribute("href") ?? ""),
        LIST_ROWS,
      )
    const title = () =>
      page.evaluate(
        () => document.querySelector('[data-slot="header-title"]')?.textContent?.trim() ?? "",
      )
    const now = Date.now()

    // Three conversations of one bot: Main, which the plugin flags, and two chats of the bot's. Each
    // has a word in it, since a chat nothing was said in is no row of any list (ADR 0158).
    await seed([
      { id: MAIN, title: "Bot Chat", main: true, createdAt: now - 60_000, updatedAt: now - 30_000 },
      { id: ONE, title: "Trip to Lisbon", createdAt: now - 40_000, updatedAt: now - 20_000 },
      { id: TWO, title: "Garden plan", createdAt: now - 30_000, updatedAt: now - 10_000 },
    ])
    await page.evaluate(
      async ({ MAIN, ONE, TWO }) => {
        const { db } = await import("/src/lib/db.ts")
        const at = Date.now()
        await db.messages.bulkPut(
          [
            { id: `${MAIN}-said`, conversationId: MAIN, content: "Here whenever you need me." },
            { id: `${ONE}-said`, conversationId: ONE, content: "Booked the flights." },
            { id: `${TWO}-said`, conversationId: TWO, content: "Tomatoes go in on Sunday." },
          ].map((row) => ({ ...row, role: "assistant", status: "done", createdAt: at - 1_000 })),
        )
      },
      { MAIN, ONE, TWO },
    )

    // A launch lands on the bot's Main, in the app's only entry: the doorway's address is replaced by
    // the chat's, so back from Main is the app rather than the doorway again.
    await page.goto(app)
    await page.waitForURL(`**${main}`, { timeout: 20_000 })
    await until(async () => (await title()) === "Main", 20_000, "Main's bar")
    assert.equal(await rung(page), 0, "a bot opens on its Main at the app's only entry")
    assert.equal(
      await page.getByRole("button", { name: /^Back to / }).count(),
      0,
      "and nothing leads back from it",
    )
    await shot("main")
    pass("a bot's entry opens on its Main, at the app's only entry")

    // Main's control stands in the context ring's place and opens the list one step above it.
    await page.locator(CONTROL).first().waitFor({ timeout: 20_000 })
    await page.locator(CONTROL).first().click()
    await page.waitForURL(`**${list}`, { timeout: 20_000 })
    await until(async () => (await title()) === "Sidechats", 20_000, "the Side Chat List")
    assert.equal(await rung(page), 1, "the list stands one step above Main")
    // The count is this device's side chats, which the mock's own published chats can add to: what the
    // line must do is name the bot and count side chats rather than rows or runs.
    assert.match(
      await page.evaluate(
        () => document.querySelector('[data-slot="header-line"]')?.textContent?.trim() ?? "",
      ),
      /^Test bot · \d+ side chats?$/,
      "naming the bot and how many side chats it has",
    )
    // One pane draws the list alone: Main is the chat beside it at the split width, never a row here.
    assert.equal(
      await page.evaluate(() => Boolean(document.querySelector('[data-slot="main-row"]'))),
      false,
      "and no row for Main at a phone's width",
    )
    assert.deepEqual(
      (await rows()).filter((href) => href === `/c/${ONE}` || href === `/c/${TWO}`).sort(),
      [`/c/${ONE}`, `/c/${TWO}`].sort(),
      "its rows are the bot's side chats",
    )
    await shot("list")
    pass("Main's control opens the Side Chat List one step above it")

    // A row opens its chat one step above the list, its bar leading the way back.
    await page.locator(`main ul a[href="/c/${ONE}"], [data-slot="list-lane"] ul a[href="/c/${ONE}"]`)
      .first()
      .click()
    await page.waitForURL(`**/c/${ONE}`, { timeout: 20_000 })
    await until(async () => (await title()) === "Trip to Lisbon", 20_000, "the side chat")
    assert.equal(await rung(page), 2, "the chat stands one step above the list")
    assert.equal(
      await page.getByRole("button", { name: "Back to Test bot" }).count(),
      1,
      "and its bar leads with the list it came from",
    )
    await shot("side-chat")
    pass("a row opens its side chat one step above the list")

    // Down the same rungs: the control lands the list, the browser's back at the list lands Main.
    await page.getByRole("button", { name: "Back to Test bot" }).click()
    await page.waitForURL(`**${list}`, { timeout: 20_000 })
    await settled(page)
    assert.equal(await rung(page), 1, "the chat's control steps back onto the list")
    await page.goBack()
    await page.waitForURL(`**${main}`, { timeout: 20_000 })
    assert.equal(await rung(page), 0, "and the list's own press steps up to Main")
    await shot("back-to-main")
    pass("back from the chat is the list, and back from the list is Main")

    // Main is the app's edge: it stands on the browser's first entry, so a press there has nothing of
    // the app behind it to return to. Inside the app that press arms the exit toast and then leaves,
    // which is `scripts/test-back-press.tsx`'s to hold: a browser's back at a site's first entry is not
    // a page's to intercept, so what is watched here is that nothing of the app stands behind Main.
    assert.equal(await rung(page), 0, "Main stands on the app's first entry")
    await page.goBack()
    await settled(page)
    assert.equal(here(), main, "and nothing of the app is behind it")
    pass("Main is the app's edge, with nothing behind it")

    // A side chat opened cold has nothing behind it, so its way back is its bot's list, in its own
    // entry rather than the app's exit.
    await page.goto(`${app}/c/${TWO}`)
    await page.waitForURL(`**/c/${TWO}`, { timeout: 20_000 })
    await until(async () => (await title()) === "Garden plan", 20_000, "the cold side chat")
    assert.equal(await rung(page), 0, "opened at the app's only entry")
    await page.getByRole("button", { name: "Back to Test bot" }).click()
    await page.waitForURL(`**${list}`, { timeout: 20_000 })
    await until(async () => (await title()) === "Sidechats", 20_000, "the list in its place")
    assert.equal(await rung(page), 0, "the list taking the chat's entry rather than the app leaving")
    await shot("cold-chat-back")
    pass("a side chat opened cold steps into its bot's Side Chat List, not out of the app")

    // And the list at the app's first entry steps into Main, which is its bot's entry.
    await page.getByRole("button", { name: "Back to Main" }).first().click()
    await page.waitForURL(`**${main}`, { timeout: 20_000 })
    assert.equal(await rung(page), 0, "the list's control landing Main in the list's entry")
    pass("the list's leading control steps onto Main, never out of the app")
  },
  { viewport: { width: 390, height: 844 } },
)
