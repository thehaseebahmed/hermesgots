// A card the app draws inside a chat fills the pane with the thread's own gutter, at a phone's width
// and a tablet's, while message text keeps the 768px reading column the composer sits in (ADR 0041).
// Width is layout, which no DOM without a layout engine has (ADR 0019), so the arithmetic a review
// can only eyeball — a card's width and where its left edge falls — is measured here in the sweep.
//
// The column is measured at 1440px, not at the tablet's 1024px: with the sidebar docked the pane is
// 704px there, narrower than the 736px column, so text and cards coincide and nothing but the 448px
// cap could show. The phone is the same no-op by decision, and each width asserts what it can tell.
import { app, assert, flow, pass, runId, settled } from "./lib.mjs"

const GUTTER = 16
const COLUMN_PX = 736
const TOLERANCE = 1

const VIEWPORT = "[data-slot=message-scroller-viewport]"
const AGENT_CARD = '[data-slot="agent-card"]'
const QUESTION = '[data-slot="composer-slot"] [data-slot="card"]'
const TEXT = '[data-slot="markdown"]'

/**
 * One walk of the page for every box this flow measures: the chat's pane, the subagent's card in the
 * thread, the waiting Question in the composer slot below it, and a reply's text. Each width is read
 * against the pane's own left edge rather than the screen's, so a chat drawn beside a list measures
 * the pane it is drawn in.
 *
 * `pane` is the chat pane the composer slot and the thread share, `thread` the box the thread's
 * content is laid in — the pane less the scrollbar gutter it reserves, so a wide card never sits
 * under the scrollbar. The thread's items use content-visibility, so an item that is off screen
 * reports a box it never laid out: the caller brings both on screen before reading them.
 */
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

    // A delegated turn leaves one card in the thread, and it stays there once the turn is done.
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

    // The waiting Question takes the composer's slot, below the thread rather than in it.
    await send("ask me something")
    await page
      .getByRole("button", { name: /Older than 90 days/ })
      .first()
      .waitFor({ timeout: 20_000 })

    // Every width the rule is judged on, and everything each can tell: the two cards against the
    // container they stand in, and the text against its column wherever the pane clears one.
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
      // What each container fills to: the thread's content sits beside the scrollbar gutter its box
      // reserves, the slot has none, so each card is measured against its own container.
      const fill = seen.thread - 2 * GUTTER
      const waiting = seen.pane - 2 * slot
      // Where the pane is narrower than the column the column collapses onto it — the phone's own
      // case, and a tablet's with the sidebar docked. At 1440 the pane clears it and the two are
      // told apart.
      const column = seen.thread > COLUMN_PX

      assert.ok(seen.card, `the subagent's card is on the page at ${where}`)
      near(
        seen.card.width,
        fill,
        `the subagent's card fills the thread's pane at ${where}, a ${seen.pane}px pane less the scrollbar's ${seen.pane - seen.thread}px and the ${GUTTER}px gutter each side`,
      )
      near(
        seen.card.left,
        GUTTER,
        `and its left edge sits on the thread's gutter at ${where}, in a ${seen.pane}px pane`,
      )

      assert.ok(seen.question, `the waiting Question is on the page at ${where}`)
      near(
        seen.question.width,
        waiting,
        `the waiting Question spans the composer slot at ${where}, ${slot}px gutter each side in a ${seen.pane}px pane`,
      )
      near(
        seen.question.left,
        slot,
        `and its left edge sits on that slot's gutter at ${where}, in a ${seen.pane}px pane`,
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
        assert.ok(
          seen.card.width > seen.text.width,
          `the card uses the screen the text keeps its column in at ${where} (${seen.card.width}px against ${seen.text.width}px, in a ${seen.pane}px pane)`,
        )
      } else {
        near(
          seen.text.width,
          fill,
          `message text fills the pane where it holds no column at ${where}, in a ${seen.pane}px pane`,
        )
      }

      const path = await shot(`at-${width}`)
      pass(
        `${where}: card ${seen.card.width}px at ${seen.card.left}px, question ${seen.question.width}px at ${seen.question.left}px, text ${seen.text.width}px at ${seen.text.left}px${column ? ` of the ${COLUMN_PX}px column` : ""}, in a ${seen.pane}px pane${path ? ` (${path})` : ""}`,
      )
    }
  },
  { viewport: { width: 1024, height: 768 } },
)
