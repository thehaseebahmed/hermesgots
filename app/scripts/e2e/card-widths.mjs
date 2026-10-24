// The rule is ADR 0046 — a card never passes the reading column's box — measured here because width
// is layout that no DOM without a layout engine has (ADR 0019).
import { app, assert, flow, pass, runId, settled } from "./lib.mjs"

const GUTTER = 16
const COLUMN_PX = 736
const BOX_PX = 768
const TOLERANCE = 1

const VIEWPORT = "[data-slot=message-scroller-viewport]"
const AGENT_CARD = '[data-slot="agent-card"]'
const QUESTION = '[data-slot="composer-slot"] [data-slot="card"]'
const TEXT = '[data-slot="markdown"]'

const facts = (page, selectors) =>
  page.evaluate((where) => {
    const viewport = document.querySelector(where.viewport)
    const origin = viewport.getBoundingClientRect().left
    const box = (selector) => {
      const el = document.querySelector(selector)
      if (!el) return null
      const rect = el.getBoundingClientRect()
      return { width: Math.round(rect.width), left: Math.round(rect.left - origin) }
    }
    return {
      pane: viewport.offsetWidth,
      thread: viewport.clientWidth,
      card: box(where.card),
      question: box(where.question),
      text: box(where.text),
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
      () => page.locator(AGENT_CARD).count().then((count) => count > 0),
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

    for (const width of [1024, 390, 1440]) {
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
      const fill = seen.thread - 2 * GUTTER
      const waiting = seen.pane - 2 * slot
      const column = seen.thread > COLUMN_PX
      // The rule: a card fills the box it is given, and stops at the reading column's box above
      // that, centred in both cases.
      const cardWidth = Math.min(fill, BOX_PX)
      const questionWidth = Math.min(waiting, BOX_PX)

      assert.ok(seen.card, `the subagent's card is on the page at ${where}`)
      assert.ok(
        seen.card.width <= BOX_PX + TOLERANCE,
        `the subagent's card never passes the reading column's box at ${where} (${seen.card.width}px in a ${seen.pane}px pane)`,
      )
      near(
        seen.card.width,
        cardWidth,
        `the subagent's card fills the thread's box up to the ${BOX_PX}px cap at ${where}, a ${seen.pane}px pane less the scrollbar's ${seen.pane - seen.thread}px and the ${GUTTER}px gutter each side`,
      )
      near(
        seen.card.left,
        GUTTER + Math.round((fill - cardWidth) / 2),
        `and its left edge sits on that gutter — or centres inside the cap on a wide pane — at ${where}, in a ${seen.pane}px pane`,
      )

      assert.ok(seen.question, `the waiting Question is on the page at ${where}`)
      assert.ok(
        seen.question.width <= BOX_PX + TOLERANCE,
        `the waiting Question never passes the reading column's box at ${where} (${seen.question.width}px in a ${seen.pane}px pane)`,
      )
      near(
        seen.question.width,
        questionWidth,
        `the waiting Question fills the composer slot up to the ${BOX_PX}px cap at ${where}, ${slot}px gutter each side in a ${seen.pane}px pane`,
      )
      near(
        seen.question.left,
        slot + Math.round((waiting - questionWidth) / 2),
        `and its left edge sits on that slot's gutter — or centres inside the cap on a wide pane — at ${where}, in a ${seen.pane}px pane`,
      )

      assert.ok(seen.text, `a reply's text is on the page at ${where}`)
      if (column) {
        near(
          seen.text.width,
          COLUMN_PX,
          `message text keeps the ${COLUMN_PX}px reading column at ${where}, in a ${seen.pane}px pane`,
        )
        near(
          seen.text.left,
          Math.round((seen.thread - COLUMN_PX) / 2),
          `and the column is centred in the pane at ${where}, in a ${seen.pane}px pane`,
        )
        if (cardWidth === BOX_PX) {
          // Where the cap binds, the card is the column's own box: the text's measure framed by the
          // 16px gutter the box carries on either side of it.
          near(
            seen.card.width,
            seen.text.width + 2 * GUTTER,
            `the capped card is exactly the text column's box at ${where}, framed ${GUTTER}px each side of the text (${seen.card.width}px around ${seen.text.width}px, in a ${seen.pane}px pane)`,
          )
          near(
            seen.card.left + GUTTER,
            seen.text.left,
            `so the card's edge lines up with the box the text sits in at ${where} (${seen.card.left}px + ${GUTTER}px against the text's ${seen.text.left}px, in a ${seen.pane}px pane)`,
          )
        }
      } else {
        near(
          seen.text.width,
          fill,
          `message text fills the pane where it holds no column at ${where}, in a ${seen.pane}px pane`,
        )
      }

      const path = await shot(`at-${width}`)
      pass(
        `${where}: card ${seen.card.width}px at ${seen.card.left}px${seen.card.width === BOX_PX ? ` (at the ${BOX_PX}px cap)` : ""}, question ${seen.question.width}px at ${seen.question.left}px, text ${seen.text.width}px at ${seen.text.left}px${column ? ` of the ${COLUMN_PX}px column` : ""}, in a ${seen.pane}px pane${path ? ` (${path})` : ""}`,
      )
    }
  },
  { viewport: { width: 1024, height: 768 } },
)
