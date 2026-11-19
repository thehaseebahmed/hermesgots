// The rule is ADR 0047 — a card never passes the reading column's box — measured here because width
// is layout that no DOM without a layout engine has (ADR 0019).
import { app, assert, flow, pass, runId, settled } from "./lib.mjs"

const GUTTER = 16
const BOX_PX = 672
const TOLERANCE = 1

const VIEWPORT = "[data-slot=message-scroller-viewport]"
const AGENT_CARD = '[data-slot="agent-card"]'
const QUESTION = '[data-slot="composer-slot"] [data-slot="card"]'
const TEXT = '[data-slot="markdown"]'
const ROW_MARK = '[data-slot="row-mark"]'

const facts = (page, selectors) =>
  page.evaluate((where) => {
    const viewport = document.querySelector(where.viewport)
    const box = (el) => {
      if (!el) return null
      const rect = el.getBoundingClientRect()
      return { width: Math.round(rect.width), left: Math.round(rect.left) }
    }
    // A reply's text, not the user's own bubble: a bubble is w-fit around its words, and this rule
    // is about the reading column a reply stands on, which is the widest text block on the page.
    const widest = (selector) =>
      box(
        [...document.querySelectorAll(selector)].sort(
          (a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width,
        )[0],
      )
    return {
      pane: viewport.offsetWidth,
      thread: viewport.clientWidth,
      header: box(chatHeaderRow(viewport)),
      card: box(document.querySelector(where.card)),
      question: box(document.querySelector(where.question)),
      text: widest(where.text),
    }

    function chatHeaderRow(pane) {
      const left = pane.getBoundingClientRect().left
      return [...document.querySelectorAll('[data-slot="header-row"]')].find(
        (row) => row.getBoundingClientRect().left >= left,
      )
    }
  }, selectors)

await flow(
  "card-widths",
  async ({ page, seed, send, lastReply, until, shot }) => {
    const chat = `e2e-card-widths-${runId()}`
    await seed([{ id: chat, title: "Card widths" }])
    await page.goto(`${app}/c/${chat}`)

    await send("delegate this to someone")
    await until(
      () =>
        page
          .locator(AGENT_CARD)
          .count()
          .then((count) => count > 0),
      30_000,
      "the subagent's card to draw",
    )
    await until(
      async () => (await lastReply(chat))?.status === "done",
      60_000,
      "the delegated turn to finish",
    )

    await send("ask me something")
    await page
      .getByRole("button", { name: /Older than 90 days/ })
      .first()
      .waitFor({ timeout: 20_000 })

    for (const width of [1024, 390, 1440, 1920]) {
      await page.setViewportSize({ width, height: width < 768 ? 844 : 768 })
      // Both thread boxes are brought on screen before either is read, so neither reports the
      // placeholder size an off-screen content-visibility item keeps.
      await page.locator(AGENT_CARD).scrollIntoViewIfNeeded()
      await page.locator(TEXT).first().scrollIntoViewIfNeeded()
      await settled(page)
      const seen = await facts(page, {
        viewport: VIEWPORT,
        card: AGENT_CARD,
        question: QUESTION,
        text: TEXT,
      })
      const where = `${width}px`
      const near = (actual, expected, message) =>
        assert.ok(
          Math.abs(actual - expected) <= TOLERANCE,
          `${message} (${actual}px of ${expected}px)`,
        )
      // The composer slot keeps the gutters it already has: px-3 on a phone, sm:px-4 from 640px.
      const slot = width < 640 ? 12 : GUTTER
      const waiting = seen.pane - 2 * slot
      const questionWidth = Math.min(waiting, BOX_PX)
      assert.ok(seen.header, `the chat's header is on the page at ${where}`)
      const header = seen.header

      assert.ok(seen.text, `a reply's text is on the page at ${where}`)
      near(
        seen.text.left,
        header.left,
        `a reply's text starts where the header does at ${where}, in a ${seen.pane}px pane`,
      )
      near(
        seen.text.width,
        header.width,
        `and it is as wide as the header at ${where}, in a ${seen.pane}px pane`,
      )
      assert.ok(
        seen.text.width <= BOX_PX + TOLERANCE,
        `a reply's text never passes the ${BOX_PX}px box at ${where} (${seen.text.width}px)`,
      )

      assert.ok(seen.card, `the subagent's card is on the page at ${where}`)
      near(
        seen.card.left,
        seen.text.left,
        `the subagent's card stands on the reply's edge at ${where}, in a ${seen.pane}px pane`,
      )
      near(
        seen.card.width,
        seen.text.width,
        `and fills the same column at ${where}, in a ${seen.pane}px pane`,
      )

      assert.ok(seen.question, `the waiting Question is on the page at ${where}`)
      near(
        seen.question.width,
        questionWidth,
        `the waiting Question fills the composer slot up to the ${BOX_PX}px cap at ${where}, ${slot}px gutter each side in a ${seen.pane}px pane`,
      )
      if (slot === GUTTER)
        near(
          seen.question.left,
          header.left,
          `and lines up with the header where the slot keeps the header's gutter at ${where}, in a ${seen.pane}px pane`,
        )

      const path = await shot(`at-${width}`)
      pass(
        `${where}: header ${header.width}px at ${header.left}px, text ${seen.text.width}px at ${seen.text.left}px, card ${seen.card.width}px at ${seen.card.left}px, question ${seen.question.width}px at ${seen.question.left}px, in a ${seen.pane}px pane${path ? ` (${path})` : ""}`,
      )
    }

    const bot = await page.evaluate(async () => {
      const { db } = await import("/src/lib/db.ts")
      return (await db.profiles.toArray())[0].id
    })
    for (const width of [390, 1920]) {
      await page.setViewportSize({ width, height: width < 768 ? 844 : 900 })
      await page.goto(`${app}/b/${bot}/sidechats`)
      await page.locator(ROW_MARK).first().waitFor()
      await settled(page)
      const list = await page.evaluate((mark) => {
        const left = (el) => Math.round(el.getBoundingClientRect().left)
        const marks = [...document.querySelectorAll(mark)]
        const rows = [...document.querySelectorAll('[data-slot="header-row"]')]
        const row = rows.sort((a, b) => left(b) - left(a))[0]
        return {
          header: left(row),
          mark: Math.min(...marks.map(left).filter((x) => x >= left(row) - 1)),
        }
      }, ROW_MARK)
      assert.ok(
        Math.abs(list.mark - list.header) <= TOLERANCE,
        `a bot's chat list's rows start where its header does at ${width}px (${list.mark}px against ${list.header}px)`,
      )
      const path = await shot(`list-at-${width}`)
      pass(
        `${width}px: list rows at ${list.mark}px under a header at ${list.header}px${path ? ` (${path})` : ""}`,
      )
    }
  },
  { viewport: { width: 1024, height: 768 } },
)
