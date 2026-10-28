// One turn on the mock, told to stall so its reasoning is the only thing on the wire for a while:
// the only way a poll can look at a thread mid-thought. Two calls run back to back in it, so the
// reply draws every stretch of its thinking as one row above the one tool group those calls made —
// a tool row never lands between two thought rows (ADR 0054). The merge is layout no lower tier
// reaches, and the row is the only place a reader touches thinking now: it opens the working-out in
// the same sheet the tool row opens, and the sheet's follow on a live run, the wheel inside it that
// stops that follow and the whole height of its body are all geometry the browser has and jsdom
// cannot give. See ADR 0050.
import { assert, app, flow, pass, settled } from "./lib.mjs"
// What a row reads is the app's own rule, imported rather than restated: a second copy of the label
// format here could drift from the one the thread draws and still pass.
import { thinkingLabel } from "../../src/lib/thinking.ts"

/** The reply's own item on the page: its rows, its calls and the sheet are all drawn inside it. */
const ITEM = "[data-slot=message-scroller-item]"
const WORKING = "[data-slot=status-line]"
const THINKING = /^(Thinking…|Thought it through|Thought for \d+[sm])/
const SPAN = /^Thought for \d+s$/
const ROW = "[data-slot=thinking-line]"
const SHEET = "[data-slot=thinking-sheet]"
const BODY = "[data-slot=thinking-body]"
const STATUS_WORDS = "[data-slot=status-words]"
/** How long the line is watched after its words land: a line still typing would move inside it. */
const STEADY_MS = 600
/** The share of the viewport height the deleted `max-h-[30dvh]` cap held: a sheet body outgrows it. */
const FORMER_CAP_SHARE = 0.3
const FIRST = "working-out, not just the answer"
const MEASURED = "The first look says five gigabytes"
const ROTATIONS = "gzipped rotations are the bulk of it"
const ACCOUNTING = "The journal's own accounting agrees"
const LAST = "leaves the delete to them"
const LONG_FIRST = "the reasoning itself, so here is the whole of it"
const LONG_LAST = "The deleting is theirs"
/** How tall a reply's work row stands: the exception to the app's 44px target (ADR 0058). */
const ROW_HEIGHT = 29

