// One turn on the mock, told to stall so its reasoning is the only thing on the wire for a while: the
// only way a poll can look at a thread mid-thought. Two calls run back to back in it, so the reply
// draws the thinking before them above one tool group and the two stretches that follow as one row
// under it — the merge, the open latch, the fold and the uncapped body are all layout, which no lower
// tier reaches.
import { assert, app, flow, pass, settled } from "./lib.mjs"

/** One reply's own row in the thread: the header and the toaster say plenty this flow must not read. */
const ITEM = "[data-slot=message-scroller-item]"
const WORKING = '[aria-live="polite"]'
const THINKING = /^(Thinking…|Thought it through|Thought for \d+[sm])/
const LINE = THINKING
const SPAN = /^Thought for \d+s$/
/** The share of the screen the old cap held: an uncapped row has to be taller than it. */
const CAP_SHARE = 0.3
const FIRST = "working-out, not just the answer"
const MEASURED = "The first look says five gigabytes"
const ROTATIONS = "gzipped rotations are the bulk of it"
const ACCOUNTING = "The journal's own accounting agrees"
const LAST = "leaves the delete to them"
const LONG_FIRST = "the reasoning itself, so here is the whole of it"
const LONG_LAST = "The deleting is theirs"

/** A span as a row reads it — `thinkingLabel`'s own format, from `app/src/lib/thinking.ts`. */
const thoughts = (ms) => {
  const seconds = Math.max(1, Math.round(ms / 1000))
  return `Thought for ${seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`}`
}

await flow("thinking-line", async ({ page, send, lastReply, until, shot }) => {
  await page.goto(app)
  await send("think out loud, then stall: where did the space under /var/log go?")
  await page.waitForURL("**/c/**", { timeout: 15_000 })
  const chatId = new URL(page.url()).pathname.split("/").at(-1)
  const item = page.locator(ITEM).last()
  const line = item.getByRole("button", { name: LINE })
  // The text a row folds is named by aria-controls, whose id is React's and so not a selector.
  const body = (controls) =>
    page.evaluate((id) => {
      const found = document.getElementById(id)
      return {
        text: found?.textContent ?? "",
        hidden: found?.getAttribute("aria-hidden") ?? null,
        inert: found?.hasAttribute("inert") ?? false,
      }
    }, controls)

  // Everything the reply draws that only the browser has: each row's label and the words it holds,
  // whether that body is in the tree and the tab order, the box it takes, where the reply's tool
  // group sits among the rows, and whether a cap, a fade or a Show more survives anywhere in it.
  const thread = () =>
    page.evaluate(
      ({ item, label }) => {
        const names = new RegExp(label)
        const own = [...document.querySelectorAll(item)].at(-1)
        const buttons = [...(own?.querySelectorAll("button") ?? [])]
        const lines = [...(own?.querySelectorAll("[data-slot=thinking-line]") ?? [])]
        const view = document.querySelector("[data-slot=message-scroller-viewport]")
        const box = (node) => {
          if (!node) return null
          const rect = node.getBoundingClientRect()
          return {
            top: Math.round(rect.top),
            bottom: Math.round(rect.bottom),
            height: Math.round(rect.height),
          }
        }
        const rows = lines.map((drawn) => {
          const control = drawn.querySelector("button")
          const node = document.getElementById(control?.getAttribute("aria-controls") ?? "")
          return {
            label: control?.textContent?.trim() ?? null,
            expanded: control?.getAttribute("aria-expanded") ?? null,
            hidden: node?.getAttribute("aria-hidden") ?? null,
            inert: node?.hasAttribute("inert") ?? false,
            text: node?.textContent ?? "",
            box: box(node),
            drawn: node ? { height: node.scrollHeight, client: node.clientHeight } : null,
          }
        })
        return {
          rows,
          // The reply's drawn things in the order they are drawn: a thinking row is a button whose
          // text is its label, and the calls that touch draw as one button of their own.
          order: buttons.map((one) => {
            const text = one.textContent?.trim() ?? ""
            return names.test(text) ? { kind: "thinking", text } : { kind: "tool", text }
          }),
          group: own?.querySelector("[data-slot=tool-group]")?.getAttribute("aria-label") ?? null,
          groups: own?.querySelectorAll("[data-slot=tool-group]").length ?? 0,
          cap: own?.querySelectorAll("[data-slot=thinking-cap]").length ?? 0,
          fade: own?.querySelectorAll("[data-slot=thinking-fade]").length ?? 0,
          frame: box(view),
          scroll: view && { top: view.scrollTop, height: view.clientHeight, total: view.scrollHeight },
          screen: { width: window.innerWidth, height: window.innerHeight },
        }
      },
      { item: ITEM, label: THINKING.source },
    )

  // The cap, the fade and the control it sat behind are gone from the app: nothing may draw any of
  // them, at any width, whatever a row is doing.
  const uncapped = async (where) => {
    const state = await thread()
    assert.equal(state.cap, 0, `${where} draws no thinking cap`)
    assert.equal(state.fade, 0, `${where} draws no fade at one`)
    assert.equal(
      await page.getByRole("button", { name: "Show more" }).count(),
      0,
      `${where} offers no Show more control anywhere on the page`,
    )
    return state
  }

  // A smooth scroll into place is not an animation `settled` waits for, so a reading taken straight
  // after a row opens can catch the thread mid-move: wait for its scroll to come to rest first.
  const rested = async () => {
    let last = -1
    try {
      await until(
        async () => {
          const top = await page.evaluate(
            () => document.querySelector("[data-slot=message-scroller-viewport]").scrollTop,
          )
          const still = top === last
          last = top
          return still
        },
        5_000,
        "the thread to stop moving",
      )
    } catch {}
    await settled(page)
  }

  // The turn's own pause and lead-in: nothing has arrived, so the thread says it is writing. The row
  // and the reply's own box are read in one go, so the state can't move between the two.
  const beforeReasoning = await until(
    () =>
      page.evaluate(
        async ({ id, item, working, label }) => {
          const { db } = await import("/src/lib/db.ts")
          const last = (
            await db.messages.where("conversationId").equals(id).sortBy("createdAt")
          ).at(-1)
          if (last?.role !== "assistant" || last.status !== "streaming") return null
          if (last.reasoningRuns?.length || last.content) return null
          const own = [...document.querySelectorAll(item)].at(-1)
          const says = own?.querySelector(working)?.textContent ?? ""
          const names = new RegExp(label)
          const drawn = [...(own?.querySelectorAll("button") ?? [])].filter((one) =>
            names.test(one.textContent?.trim() ?? ""),
          )
          return says ? { says, lines: drawn.length } : null
        },
        { id: chatId, item: ITEM, working: WORKING, label: LINE.source },
      ),
    20_000,
    "the reply to be up with nothing said yet and its working line showing",
  )
  assert.match(beforeReasoning.says, /Writing…/, "the working line says what it is doing")
  assert.equal(beforeReasoning.lines, 0, "with no thinking row for a turn that hasn't thought yet")
  await shot("working")
  pass("the working line reads Writing… before the turn's first thinking, with no thinking row yet")

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
  await until(
    async () => ((await item.textContent())?.includes(FIRST) ? true : null),
    5_000,
    "the thinking to reach the thread",
  )
  const streaming = await thread()
  assert.equal(streaming.rows.length, 1, "one stretch of thinking draws one row")
  assert.equal(streaming.rows[0].label, "Thinking…", "which says it is thinking")
  assert.equal(streaming.rows[0].expanded, "true", "and stands open")
  assert.ok(
    streaming.rows[0].text.includes(FIRST),
    "its body readable, holding the piece that landed",
  )
  await uncapped("while the turn is thinking")
  assert.equal(
    await item.locator(WORKING).count(),
    0,
    "the working line has stood down while the thinking streams",
  )
  assert.doesNotMatch(
    (await item.textContent()) ?? "",
    /Writing…/,
    "and nothing in the reply still says it is writing",
  )
  await shot("thinking")
  pass("mid-thought the row stands open reading Thinking…, the working line gone from the reply")

  // A call ends that stretch. The row it measured keeps its span and stays open — the turn still
  // works, so nothing folds until the answer begins.
  const latched = await until(
    async () => {
      const reply = await lastReply(chatId)
      if (reply?.status !== "streaming" || reply.runs.length !== 2 || reply.content) return null
      return reply.runs[1].text.includes(MEASURED) && reply.runs[0].spanMs !== null ? thread() : null
    },
    30_000,
    "the first call to land with the thinking after it streaming",
  )
  assert.equal(latched.rows.length, 2, "the call splits the thinking into a second row")
  assert.match(
    latched.rows[0].label ?? "",
    SPAN,
    `the row the call ended reads the span it measured (${latched.rows[0].label})`,
  )
  assert.equal(
    latched.rows[0].expanded,
    "true",
    "and stays open: the turn still works, so the row that streamed keeps its place",
  )
  assert.ok(latched.rows[0].text.includes(FIRST), "with its own words still there to read")
  assert.equal(latched.rows[1].label, "Thinking…", "the stretch after the call is thinking")
  assert.equal(latched.rows[1].expanded, "true", "and open as its words arrive")
  assert.ok(latched.rows[1].text.includes(MEASURED), "holding the first thing it says")
  assert.deepEqual(
    latched.order.map((one) => one.kind),
    ["thinking", "tool", "thinking"],
    "the thinking before the call is drawn above it, and the thinking it broke below",
  )
  await shot("latched")
  pass(
    `the run a call ended stays open reading "${latched.rows[0].label}" while the next one streams`,
  )

  // A second call, straight after the first with nothing said between them: the two draw as ONE tool
  // group, and the stretch that follows each of them lands beside the other under it — two rows that
  // touch, drawn as one row holding every word of both.
  const merged = await until(
    async () => {
      const reply = await lastReply(chatId)
      if (reply?.status !== "streaming" || reply.runs.length !== 3 || reply.content) return null
      return reply.runs[2].text.includes(ACCOUNTING) ? thread() : null
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
  assert.equal(merged.rows.length, 2, "the two stretches that touched draw as one row")
  assert.equal(
    merged.rows[1].label,
    "Thinking…",
    "which says it is thinking while its newest stretch streams",
  )
  assert.equal(merged.rows[1].expanded, "true", "and stands open over both of them")
  const first = merged.rows[1].text.indexOf(ROTATIONS)
  const then = merged.rows[1].text.indexOf(ACCOUNTING)
  assert.ok(first >= 0, "holding the stretch the first call broke")
  assert.ok(then >= 0, "and the one the second call broke")
  assert.ok(first < then, "in the order they arrived")
  assert.equal(merged.rows[1].text.split(ROTATIONS).length - 1, 1, "each stretch once, not once a row")
  assert.deepEqual(
    merged.order.map((one) => one.kind),
    ["thinking", "tool", "thinking"],
    "the run before any call above the group, and the two that touched as one row below it",
  )
  assert.equal(
    merged.rows[0].expanded,
    "true",
    "the row above the group is still open, its run long ended",
  )
  await shot("merged")
  pass(
    "two calls back to back draw as one tool group, with the thinking before them above it and the two stretches that follow as one row below",
  )

  // The last piece, the turn still holding: nothing has folded, and nothing may.
  const holding = await until(
    async () => {
      const reply = await lastReply(chatId)
      if (!reply || reply.content || !reply.runs.at(-1)?.text.includes(LAST)) return null
      const state = await thread()
      return state.rows.length === 2 && state.rows.every((one) => one.expanded === "true")
        ? state
        : null
    },
    20_000,
    "the turn's last thinking piece to land with both of its rows still open",
  )
  pass(
    `the turn thinks to its last piece with both of its ${holding.rows.length} rows still open, and no answer yet`,
  )

  await until(
    async () => ((await lastReply(chatId))?.content ? true : null),
    30_000,
    "the reply's first answer token",
  )
  const folded = await until(
    async () => {
      const state = await thread()
      return state.rows.length === 2 && state.rows.every((one) => one.expanded === "false")
        ? state
        : null
    },
    5_000,
    "both rows to fold",
  )
  // What each row may read now that its spans are frozen: the run above the group its own span, and
  // the merged row the sum of the two it holds — never the part of it this device measured for one.
  const measured = await lastReply(chatId)
  const spans = measured.runs.map((run) => run.spanMs)
  assert.equal(spans.length, 3, "the reply keeps three stretches of thinking")
  assert.ok(
    spans.every((one) => typeof one === "number"),
    "every one of them measured on this device, watching it arrive",
  )
  const labels = [thoughts(spans[0]), thoughts(spans[1] + spans[2])]
  assert.deepEqual(
    folded.rows.map((one) => one.label),
    labels,
    "the answer folds both rows together, each reading the span truth for what it holds",
  )
  assert.match(folded.rows[1].label ?? "", SPAN, "the merged row reads a span, not a plain phrase")
  assert.notEqual(
    folded.rows[1].label,
    thoughts(spans[1]),
    "and reads the two spans added, not the first of them",
  )
  assert.notEqual(folded.rows[1].label, thoughts(spans[2]), "nor the second alone")
  for (const index of [0, 1]) {
    const closed = await body(await line.nth(index).getAttribute("aria-controls"))
    assert.equal(closed.hidden, "true", `row ${index + 1}'s thinking leaves the tree`)
    assert.equal(closed.inert, true, `row ${index + 1}'s thinking leaves the tab order too`)
  }

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
  await uncapped("with the turn folded at its answer")
  await shot("folded")
  pass(`the answer folds both rows, reading "${labels.join('", "')}"`)

  // A row drawn from storage starts closed: the visit's latch was never written down, and the spans
  // it reads are the ones this device wrote onto the reply's own runs.
  await page.reload()
  const restored = await until(
    async () => {
      const state = await thread()
      return state.rows.length === 2 ? state : null
    },
    20_000,
    "the reloaded thread's two rows",
  )
  assert.deepEqual(
    restored.rows.map((one) => one.label),
    labels,
    "a reload on the device that watched keeps both spans, on the rows they were measured for",
  )
  for (const index of [0, 1]) {
    assert.equal(restored.rows[index].expanded, "false", "folded")
    const closed = await body(await line.nth(index).getAttribute("aria-controls"))
    assert.equal(closed.hidden, "true", "its body folded away")
    assert.equal(closed.inert, true, "and kept out of the tab order")
  }
  assert.ok(restored.rows[1].text.includes(ROTATIONS), "with the first stretch still in the row")
  assert.ok(restored.rows[1].text.includes(ACCOUNTING), "and the second one beside it")
  assert.deepEqual(
    restored.order.map((one) => one.kind),
    ["thinking", "tool", "thinking"],
    "the rows are drawn in the same places as they were live",
  )
  await shot("restored")
  pass(`a reload reads the same two rows in the same places, still saying "${labels.join('", "')}"`)

  // A second turn, asked to think at length: one run, eight paragraphs of markdown, far taller than
  // the share of the screen the cap used to hold. The height is geometry — no lower tier has it.
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
  await until(
    async () => ((await item.textContent())?.includes(LONG_FIRST) ? true : null),
    5_000,
    "the long working-out to reach the thread",
  )
  const opening = await thread()
  assert.equal(opening.rows.length, 1, "one run draws one row")
  assert.equal(opening.rows[0].expanded, "true", "the row is open, as its run streams")
  assert.equal(opening.rows[0].label, "Thinking…", "and says it is thinking")
  await uncapped("with a long run streaming")

  const foot = (state) =>
    state.scroll ? state.scroll.total - state.scroll.top - state.scroll.height : Infinity
  const followed = await until(
    async () => {
      const state = await thread()
      if (!state.scroll || state.scroll.total <= state.scroll.height + 8) return null
      return foot(state) <= 8 ? state : null
    },
    20_000,
    "the thread to overflow behind the long run and follow its end",
  )
  assert.ok(
    followed.rows[0].box.bottom <= followed.frame.bottom + 2,
    `the run's own end is in view (${followed.rows[0].box.bottom}px of ${followed.frame.bottom}px)`,
  )
  const beforePiece = (await lastReply(chatId)).runs[0].text.length
  const grown = await until(
    async () => {
      const reply = await lastReply(chatId)
      if (!reply || reply.runs[0].text.length <= beforePiece) return null
      const state = await thread()
      return foot(state) <= 8 ? state : null
    },
    20_000,
    "another paragraph to land and stay in view",
  )
  assert.ok(
    grown.rows[0].box.bottom <= grown.frame.bottom + 2,
    "the paragraph that just landed is in view, not scrolled off below",
  )
  await shot("growing")
  pass("new words land in view while the open run streams, the thread following its end")

  // A reader scrolling up leaves that follow behind: the thread stays where their wheel put it while
  // the run keeps talking. The wheel is the reader's own input, which is what the row listens for.
  const middle = await page.evaluate(() => {
    const box = document
      .querySelector("[data-slot=message-scroller-viewport]")
      .getBoundingClientRect()
    return {
      x: Math.round(box.left + box.width / 2),
      y: Math.round(box.top + box.height / 2),
      top: document.querySelector("[data-slot=message-scroller-viewport]").scrollTop,
    }
  })
  await page.mouse.move(middle.x, middle.y)
  await page.mouse.wheel(0, -260)
  await rested()
  const put = await page.evaluate(
    () => document.querySelector("[data-slot=message-scroller-viewport]").scrollTop,
  )
  assert.ok(put < middle.top - 40, `the wheel scrolled the thread up (${Math.round(put)}px)`)
  const beforeScrollPiece = (await lastReply(chatId)).runs[0].text.length
  const stayed = await until(
    async () => {
      const reply = await lastReply(chatId)
      if (!reply || reply.runs[0].text.length <= beforeScrollPiece) return null
      return thread()
    },
    20_000,
    "another paragraph after the reader scrolled up",
  )
  assert.ok(
    Math.abs(stayed.scroll.top - put) <= 2,
    `the thread stayed where the reader put it (${stayed.scroll.top}px of ${Math.round(put)}px)`,
  )
  assert.ok(
    stayed.rows[0].box.bottom > stayed.frame.bottom,
    "with the run's end no longer chased below the fold",
  )
  pass("a scroll up stops the follow: the thread holds still while the run keeps talking")

  // The answer begins: the row folds, and a tap opens it again on a finished run. That is the state
  // the uncapped body is proved in — the whole of its markdown, however many screens it runs past.
  await until(
    async () => ((await lastReply(chatId))?.content ? true : null),
    30_000,
    "the reply's first answer token",
  )
  await until(
    async () => ((await thread()).rows[0]?.expanded === "false" ? true : null),
    5_000,
    "the long row to fold",
  )
  await until(
    async () => ((await lastReply(chatId))?.status === "done" ? true : null),
    30_000,
    "the reply to finish",
  )
  await settled(page)
  await page.evaluate(() => {
    document.querySelector("[data-slot=message-scroller-viewport]").scrollTop = 0
  })
  await settled(page)
  await line.click()
  await until(
    async () => ((await thread()).rows[0]?.expanded === "true" ? true : null),
    5_000,
    "the row to open",
  )
  await rested()
  const opened = await uncapped("with the finished run open")
  const whole = opened.rows[0]
  const share = Math.ceil(opened.screen.height * CAP_SHARE)
  assert.ok(
    whole.box.height > share,
    `an open row draws its whole body, past the ${share}px a screen's 30% holds it to (${whole.box.height}px)`,
  )
  assert.ok(
    whole.drawn.height <= whole.drawn.client + 1,
    `with nothing clipped out of it (${whole.drawn.height}px of ${whole.drawn.client}px)`,
  )
  assert.ok(
    (await page.getByText(LONG_LAST).count()) > 0,
    "its last words on the page, the run's final paragraph drawn in full",
  )
  assert.ok(
    whole.box.bottom <= opened.frame.bottom + 2,
    `the run's whole end is in view (${whole.box.bottom}px of ${opened.frame.bottom}px)`,
  )
  assert.ok(
    whole.box.bottom > opened.frame.top + (opened.frame.bottom - opened.frame.top) / 2,
    "in the lower half of the thread, the tap landing on the row's end",
  )
  assert.ok(opened.scroll.top > 0, `the thread moved down to it (${opened.scroll.top}px)`)
  await shot("opened")
  pass(
    `opening the finished run landed the thread on its end (scrollTop ${opened.scroll.top}px), its whole ${whole.box.height}px body drawn with no cap, fade or Show more`,
  )

  // An uncapped body is a height against a real viewport, so it is proved at a phone's width and a
  // tablet's, in both themes — the four plates the change is reviewed on.
  const plates = []
  for (const [width, height] of [
    [390, 844],
    [1024, 1112],
  ]) {
    for (const dark of [false, true]) {
      const theme = dark ? "dark" : "light"
      const where = `at ${width}px in the ${theme}`
      await page.setViewportSize({ width, height })
      await page.emulateMedia({ colorScheme: theme })
      await page.reload()
      await until(
        async () => ((await thread()).rows.length === 1 ? true : null),
        20_000,
        `the long row ${where}`,
      )
      await until(
        async () =>
          (await page.evaluate(() => document.documentElement.classList.contains("dark"))) === dark
            ? true
            : null,
        10_000,
        `the app to draw its ${theme} theme ${where}`,
      )
      await line.click()
      await until(
        async () => ((await thread()).rows[0]?.expanded === "true" ? true : null),
        10_000,
        `the row to open ${where}`,
      )
      await rested()
      const at = await uncapped(`the open row ${where}`)
      const row = at.rows[0]
      const cap = Math.ceil(height * CAP_SHARE)
      assert.ok(
        row.box.height > cap,
        `${where} the open row's body is taller than the ${cap}px the old cap held (${row.box.height}px)`,
      )
      assert.ok(
        row.drawn.height <= row.drawn.client + 1,
        `${where} nothing of it is clipped (${row.drawn.height}px of ${row.drawn.client}px)`,
      )
      assert.ok((await page.getByText(LONG_LAST).count()) > 0, `${where} its last words are drawn`)
      assert.ok(
        row.box.bottom <= at.frame.bottom + 2 && row.box.bottom > at.frame.top,
        `${where} and its end sits in the thread's view (${row.box.bottom}px in ${at.frame.top}-${at.frame.bottom}px)`,
      )
      const path = await shot(`uncapped-${width}-${theme}`)
      plates.push({ width, theme, height: row.box.height, cap, path })
    }
  }
  await page.emulateMedia({ colorScheme: "light" })
  pass(
    `the open row is uncapped at 390px (${plates[0].height}px past the old ${plates[0].cap}px cap) and 1024px (${plates[2].height}px past ${plates[2].cap}px), in light and in dark`,
  )
})
