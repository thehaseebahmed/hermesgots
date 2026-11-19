// The Side Chat List says what the bot last said. A chat started from the list's own foot, a
// message sent into it and the bot's reply streamed into the thread — and the chat's row, read
// back off the list, wearing the reply's own words as its line. chat-next is the thread's one
// writer (ADR 0065): a turn's rows land in the chat's own session store on this device and
// nothing is written to `db.messages`, so a line read from there alone said "No messages yet" on
// a chat the bot had just answered in (`rowOfChat`, `lib/chat-rows.ts`).
//
// The expectation is derived rather than restated: the reply's words as the thread draws them,
// through the same rule the row's line is drawn by (`plainLine`, `lib/words.ts`), so the claim is
// that the row says what the thread says, whatever the host answered.
import { app, assert, flow, pass } from "./lib.mjs"

const CONTROL = '[data-slot="side-chats-button"]'
const NEW = "[data-new-menu]"
const MAIN = "e2e-line-main"

await flow(
  "side-chat-line",
  async ({ page, profileId, seed, until, send, lastReply, shot }) => {
    const list = `/b/${profileId}/sidechats`
    const title = () =>
      page.evaluate(
        () => document.querySelector('[data-slot="header-title"]')?.textContent?.trim() ?? "",
      )
    /** The chat's row's line as the list draws it, read in the main pane. */
    const rowLine = (id) =>
      page.evaluate((chat) => {
        const row = document.querySelector(`main ul a[href="/c/${chat}"]`)
        return row?.querySelector('[data-slot="row-line"]')?.textContent ?? null
      }, id)

    // Main, which the plugin publishes: what the bot's address opens on, and what the list is
    // opened from. A word in it, since a chat nothing was said in is no row of any list.
    const at = Date.now()
    await seed([{ id: MAIN, title: "Bot Chat", main: true, createdAt: at - 2_000, updatedAt: at }])
    await page.evaluate(async (id) => {
      const { db } = await import("/src/lib/db.ts")
      await db.messages.put({
        id: `${id}-said`,
        conversationId: id,
        role: "assistant",
        content: "Here whenever you need me.",
        status: "done",
        createdAt: Date.now() - 1_000,
      })
    }, MAIN)

    // A launch lands on the bot's Main, and Main's control opens the Side Chat List above it. A
    // fresh device has said nothing in any chat of the bot's, so the chat the flow starts below is
    // the list's own.
    await page.goto(app)
    await page.waitForURL(`**/c/${MAIN}`, { timeout: 20_000 })
    await page.locator(CONTROL).first().waitFor({ timeout: 20_000 })
    await page.locator(CONTROL).first().click()
    await page.waitForURL(`**${list}`, { timeout: 20_000 })
    await until(async () => (await title()) === "Sidechats", 20_000, "the Side Chat List")
    await shot("list")
    pass("Main's control opens the Side Chat List on a device that has said nothing yet")

    // The list's own foot starts the chat: its button opens the picks, and New chat makes a plain
    // chat of this bot's, opening it above the list.
    await page.locator(NEW).click()
    await page.getByRole("button", { name: "New chat", exact: true }).click()
    await page.waitForURL("**/c/**", { timeout: 20_000 })
    const chat = new URL(page.url()).pathname.slice(3)
    await until(async () => (await title()) === "New chat", 20_000, "the chat the list started")
    pass("the list's foot starts a chat of the bot's and opens it above the list")

    // A message sent, and the bot's reply in the thread, read the way the screen draws it.
    await send("when do we fly to Lisbon?")
    const reply = await until(
      async () => {
        const last = await lastReply(chat)
        return last?.status === "done" && last.content.trim() ? last : null
      },
      30_000,
      "the bot's reply to finish",
    )
    // The row's line must be the reply's words through the rule the row is drawn by, so the
    // expectation is computed from the reply rather than restated from the host's answer.
    const expected = await page.evaluate(async (words) => {
      const { plainLine } = await import("/src/lib/words.ts")
      return plainLine(words)
    }, reply.content)
    assert.ok(expected, "the reply's words give a row a line")
    await until(
      async () =>
        ((await page.locator("[aria-label=Messages]").textContent()) ?? "").includes(expected),
      20_000,
      "the reply's own words in the thread",
    )
    // The crux of the bug, held as the device holds it: the reply is in the thread and this
    // device wrote no message row for the chat — chat-next wrote the chat's own session store
    // (ADR 0065) — so a row whose line asked `db.messages` said "No messages yet".
    assert.equal(
      await page.evaluate(async (id) => {
        const { db } = await import("/src/lib/db.ts")
        return db.messages.where("conversationId").equals(id).count()
      }, chat),
      0,
      "the turn wrote no message row for the chat, only its session's own",
    )
    await shot("reply")
    pass("the chat takes the message and the bot's reply lands in the thread")

    // Back onto the list, where the chat's row says what the bot last said.
    await page.getByRole("button", { name: "Back to Test bot" }).click()
    await page.waitForURL(`**${list}`, { timeout: 20_000 })
    await until(async () => (await rowLine(chat)) === expected, 20_000, "the row's line")
    assert.equal(
      await rowLine(chat),
      expected,
      'the row says the reply\'s own words, not "No messages yet"',
    )
    await shot("row")
    pass("the chat's row on the Side Chat List says the reply's own words")
  },
  { viewport: { width: 1024, height: 900 } },
)