await flow("thinking-line", async ({ page, send, lastReply, until, shot }) => {
  await page.goto(app)
  await send("think out loud, then stall: where did the space under /var/log go?")
  await page.waitForURL("**/c/**", { timeout: 15_000 })
  const chatId = new URL(page.url()).pathname.split("/").at(-1)
  const item = page.locator(ITEM).last()
  const rows = item.locator(ROW).locator("button")

  // Everything the reply draws that only the browser has: each row's label and whether it spins,
  // the order the rows and calls are drawn in, the sheet when one is open — its words, its box and
  // where it is scrolled to — and whether a cap, a fade or a Show more survives anywhere.
  const threadState = () =>
    page.evaluate(
      ({ item, row, label, sheet: sheetSlot, body: bodySlot }) => {
        const names = new RegExp(label)
        const own = [...document.querySelectorAll(item)].at(-1)
        const buttons = [...(own?.querySelectorAll("button") ?? [])]
        const lines = [...(own?.querySelectorAll(row) ?? [])]
        const view = document.querySelector("[data-slot=message-scroller-viewport]")
        const sheet = document.querySelector(sheetSlot)
        const body = document.querySelector(bodySlot)
        const box = (node) => {
          if (!node) return null
          const rect = node.getBoundingClientRect()
          return {
            top: Math.round(rect.top),
            bottom: Math.round(rect.bottom),
            height: Math.round(rect.height),
          }
        }
        // A part's inner left edge: its box less the inset it carries, so a row and the text beside
        // it are compared at the pixels their readers see rather than at their containers' edges.
        const edge = (node) => {
          if (!node) return null
          const rect = node.getBoundingClientRect()
          return { ...box(node), left: Math.round(rect.left + parseFloat(getComputedStyle(node).paddingLeft)) }
        }
        const parts = (slot) => [...(own?.querySelectorAll(`[data-slot=${slot}]`) ?? [])]
        return {
          // A row is one element carrying its label — a button while there is a sheet to open, a
          // status row before any word arrives — and its words live in the sheet alone, so a shut
          // row holds none of them in the thread.
          rows: lines.map((drawn) => {
            const control = drawn.firstElementChild
            return {
              label: control?.textContent?.trim() ?? null,
              expanded: control?.getAttribute("aria-expanded") ?? null,
              spins: Boolean(control?.querySelector("[data-slot=spinner]")),
            }
          }),
          // The reply's drawn things in the order they are drawn: a thinking row is a button whose
          // text is its label, and the calls that touch draw as one button of their own.
          order: buttons.map((one) => {
            const text = one.textContent?.trim() ?? ""
            return names.test(text) ? { kind: "thinking", text } : { kind: "tool", text }
          }),
          // How the reply's parts stand against each other: each one's inner left edge, and the box
          // a thought row and its group meet at.
          layout: {
            rows: parts("thinking-line").map((line) => edge(line.firstElementChild ?? line)),
            groups: parts("tool-group").map(edge),
            text: parts("markdown").map(edge),
          },
          // Asked of the row, not of the reply: the footer's own loader is a spinner too, and it
          // stands down only while a row names the work.
          groupSpins: parts("tool-group").map((one) =>
            Boolean(one.querySelector("[data-slot=spinner]")),
          ),
          group: own?.querySelector("[data-slot=tool-group]")?.getAttribute("aria-label") ?? null,
          groups: own?.querySelectorAll("[data-slot=tool-group]").length ?? 0,
          // The sheet is one pop-up wherever a row opened it: its body holds the whole markdown.
          sheet:
            sheet && body
              ? {
                  text: body.textContent ?? "",
                  box: box(body),
                  drawn: { height: body.scrollHeight, client: body.clientHeight },
                  scroll: {
                    top: sheet.scrollTop,
                    height: sheet.clientHeight,
                    total: sheet.scrollHeight,
                  },
                  frame: box(sheet),
                }
              : null,
          cap: document.querySelectorAll("[data-slot=thinking-cap]").length,
          fade: document.querySelectorAll("[data-slot=thinking-fade]").length,
          frame: box(view),
          scroll: view && { top: view.scrollTop, height: view.clientHeight, total: view.scrollHeight },
          screen: { width: window.innerWidth, height: window.innerHeight },
        }
      },
      { item: ITEM, row: ROW, label: THINKING.source, sheet: SHEET, body: BODY },
    )

  /**
   * The reply's work rows are one block: a row meets the group it accounts for with no part gap
   * between them, the reply's own words stand apart from it, and every part stands on one left edge
   * — geometry only a laid-out page has, which is why it is asserted here and at every width.
   */
  const standing = (state, where) => {
    const { rows: drawn, groups, text } = state.layout
    assert.equal(drawn.length, 1, `${where}, the reply drew one row of thinking`)
    assert.equal(drawn[0].height, ROW_HEIGHT, `${where}, the row stands ${ROW_HEIGHT}px tall`)
    for (const group of groups)
      assert.equal(group.height, ROW_HEIGHT, `${where}, a tool group stands ${ROW_HEIGHT}px tall too`)
    assert.ok(text.length > 0, `${where}, the reply answers after the work it did`)
    const edges = [...drawn, ...groups, ...text].map((one) => one.left)
    assert.equal(
      new Set(edges).size,
      1,
      `${where}, every part stands on one left edge (${edges.join(", ")})`,
    )
  }

  /** The same, for a reply whose thinking a tool group follows: the two of them one block. */
  const meets = (state, where) => {
    standing(state, where)
    const { rows: drawn, groups, text } = state.layout
    assert.equal(groups.length, 1, `${where}, the one group the calls it broke made`)
    assert.ok(
      Math.abs(groups[0].top - drawn[0].bottom) <= 1,
      `${where}, the row touches the group under it (${drawn[0].bottom} to ${groups[0].top}px)`,
    )
    assert.ok(
      text[0].top - groups[0].bottom >= 8,
      `${where}, its words stand apart from that block (${text[0].top - groups[0].bottom}px)`,
    )
  }

  // The cap, the fade and the control it sat behind are gone from the app, and the words are gone
  // from the thread: nothing may draw any of them, at any width, whatever a row is doing.
  const uncapped = async (where) => {
    const state = await threadState()
    assert.equal(state.cap, 0, `${where} draws no thinking cap`)
    assert.equal(state.fade, 0, `${where} draws no fade at one`)
    assert.equal(
      await page.getByRole("button", { name: "Show more" }).count(),
      0,
      `${where} offers no Show more control anywhere on the page`,
    )
    return state
  }

  /** A run's words are in its sheet or nowhere: never a body in the thread's own scroll. */
  const inThread = async (snippet, where) => {
    assert.ok(
      !((await item.textContent()) ?? "").includes(snippet),
      `${where}, the run's words are not drawn in the thread`,
    )
  }

  // A smooth scroll into place is not an animation `settled` waits for, so a reading taken straight
  // after a sheet opens can catch it mid-move: wait for its scroll to come to rest first. A scroll
  // that never rests is this leg failing, so the wait's timeout is left to speak.
  const rested = async (slot) => {
    let last = -1
    await until(
      async () => {
        const top = await page.evaluate((sel) => document.querySelector(sel)?.scrollTop ?? -1, slot)
        const still = top === last
        last = top
        return still
      },
      5_000,
      "the scroller to stop moving",
    )
    await settled(page)
  }

  /**
   * How far below what the sheet shows the run's own end still lies: 0, the follow is holding it.
   * Measured off the body, not the scroll box's own total — the wrapper pads 24px below the run's
   * last words, and that empty floor is not more of the run to read.
   */
  const foot = (state) =>
    state.sheet
      ? Math.max(0, state.sheet.box.bottom - state.sheet.frame.bottom)
      : Infinity

  /** Whether the body has outgrown the share of the screen the old cap held it to. */
  const tall = (state) =>
    Boolean(
      state.sheet && state.sheet.drawn.height > state.screen.height * FORMER_CAP_SHARE,
    )

  /**
   * The sheet holds the whole run: past the old cap's share of the screen, and drawn in full — the
   * body's own height against the room the sheet gives it.
   */
  const whole = (state, where) => {
    const drawn = state.sheet.drawn
    assert.ok(
      tall(state),
      `${where}: ${drawn.height}px of run past the ${Math.round(state.screen.height * FORMER_CAP_SHARE)}px the old cap held`,
    )
    assert.ok(
      drawn.height <= drawn.client + 1,
      `${where}: nothing clipped out of it (${drawn.height}px of ${drawn.client}px drawn)`,
    )
  }

  /** Opens a row's sheet and waits for the words to reach it. */
  const open = async (index, where) => {
    await rows.nth(index).click()
    const opened = await until(
      async () => {
        const state = await threadState()
        return state.sheet ? state : null
      },
      10_000,
      `${where}'s sheet to open`,
    )
    await settled(page)
    return opened
  }

  /** Closes the sheet the way a reader does — their own key — and waits for the words to go. */
  const shut = async () => {
    await page.keyboard.press("Escape")
    await until(
      async () => ((await page.evaluate((sel) => !document.querySelector(sel), BODY)) ? true : null),
      5_000,
      "the sheet to close",
    )
    await settled(page)
  }

  // The turn's own pause and lead-in: nothing has arrived, so the row carries the turn — its words
  // spinning on screen from the first moment the reply works, before a word of thinking arrives.
  // The store is waited on first (the row and the footer's line are drawn in one render), then the
  // row itself through the thread's own probe, which is where every other reading of it comes from.
  await until(
    async () =>
      page.evaluate(async (id) => {
        const { getMessages } = await import("/src/lib/db.ts")
        const last = (await getMessages(id)).at(-1)
        if (last?.role !== "assistant" || last.status !== "streaming") return null
        return !last.reasoningRuns?.length && !last.content ? true : null
      }, chatId),
    20_000,
    "the reply to be up, streaming, before any thinking lands",
  )
  const before = await until(
    async () => {
      const state = await threadState()
      return state.rows.length === 1 && state.rows[0].label === "Thinking…" ? state : null
    },
    10_000,
    "the row carrying the turn before any thinking lands",
  )
  assert.equal(before.rows.length, 1, "the row is on screen from the first moment the turn works")
  assert.equal(before.rows[0].spins, true, "its spinner turning, before a word of thinking arrives")
  assert.equal(
    before.rows[0].expanded,
    null,
    "as a status row with nothing to open: its stretch has not arrived",
  )
  assert.equal(before.sheet, null, "and no sheet drawn for a row holding no words")
  const says = await page.evaluate((sel) => document.querySelector(sel)?.textContent ?? "", WORKING)
  assert.ok(!/Writing…|Thinking…/.test(says), "the footer says nothing while the row says it")
  await shot("working")
  pass("the row spins from the turn's first working moment, the footer silent")

  // The first stretch landing with more of it still to come, and nothing said: a single block would
  // have put the whole working-out on the row at once, which is what the mock is told not to do.
  await until(
    async () => {
      const reply = await lastReply(chatId)
      if (reply?.status !== "streaming" || reply.runs.length !== 1) return null
      return !reply.content && reply.runs[0].text.includes(FIRST) ? reply : null
    },
    30_000,
    "the turn's first thinking to land, with more of it still to come",
  )
  const streaming = await until(
    async () => {
      const state = await threadState()
      return state.rows.length === 1 && state.rows[0].label === "Thinking…" ? state : null
    },
    5_000,
    "the thinking to reach the row",
  )
  assert.equal(streaming.rows[0].spins, true, "the row spins: it is still thinking")
  assert.equal(streaming.rows[0].expanded, "false", "and its words are shut in the sheet")
  assert.equal(streaming.sheet, null, "with no sheet open")
  await inThread(FIRST, "while the turn thinks")
  await uncapped("while the turn is thinking")

  // Tapping the live row opens the sheet on its newest words, which it then keeps in view.
  const opened = await open(0, "the live row")
  assert.ok(opened.sheet.text.includes(FIRST), "the sheet holds the piece that landed")
  const arrived = await until(
    async () => {
      const state = await threadState()
      return state.sheet && foot(state) <= 8 ? state : null
    },
    10_000,
    "the sheet to land on the run's newest words",
  )
  assert.equal(arrived.rows[0].expanded, "true", "the row stands open while its sheet is up")
  await shot("opened-live")
  pass("tapping the row mid-thought opens the sheet on the run's newest words")
  await shut()

  // A call ends that stretch. The stretch after the call joins the row above it — a tool row never
  // lands between two thought rows — so the row keeps spinning over both.
  const latched = await until(
    async () => {
      const reply = await lastReply(chatId)
      if (reply?.status !== "streaming" || reply.runs.length !== 2 || reply.content) return null
      return reply.runs[1].text.includes(MEASURED) && reply.runs[0].spanMs !== null ? threadState() : null
    },
    30_000,
    "the first call to land with the thinking after it streaming",
  )
  assert.equal(latched.rows.length, 1, "the call adds no row: the stretch after it joins the one")
  assert.equal(
    latched.rows[0].label,
    "Thinking…",
    "the row reads the turn's thinking while the stretch after the call arrives",
  )
  assert.equal(latched.rows[0].spins, true, "its spinner turning while that stretch streams")
  assert.deepEqual(
    latched.order.map((one) => one.kind),
    ["thinking", "tool"],
    "the row drawn above the call it led into, the call last",
  )
  await inThread(MEASURED, "after the first call")
  await shot("latched")
  pass("the call draws no second row: the row above it keeps spinning while the next stretch streams")

  // A second call, straight after the first with nothing said between them: the two draw as ONE tool
  // group, and every stretch of the turn's thinking sits above it as one row holding all their
  // words — a tool row never lands between two thought rows.
  const merged = await until(
    async () => {
      const reply = await lastReply(chatId)
      if (reply?.status !== "streaming" || reply.runs.length !== 3 || reply.content) return null
      return reply.runs[2].text.includes(ACCOUNTING) ? threadState() : null
    },
    30_000,
    "the second call to land with the thinking after it streaming",
  )
  const twoCalls = await lastReply(chatId)
  assert.equal(twoCalls.tools, 2, "the reply ran two calls")
  assert.notEqual(
    twoCalls.runs[1].afterToolId,
    twoCalls.runs[2].afterToolId,
    "each stretch follows a call of its own, so the two are runs apart",
  )
  assert.ok(twoCalls.runs[1].afterToolId, "and neither of them is the run at the reply's top")
  assert.equal(merged.groups, 1, "the two calls that touch draw as one tool group, not two")
  assert.match(
    merged.group ?? "",
    /\b2 commands\b/,
    `and the group says how many calls it holds ("${merged.group}")`,
  )
  assert.equal(merged.rows.length, 1, "every stretch of the turn draws as one row")
  assert.equal(
    merged.rows[0].label,
    "Thinking…",
    "which says it is thinking while its newest stretch streams",
  )
  assert.deepEqual(
    merged.order.map((one) => one.kind),
    ["thinking", "tool"],
    "the row above the one group both calls made, with nothing drawn under it",
  )
  await inThread(ROTATIONS, "with two calls drawn")

  // That one row's sheet holds every stretch, in the order they arrived, each once.
  const both = await open(0, "the merged row")
  const first = both.sheet.text.indexOf(ROTATIONS)
  const then = both.sheet.text.indexOf(ACCOUNTING)
  assert.ok(first >= 0, "holding the stretch the first call broke")
  assert.ok(then >= 0, "and the one the second call broke")
  assert.ok(first < then, "in the order they arrived")
  assert.equal(both.sheet.text.split(ROTATIONS).length - 1, 1, "each stretch once, not once a row")
  await shot("merged")
  pass("two calls back to back draw as one tool group, every stretch as one row above it")
  await shut()

  // The last piece, the turn still holding: nothing has folded, and nothing may — the labels are
  // what changes as stretches end.
  await until(
    async () => {
      const reply = await lastReply(chatId)
      if (!reply || reply.content || !reply.runs.at(-1)?.text.includes(LAST)) return null
      const state = await threadState()
      return state.rows.length === 1 && state.rows[0].label === "Thinking…" ? state : null
    },
    20_000,
    "the turn's last thinking piece to land with the row still thinking",
  )
  pass("the turn thinks to its last piece with the one row above its calls still spinning")

  // What the row may read now that its spans are frozen: the sum of every stretch it holds — never
  // the part of it this device measured for one of them.
  await until(
    async () => ((await lastReply(chatId))?.content ? true : null),
    30_000,
    "the reply's first answer token",
  )
  const measured = await lastReply(chatId)
  const spans = measured.runs.map((run) => run.spanMs)
  assert.equal(spans.length, 3, "the reply keeps three stretches of thinking")
  assert.ok(
    spans.every((one) => typeof one === "number"),
    "every one of them measured on this device, watching it arrive",
  )
  const labels = [thinkingLabel({ thinking: false, spanMs: spans[0] + spans[1] + spans[2] })]
  const frozen = await until(
    async () => {
      const state = await threadState()
      return state.rows.map((one) => one.label).join("|") === labels.join("|") ? state : null
    },
    10_000,
    "the row to read its spans",
  )
  assert.match(frozen.rows[0].label ?? "", SPAN, "the row reads a span, not a plain phrase")
  assert.notEqual(
    frozen.rows[0].label,
    thinkingLabel({ thinking: false, spanMs: spans[0] }),
    "and reads every stretch's span added, not the first of them alone",
  )
  assert.notEqual(
    frozen.rows[0].label,
    thinkingLabel({ thinking: false, spanMs: spans[1] + spans[2] }),
    "nor the two that followed the first call",
  )
  assert.ok(
    frozen.rows.every((one) => one.spins === false),
    "with nothing spinning in the row the turn thought in",
  )
  assert.ok(
    frozen.groupSpins.length > 0 && frozen.groupSpins.every((spinning) => !spinning),
    "nor in the calls' row under it, once both have landed",
  )
  assert.equal(frozen.sheet, null, "the answer closes no sheet: none was open")

  // The accent as this theme resolves it, read once before the wait: it cannot change inside a flow,
  // and a poll that re-derived it would colour a span on the live chat at every turn of the wait.
  const accent = await page.evaluate(() => {
    const probe = document.createElement("span")
    probe.style.color = "var(--color-primary)"
    document.body.append(probe)
    const colour = getComputedStyle(probe).color
    probe.remove()
    return colour
  })
  const lineState = () =>
    page.evaluate(
      ({ line, words }) => {
        const box = document.querySelector(line)
        if (!box) return null
        const span = box.querySelector(words)
        return {
          words: span?.textContent ?? "",
          loader: Boolean(box.querySelector("[data-slot=spinner]")),
          colour: getComputedStyle(box).color,
          wordsColour: span ? getComputedStyle(span).color : "",
        }
      },
      { line: WORKING, words: STATUS_WORDS },
    )
  const writing = await until(
    async () => {
      const state = await lineState()
      return state?.words === "Writing…" ? state : null
    },
    15_000,
    "the footer's line to say the turn is writing",
  )
  assert.ok(writing.loader, "a loader turns beside the words")
  assert.equal(writing.colour, accent, "the loader and its words both read in the accent colour")
  assert.equal(writing.wordsColour, accent, "the words' own text takes it too, not just the row")
  await page.waitForTimeout(STEADY_MS)
  const steady = await lineState()
  assert.equal(steady?.words, "Writing…", "the words stand whole: nothing types itself in")
  assert.equal(steady?.colour, writing.colour, "and the line holds the colour it works in")
  pass(`the footer names "Writing…" beside a loader, in ${writing.colour}`)

  await until(
    async () => ((await lastReply(chatId))?.status === "done" ? true : null),
    30_000,
    "the reply to finish",
  )
  await settled(page)
  assert.equal(
    await page.getByRole("button", { name: "Stop" }).count(),
    0,
    "no run is left on the chat",
  )
  // The answer types itself out after the turn ends, and its stats are drawn once it has.
  await item
    .getByText(/\d+ tokens/)
    .first()
    .waitFor({ timeout: 15_000 })
  await uncapped("with the turn answered")
  await shot("answered")
  pass(`the answer leaves the row reading ${labels[0]}, the words shut in the sheet`)

  meets(await threadState(), "with the turn answered")
  pass("the row and its group draw as one block on the reply's edge, its words apart from it")

  // The words are read back in the sheet, and the thread goes on holding none of them: the spans
  // are the ones this device wrote onto the reply's own runs, and nothing was remembered about the
  // sheet that visit opened — the next load is shut again.
  const fromSheet = await open(0, "the row, answered")
  assert.ok(fromSheet.sheet.text.includes(ROTATIONS), "with the first stretch still in the row")
  assert.ok(fromSheet.sheet.text.includes(ACCOUNTING), "and the second one beside it")
  assert.deepEqual(
    fromSheet.order.map((one) => one.kind),
    ["thinking", "tool"],
    "the row is drawn above its group, as it was live",
  )
  await shut()
  await page.reload()
  const restored = await until(
    async () => {
      const state = await threadState()
      return state.rows.length === 1 ? state : null
    },
    20_000,
    "the reloaded thread's row",
  )
  assert.deepEqual(
    restored.rows.map((one) => one.label),
    labels,
    "a reload on the device that watched keeps the span, on the row it was measured for",
  )
  assert.ok(
    restored.rows.every((one) => one.expanded === "false"),
    "with the row shut again, nothing remembered",
  )
  assert.equal(restored.sheet, null, "and no sheet drawn")
  await inThread(ROTATIONS, "after the reload")
  await shot("restored")
  pass(`a reload reads the same row in the same place, still saying ${labels[0]}`)

  // A second turn, asked to think at length: one run, ten paragraphs of markdown, far taller than
  // the share of the screen the cap used to hold. The height is geometry — no lower tier has it —
  // and it is a phone's sheet this turn plays on: at a desktop's full-height drawer this run fits
  // without scrolling, and a follow with no scroll to do proves nothing.
  await page.setViewportSize({ width: 390, height: 844 })
  await send("think at length, then stall: what is eating /var/log?")
  await until(
    async () => {
      const reply = await lastReply(chatId)
      if (reply?.status !== "streaming" || reply.runs.length !== 1) return null
      return !reply.content && reply.runs[0].text.includes(LONG_FIRST) ? reply : null
    },
    30_000,
    "the long working-out to start landing",
  )
  const opening = await until(
    async () => {
      const state = await threadState()
      return state.rows.length === 1 && state.rows[0].label === "Thinking…" ? state : null
    },
    10_000,
    "the long run's row",
  )
  assert.equal(opening.rows[0].spins, true, "whose spinner turns while its run streams")
  await inThread(LONG_FIRST, "with a long run streaming")
  await uncapped("with a long run streaming")

  // The sheet over the long run follows its end as paragraphs arrive — the follow the open row used
  // to do in the thread, now bounded by the sheet's own body.
  await open(0, "the long run")
  // The wait is for the run to outgrow the cap's share of the screen inside the sheet, with the
  // sheet at its end — a body still short leaves the sheet with nothing to scroll, which is not
  // the following this leg is about.
  const followed = await until(
    async () => {
      const state = await threadState()
      return tall(state) && foot(state) <= 8 ? state : null
    },
    20_000,
    "the sheet to overflow behind the long run and follow its end",
  )
  whole(followed, "the open sheet")
  const beforePiece = (await lastReply(chatId)).runs[0].text.length
  const grown = await until(
    async () => {
      const reply = await lastReply(chatId)
      if (!reply || reply.runs[0].text.length <= beforePiece) return null
      const state = await threadState()
      return state.sheet && foot(state) <= 8 ? state : null
    },
    20_000,
    "another paragraph to land and stay in view",
  )
  assert.ok(
    foot(grown) <= 2,
    "the paragraph that just landed is in view, not scrolled off below the sheet",
  )
  await shot("growing")
  pass("new words land in view while the open sheet follows the run's end")

  // A reader scrolling the sheet up leaves that follow behind: it stays where their wheel put it
  // while the run keeps talking. The wheel is the reader's own input, which is what the row listens
  // for — against the sheet's own scroll box, not the thread's. The body has to overflow the sheet
  // with the sheet at its end, which is only the follow holding it there, and far enough up for the
  // wheel to have somewhere to go.
  await until(
    async () => {
      const state = await threadState()
      return state.sheet &&
        state.sheet.scroll.total - state.sheet.scroll.height > 72 &&
        foot(state) <= 8
        ? true
        : null
    },
    20_000,
    "the follow to hold an overflowing body's end in the sheet",
  )
  const spot = await page.evaluate((sel) => {
    const view = document.querySelector(sel)
    const box = view.getBoundingClientRect()
    return {
      x: Math.round(box.left + box.width / 2),
      y: Math.round(box.top + box.height / 2),
      top: view.scrollTop,
    }
  }, SHEET)
  await page.mouse.move(spot.x, spot.y)
  await page.mouse.wheel(0, -260)
  await rested(SHEET)
  const put = await page.evaluate((sel) => document.querySelector(sel).scrollTop, SHEET)
  assert.ok(put < spot.top - 40, `the wheel scrolled the sheet up (${Math.round(put)}px)`)
  const beforeScrollPiece = (await lastReply(chatId)).runs[0].text.length
  // Another paragraph is the run still talking after the reader put the sheet where they wanted it:
  // the wait is for those words to really land, so the sheet staying put proves the follow stopped
  // against words arriving — not against the run having quietly ended.
  const stayed = await until(
    async () => {
      const reply = await lastReply(chatId)
      if (!reply || reply.runs[0].text.length <= beforeScrollPiece) return null
      return threadState()
    },
    20_000,
    "another paragraph after the reader scrolled the sheet up",
  )
  assert.ok(
    Math.abs(stayed.sheet.scroll.top - put) <= 2,
    `the sheet stayed where the reader put it (${stayed.sheet.scroll.top}px of ${Math.round(put)}px)`,
  )
  assert.ok(foot(stayed) > 8, "with the run's end no longer chased below the sheet's fold")
  await shot("stopped")
  pass("a scroll up stops the follow: the sheet holds still while the run keeps talking")

  // The answer begins with the sheet still up — it never closes itself — and the label beside it
  // takes the span the moment its run is written down.
  await until(
    async () => ((await lastReply(chatId))?.content ? true : null),
    30_000,
    "the reply's first answer token",
  )
  const kept = await until(
    async () => {
      const state = await threadState()
      return state.sheet && SPAN.test(state.rows[0].label ?? "") ? state : null
    },
    10_000,
    "the label beside the open sheet to read the span",
  )
  assert.equal(kept.rows[0].expanded, "true", "the row still stands open over its sheet")
  assert.ok(kept.sheet.text.includes(LONG_LAST), "the sheet still holds the run's last words")
  whole(kept, "the sheet as its row's label changed")
  // The span this run's row reads is the one stamped when the run ended, at the answer: read it
  // back after, the way the row does.
  const span = thinkingLabel({ thinking: false, spanMs: (await lastReply(chatId)).runs[0].spanMs })
  await until(
    async () => ((await lastReply(chatId))?.status === "done" ? true : null),
    30_000,
    "the reply to finish",
  )
  await settled(page)
  const atEnd = await threadState()
  assert.equal(atEnd.rows[0].label, span, `the label reads \"${span}\" beside the still-open sheet`)
  await uncapped("with the finished run's sheet still open")
  await shot("kept-open")
  pass("the answer never closes the sheet: its label just takes the span while it stays up")
  await shut()

  // A body's height is a height against a real viewport, so the whole run is proved in the sheet at
  // a phone's width and a tablet's, in both themes — the four plates the change is reviewed on.
  for (const [width, height] of [
    [390, 844],
    [1024, 1112],
  ]) {
    await page.setViewportSize({ width, height })
    await page.emulateMedia({ colorScheme: "light" })
    await page.reload()
    // The bound is a share of the viewport, so the viewport the sheet is measured in has to be the
    // one asked for.
    assert.deepEqual(
      await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })),
      { width, height },
      `the page is drawn at ${width}×${height}`,
    )
    await until(
      async () => ((await threadState()).rows.length === 1 ? true : null),
      20_000,
      `the long run's row at ${width}×${height}`,
    )
    for (const theme of ["light", "dark"]) {
      const where = `at ${width}px in the ${theme}`
      await page.emulateMedia({ colorScheme: theme })
      await until(
        async () =>
          (await page.evaluate(() => document.documentElement.classList.contains("dark"))) ===
          (theme === "dark")
            ? true
            : null,
        10_000,
        `the app to draw its ${theme} theme ${where}`,
      )
      standing(await threadState(), where)
      const at = await open(0, `the finished run ${where}`)
      assert.ok(at.sheet.text.includes(LONG_LAST), `${where}, the sheet holds the run's last words`)
      whole(at, where)
      await uncapped(`the open sheet ${where}`)
      await shot(`uncapped-${width}-${theme}`)
      await shut()
    }
  }
  await page.emulateMedia({ colorScheme: "light" })
  pass(
    "the sheet draws the whole run at 390px and at 1024px, in light and in dark, with no cap, fade or Show more anywhere",
  )
})
