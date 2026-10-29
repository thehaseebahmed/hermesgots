// A long chat opened on chat-next is drawn from its newest page at once, and the older pages are read
// after it and put above (ADR 0065). What a DOM without a layout cannot say is whether the reader
// stays where they are while rows arrive above them: a reader at the end still has the newest reply
// on the same line of the pane, a reader up in the thread still has the line they were reading on
// the same line, and the loader, over the pane while pages are read, is never part of the thread's
// flow, where it would move everything as it came and went.
import { app, assert, flow, pass, runId } from "./lib.mjs"

const TURNS = 30
const PAGE = 50

/** The host's rows for a session of `TURNS` six-row turns, oldest first, ids from 1. */
function transcript(session) {
  const rows = []
  const at = 1_700_000_000
  const add = (row) =>
    rows.push({ id: rows.length + 1, session_id: session, timestamp: at + rows.length, ...row })
  const filler = (n) =>
    Array.from(
      { length: 3 },
      (_, i) => `Paragraph ${i + 1} of turn ${n}: ${"words ".repeat(24)}`,
    ).join("\n\n")
  for (let n = 0; n < TURNS; n++) {
    add({ role: "user", content: `question ${n}` })
    for (const step of [0, 1]) {
      const id = `call-${n}-${step}`
      add({
        role: "assistant",
        content: null,
        tool_calls: [{ id, type: "function", function: { name: "terminal", arguments: "{}" } }],
      })
      add({ role: "tool", content: "{}", tool_call_id: id })
    }
    add({ role: "assistant", content: `answer ${n}\n\n${filler(n)}`, finish_reason: "stop" })
  }
  return rows
}

await flow(
  "chat-next-older",
  async ({ page, seed, until, shot }) => {
    const chatId = `e2e-older-${runId()}`
    await seed([{ id: chatId, title: "Older pages" }])
    await page.evaluate(async () => {
      const { db } = await import("/src/lib/db.ts")
      await db.settings.update("settings", { developer: true, chatNext: true })
    })
    const session = await page.evaluate(
      async (id) =>
        (await (await import("/src/lib/db.ts")).db.conversations.get(id)).hermesSessionId,
      chatId,
    )

    // The host's transcript for this one session, paged newest first as Hermes pages it, with the
    // pages after the first held back until the flow lets them go.
    const rows = transcript(session)
    const held = new Map()
    const served = []
    const hold = (offset) => {
      let release
      held.set(offset, new Promise((done) => (release = done)))
      return () => release()
    }
    await page.route(`**/api/sessions/${session}/messages*`, async (route) => {
      const url = new URL(route.request().url())
      const limit = Number(url.searchParams.get("limit"))
      const offset = Number(url.searchParams.get("offset"))
      served.push(offset)
      await held.get(offset)
      const data = [...rows]
        .reverse()
        .slice(offset, offset + limit)
        .reverse()
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify({ object: "list", session_id: session, data }),
      })
    })

    // chat-next needs a host that says it runs Hermes 0.22.5 or newer, which the mock does not.
    await page.route("**/health", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify({ status: "ok", platform: "hermes-agent", version: "0.22.5" }),
      }),
    )
    const releaseSecond = hold(PAGE)
    const releaseRest = hold(2 * PAGE)
    const releaseLast = hold(3 * PAGE)
    const reply = (n) => page.locator("[data-message-id]").filter({ hasText: `answer ${n}` })
    const pane = () =>
      page.evaluate(() => {
        const el = document.querySelector('[aria-label="Messages"]')
        return { top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight }
      })
    /** Where a reply's top and bottom stand in the page, which is the pane's own frame of reference. */
    const place = (n) =>
      reply(n)
        .first()
        .evaluate((el) => {
          const box = el.getBoundingClientRect()
          return { top: box.top, bottom: box.bottom }
        })
    const settle = () => page.waitForTimeout(600)

    await page.goto(`${app}/c/${chatId}`)
    await reply(TURNS - 1)
      .first()
      .waitFor({ timeout: 15_000 })
    await until(async () => served.includes(PAGE), 5_000, "the second page to be asked for")
    assert.deepEqual([...new Set(served)], [0, PAGE], "the newest page, then the second asked for")
    assert.equal(await reply(0).count(), 0, "the first turn is not drawn before its page is served")
    await settle()
    const opened = await pane()
    assert.ok(
      opened.height - opened.top - opened.client < 4,
      `the chat opens on its end: ${JSON.stringify(opened)}`,
    )
    // The loader is over the pane, at its top, and not among the thread's rows.
    const loader = page.locator('[data-older="reading"]')
    await loader.waitFor({ timeout: 5_000 })
    const box = await loader.boundingBox()
    const view = await page.locator('[aria-label="Messages"]').boundingBox()
    assert.ok(
      box.y >= view.y && box.y < view.y + 80,
      `the loader is at the top of the pane: ${box.y}`,
    )
    assert.equal(
      await page.locator('[data-slot="message-scroller-content"] [data-older]').count(),
      0,
      "and not in the flow of the thread",
    )
    await shot("first-page")
    pass("the newest page is drawn and the pane is on its end while the older pages are read")

    // A reader at the end of the thread stays there as the rows above arrive: the newest reply
    // holds the very same line of the page.
    const newest = await place(TURNS - 1)
    releaseSecond()
    await until(async () => (await reply(TURNS - 9).count()) > 0, 15_000, "the second page's turns")
    await settle()
    const stayed = await place(TURNS - 1)
    assert.ok(
      Math.abs(stayed.bottom - newest.bottom) <= 2,
      `the newest reply stays on its line: ${newest.bottom} → ${stayed.bottom}`,
    )
    assert.equal(
      await page.locator('[data-older="reading"]').count(),
      1,
      "the loader stays while a page is still to come",
    )
    pass(
      "a reader at the end of the thread keeps the newest reply on the same line as pages land above",
    )

    // A reader up in the thread keeps the line they are reading: scroll to a reply of the first page
    // and let the rest of the chat in above it.
    await reply(TURNS - 4)
      .first()
      .scrollIntoViewIfNeeded()
    await page.evaluate(() => {
      document.querySelector('[aria-label="Messages"]').scrollBy({ top: -120 })
    })
    await settle()
    const reading = await place(TURNS - 4)
    const before = await pane()
    releaseRest()
    releaseLast()
    await until(async () => (await reply(0).count()) > 0, 20_000, "the first turn of the chat")
    await until(
      async () => (await page.locator("[data-older]").count()) === 0,
      10_000,
      "the loader to go once the chat is whole",
    )
    await settle()
    const after = await place(TURNS - 4)
    const grown = await pane()
    assert.ok(
      grown.height > before.height + 2000,
      `the thread grew above: ${before.height} → ${grown.height}`,
    )
    assert.ok(
      Math.abs(after.top - reading.top) <= 2,
      `the line being read stays put: ${reading.top} → ${after.top}`,
    )
    assert.ok(grown.top > before.top, "because the pane moved down the thread by what was added")
    await shot("whole")
    pass(
      "a reader up in the thread keeps the line they are reading as the rest of the chat lands above",
    )

    assert.deepEqual([...new Set(served)], [0, PAGE, 2 * PAGE, 3 * PAGE], "one page after another")
    assert.equal(await page.locator("[data-older]").count(), 0, "no loader once the chat is whole")
    pass("pages were read newest first, and the loader is gone with the chat whole")
  },
  { viewport: { width: 390, height: 844 } },
)
