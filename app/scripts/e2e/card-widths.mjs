// A card the app draws inside a chat fills the pane with the thread's own gutter, at a phone's width
// and a tablet's, while message text keeps the 768px reading column the composer sits in (ADR 0041).
// Width is layout, which no DOM without a layout engine has (ADR 0019), so the arithmetic a review
// can only eyeball — a card's width and where its left edge falls — is measured here in the sweep.
//
// The column is measured at 1440px, not at the tablet's 1024px: with the sidebar docked the pane is
// 704px there, narrower than the 736px column, so text and cards coincide and nothing but the 448px
// cap could show. The phone is the same no-op by decision, and is asserted as one.
import { app, assert, flow, pass, runId, settled } from "./lib.mjs"

const GUTTER = 16
const COLUMN = 736
const SLOP = 1

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
const facts = (page) =>
  page.evaluate(() => {
    const viewport = document.querySelector("[data-slot=message-scroller-viewport]")
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
      screen: window.innerWidth,
      card: box('[data-slot="agent-card"]'),
      question: box('[data-toast-above] [data-slot="card"]'),
      text: box('[data-slot="markdown"]'),
    }
  })

await flow(
  "card-widths",
  async ({ page, seed, send, lastReply, until, shot }) => {
    const chat = `e2e-card-widths-${runId()}`
    await seed([{ id: chat, title: "Card widths" }])
    await page.goto(`${app}/c/${chat}`)

    // A delegated turn leaves one card in the thread, and it stays there once the turn is done.
    await send("delegate this to someone")
    await until(
      () => page.locator('[data-slot="agent-card"]').count().then((count) => count > 0),
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

    const at = async (width) => {
      await page.setViewportSize({ width, height: width < 768 ? 844 : 768 })
      // Both thread boxes are brought on screen before either is read, so neither reports the
      // placeholder size an off-screen content-visibility item keeps.
      await page.locator('[data-slot="agent-card"]').scrollIntoViewIfNeeded()
      await page.locator('[data-slot="markdown"]').first().scrollIntoViewIfNeeded()
      await settled(page)
      return facts(page)
    }

    const measured = new Map()
    for (const width of [1024, 390]) {
      const seen = await at(width)
      const where = `${width}px`
      // The composer slot keeps the gutters it already has: px-3 on a phone, sm:px-4 from 640px.
      const slot = width < 640 ? 12 : GUTTER
      // Where the pane is narrower than the column, the column collapses onto it: the card and the
      // text beside it take the same width, which is the phone's own case and a tablet's with the
      // sidebar docked.
      const expected = { card: seen.thread - 2 * GUTTER, question: seen.pane - 2 * slot }

      assert.ok(seen.card, `the subagent's card is on the page at ${where}`)
      assert.ok(
        Math.abs(seen.card.width - expected.card) <= SLOP,
        `the subagent's card fills the thread's pane at ${where} (${seen.card.width}px of ${expected.card}px, a ${seen.pane}px pane less the scrollbar's ${seen.pane - seen.thread}px and ${GUTTER}px gutter each side)`,
      )
      assert.ok(
        Math.abs(seen.card.left - GUTTER) <= SLOP,
        `and its left edge sits on the thread's gutter at ${where} (${seen.card.left}px of ${GUTTER}px, in a ${seen.pane}px pane)`,
      )

      assert.ok(seen.question, `the waiting Question is on the page at ${where}`)
      assert.ok(
        Math.abs(seen.question.width - expected.question) <= SLOP,
        `the waiting Question spans the composer slot at ${where} (${seen.question.width}px of ${expected.question}px, a ${seen.pane}px pane less ${slot}px gutter each side)`,
      )
      assert.ok(
        Math.abs(seen.question.left - slot) <= SLOP,
        `and its left edge sits on that slot's gutter at ${where} (${seen.question.left}px of ${slot}px, in a ${seen.pane}px pane)`,
      )

      assert.ok(seen.text, `a reply's text is on the page at ${where}`)
      assert.ok(
        Math.abs(seen.text.width - expected.card) <= SLOP,
        `message text fills the pane where it holds no column at ${where} (${seen.text.width}px of ${expected.card}px, in a ${seen.pane}px pane)`,
      )

      measured.set(width, seen)
      const path = await shot(`at-${width}`)
      pass(
        `${where}: card ${seen.card.width}px of ${expected.card}px at ${seen.card.left}px, question ${seen.question.width}px of ${expected.question}px at ${seen.question.left}px, text ${seen.text.width}px at ${seen.text.left}px, in a ${seen.pane}px pane${path ? ` (${path})` : ""}`,
      )
    }

    // The laptop's width: the pane clears the column, so text keeps its measure and the card is
    // wider than the text beside it — the difference the tablet's docked sidebar hides.
    const seen = await at(1440)
    assert.ok(
      seen.thread > COLUMN,
      `the pane is wider than the reading column at 1440px, so the two are told apart (${seen.thread}px of ${COLUMN}px, in a ${seen.pane}px pane)`,
    )
    assert.ok(seen.text, "a reply's text is on the page at 1440px")
    assert.ok(
      Math.abs(seen.text.width - COLUMN) <= SLOP,
      `message text keeps the ${COLUMN}px reading column at 1440px (${seen.text.width}px in a ${seen.pane}px pane)`,
    )
    assert.ok(
      Math.abs(seen.text.left - Math.round((seen.thread - COLUMN) / 2)) <= SLOP,
      `and the column is centred in the pane at 1440px (${seen.text.left}px of ${Math.round((seen.thread - COLUMN) / 2)}px, in a ${seen.pane}px pane)`,
    )
    assert.ok(
      seen.card.width > seen.text.width,
      `the card uses the screen the text keeps its column in at 1440px (${seen.card.width}px against ${seen.text.width}px, in a ${seen.pane}px pane)`,
    )
    // The composer slot's own cap is the one a wide pane shows: where the pane is narrower than
    // it, a capped and a filled card are the same width.
    assert.ok(seen.question, "the waiting Question is on the page at 1440px")
    assert.ok(
      Math.abs(seen.question.width - (seen.pane - 2 * GUTTER)) <= SLOP,
      `the waiting Question spans the composer slot at 1440px (${seen.question.width}px of ${seen.pane - 2 * GUTTER}px, ${GUTTER}px gutter each side, in a ${seen.pane}px pane)`,
    )
    assert.ok(
      Math.abs(seen.question.left - GUTTER) <= SLOP,
      `and its left edge sits on that slot's gutter at 1440px (${seen.question.left}px of ${GUTTER}px, in a ${seen.pane}px pane)`,
    )
    const path = await shot("at-1440")
    pass(
      `1440px: text ${seen.text.width}px at ${seen.text.left}px of a ${seen.pane}px pane, card ${seen.card.width}px at ${seen.card.left}px, question ${seen.question.width}px at ${seen.question.left}px${path ? ` (${path})` : ""}`,
    )
  },
  { viewport: { width: 1024, height: 768 } },
)
