// One turn on the mock, told to stall so its reasoning is the only thing on the wire for a while: the
// only way a poll can look at a thread mid-thought. The mock breaks that reasoning with a tool call
// between its second and third pieces, so the turn is two runs — one drawn above the call, one below.
// A second turn is asked to think at length: one long run, taller than a row is drawn, so the thread
// has to cap it behind a fade and a Show more and keep its reader on the newest words.
import { assert, app, flow, pass, settled } from "./lib.mjs"

/** One reply's own row in the thread: the header and the toaster say plenty this flow must not read. */
const ITEM = "[data-slot=message-scroller-item]"
const WORKING = '[aria-live="polite"]'
const LINE = /^(Thought|Thinking…)/
const SPAN = /^Thought for \d+s$/
const FIRST = "working-out, not just the answer"
const ROTATIONS = "gzipped rotations are the bulk of it"
const LAST = "leaves the delete to them"
// A second turn, asked to think at length: one run of eight paragraphs, taller than a row is drawn.
const LONG_FIRST = "the reasoning itself, so here is the whole of it"
const LONG_LAST = "The deleting is theirs"

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
      return { text: found?.textContent ?? "", hidden: found?.getAttribute("aria-hidden") ?? null }
    }, controls)
  // What the reply's own turn draws, top to bottom: its thinking rows and the calls between them.
  const order = () =>
    page.evaluate(
      ({ item }) => {
        const own = [...document.querySelectorAll(item)].at(-1)
        return [...(own?.querySelectorAll("button") ?? [])].map((one) => {
          const text = one.textContent?.trim() ?? ""
          const thinking = text === "Thinking…" || /^Thought (it through|for \d)/.test(text)
          return thinking ? { kind: "thinking", text } : { kind: "tool", text }
        })
      },
      { item: ITEM },
    )

  // Everything a row draws that only layout can tell: the box its words are capped to against the
  // screen, the fade at that edge, the control under it, and where the row's end sits in the thread.
  const row = () =>
    page.evaluate(() => {
      const own = [...document.querySelectorAll("[data-slot=message-scroller-item]")].at(-1)
      const buttons = [...(own?.querySelectorAll("button") ?? [])]
      const line = buttons.find((one) =>
        /^(Thinking…|Thought it through|Thought for )/.test(one.textContent?.trim() ?? ""),
      )
      const more = buttons.find((one) => one.textContent?.trim() === "Show more")
      const body = own?.querySelector("[data-slot=thinking-body]")
      const cap = own?.querySelector("[data-slot=thinking-cap]")
      const fade = own?.querySelector("[data-slot=thinking-fade]")
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
      const probe = document.createElement("span")
      probe.className = "bg-background"
      document.body.append(probe)
      const background = getComputedStyle(probe).backgroundColor
      probe.remove()
      return {
        label: line?.textContent?.trim() ?? null,
        expanded: line?.getAttribute("aria-expanded") ?? null,
        body: box(body),
        cap: cap && {
          ...box(cap),
          scroll: cap.scrollHeight,
          client: cap.clientHeight,
          capped: /max-h-/.test(cap.className),
        },
        fade: fade && {
          image: getComputedStyle(fade).backgroundImage,
          pointer: getComputedStyle(fade).pointerEvents,
        },
        more: box(more),
        frame: box(view),
        scroll: view && { top: view.scrollTop, height: view.clientHeight, total: view.scrollHeight },
        screen: { width: window.innerWidth, height: window.innerHeight },
        background,
      }
    })

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

  // The first piece in with the rest still to come, and nothing said: a single block would have put
  // the whole working-out on the row at once, which is what the mock is told not to do.
  await until(
    async () => {
      const row = await lastReply(chatId)
      if (row?.status !== "streaming" || !row.runs.length) return null
      const text = row.runs.map((run) => run.text).join("\n")
      return !row.content && text.includes(FIRST) && !text.includes(ROTATIONS) ? row : null
    },
    30_000,
    "the turn's first thinking to land, with more of it still to come",
  )
  await until(
    async () => ((await item.textContent())?.includes(FIRST) ? true : null),
    5_000,
    "the thinking to reach the thread",
  )
  assert.equal(await line.count(), 1, "one stretch of thinking draws one row")
  assert.equal((await line.nth(0).textContent())?.trim(), "Thinking…", "which says it is thinking")
  assert.equal(await line.nth(0).getAttribute("aria-expanded"), "true", "and stands open")
  const midThought = await body(await line.nth(0).getAttribute("aria-controls"))
  assert.ok(midThought.text.includes(FIRST), "its body readable, holding the piece that landed")
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

  // The call lands between the pieces: the run before it is measured and drawn above it, and the
  // thinking that follows opens a second row below it — one row per stretch of thinking, in place.
  await until(
    async () => {
      const row = await lastReply(chatId)
      if (row?.status !== "streaming" || row.runs.length < 2) return null
      return row.runs[1].text.includes(ROTATIONS) && !row.content ? row : null
    },
    30_000,
    "the thinking after the turn's call to land",
  )
  await until(
    async () => {
      const rows = await order()
      return rows.filter((one) => one.kind === "thinking").length === 2 ? rows : null
    },
    5_000,
    "both thinking rows in the thread",
  )
  assert.equal(await line.count(), 2, "two stretches of thinking, two rows")
  assert.match(
    (await line.nth(0).textContent())?.trim() ?? "",
    SPAN,
    "the run the call ended reads the span this device watched",
  )
  assert.equal(await line.nth(0).getAttribute("aria-expanded"), "false", "and folded, once ended")
  assert.equal((await line.nth(1).textContent())?.trim(), "Thinking…", "the run after it is thinking")
  assert.equal(await line.nth(1).getAttribute("aria-expanded"), "true", "so it stands open")
  assert.ok(
    (await body(await line.nth(1).getAttribute("aria-controls"))).text.includes(ROTATIONS),
    "holding the piece that landed after the call",
  )
  const drawn = await order()
  assert.equal(drawn.length, 3, "the reply draws two thinking rows and the call between them")
  assert.equal(drawn[0].kind, "thinking", "the thinking before the call is drawn first")
  assert.equal(drawn[1].kind, "tool", "then the call it precedes")
  assert.equal(drawn[2].kind, "thinking", "and the thinking the call broke is drawn below it")
  await shot("two-runs")
  pass("a call mid-thought draws the thinking before it above the call and the thinking after below")

  // The mock's last piece, then its hold: the second row still open over all of it, nothing begun.
  await until(
    async () => {
      const row = await lastReply(chatId)
      return row?.runs.at(-1)?.text.includes(LAST) && !row.content ? row : null
    },
    20_000,
    "the last thinking piece to land before any answer",
  )
  assert.equal(await line.nth(1).getAttribute("aria-expanded"), "true", "the row is still open over it")
  await settled(page)
  pass("the row streams open through the turn's last piece and its hold, with no answer yet")

  // The first answer token folds both: each run measured its own span as it ended.
  await until(
    async () => ((await lastReply(chatId))?.content ? true : null),
    30_000,
    "the reply's first answer token",
  )
  await until(
    async () => ((await line.nth(1).getAttribute("aria-expanded")) === "false" ? true : null),
    5_000,
    "the rows to fold",
  )
  const labels = []
  for (const index of [0, 1]) {
    labels.push((await line.nth(index).textContent())?.trim() ?? "")
    assert.match(labels[index], SPAN, `row ${index + 1} folds over the span it watched arrive`)
    const folded = await body(await line.nth(index).getAttribute("aria-controls"))
    assert.equal(folded.hidden, "true", `row ${index + 1}'s thinking leaves the tree`)
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
  await shot("folded")
  pass(`the answer folds both rows, each reading its own span: "${labels.join('", "')}"`)

  // A reload keeps the spans this device measured, on the reply's own runs: the numbers stay, and the
  // rows stay where they were.
  await page.reload()
  await until(
    async () => ((await line.count()) === 2 ? true : null),
    20_000,
    "the reloaded thread's two rows",
  )
  const restored = [(await line.nth(0).textContent())?.trim(), (await line.nth(1).textContent())?.trim()]
  assert.deepEqual(
    restored,
    labels,
    "a reload on the device that watched keeps both spans, on the runs they were measured for",
  )
  for (const index of [0, 1]) {
    assert.equal(await line.nth(index).getAttribute("aria-expanded"), "false", "folded")
    const folded = await body(await line.nth(index).getAttribute("aria-controls"))
    assert.equal(folded.hidden, "true", "its body folded away")
  }
  assert.ok(
    (await body(await line.nth(1).getAttribute("aria-controls"))).text.includes(LAST),
    "and the thinking still there to open",
  )
  const restoredOrder = await order()
  assert.deepEqual(
    restoredOrder.map((one) => one.kind),
    ["thinking", "tool", "thinking"],
    "the runs are drawn in the same places as they were live",
  )
  await shot("restored")
  pass(`a reload reads the same two rows in the same places, still saying "${labels.join('", "')}"`)

  // A second turn, asked to think at length: one run, eight paragraphs of markdown, far taller than
  // a row is drawn. The height, the fade and the control are all geometry — no lower tier has it.
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
  const opening = await row()
  assert.equal(opening.expanded, "true", "the row is open, as its run streams")
  assert.equal(opening.more, null, "and short enough so far to read whole")

  // The words keep coming into an open row: what it has just said stays in view, at the foot of the
  // thread, until the reader goes somewhere else.
  const foot = (state) =>
    state.scroll ? state.scroll.total - state.scroll.top - state.scroll.height : Infinity
  const followed = await until(
    async () => {
      const state = await row()
      if (!state.scroll || state.scroll.total <= state.scroll.height + 8) return null
      return foot(state) <= 8 ? state : null
    },
    20_000,
    "the thread to overflow behind the long run and follow its end",
  )
  assert.ok(
    followed.body.bottom <= followed.frame.bottom + 2,
    `the run's own end is in view (${followed.body.bottom}px of ${followed.frame.bottom}px)`,
  )
  const beforePiece = (await lastReply(chatId)).runs[0].text.length
  const grown = await until(
    async () => {
      const reply = await lastReply(chatId)
      if (!reply || reply.runs[0].text.length <= beforePiece) return null
      const state = await row()
      return foot(state) <= 8 ? state : null
    },
    20_000,
    "another paragraph to land and stay in view",
  )
  assert.ok(
    grown.body.bottom <= grown.frame.bottom + 2,
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
      return row()
    },
    20_000,
    "another paragraph after the reader scrolled up",
  )
  assert.ok(
    Math.abs(stayed.scroll.top - put) <= 2,
    `the thread stayed where the reader put it (${stayed.scroll.top}px of ${Math.round(put)}px)`,
  )
  assert.ok(
    stayed.body.bottom > stayed.frame.bottom,
    "with the run's end no longer chased below the fold",
  )
  pass("a scroll up stops the follow: the thread holds still while the run keeps talking")

  // Past the cap the thread draws a screenful, a fade at that edge and a Show more under it, with the
  // rest of the run still on the row for whoever asks.
  const capped = await until(
    async () => {
      const state = await row()
      return state.more ? state : null
    },
    20_000,
    "a run taller than its cap, with a Show more on it",
  )
  const capshare = Math.ceil(capped.screen.height * 0.3)
  assert.ok(
    capped.cap.height <= capshare + 1,
    `the cap holds a screen's 30% (${capped.cap.height}px of ${capped.screen.height}px)`,
  )
  assert.ok(
    capped.cap.scroll > capped.cap.client + 4,
    `with the rest of the run past its edge (${capped.cap.scroll}px in ${capped.cap.client}px)`,
  )
  assert.match(capped.fade?.image ?? "", /gradient/, "a fade at that edge")
  assert.equal(capped.fade?.pointer, "none", "that takes no tap meant for the text")
  assert.ok(capped.more.height >= 44, `and a Show more at least 44px tall (${capped.more.height}px)`)
  // The shot is of the row itself, so bring its end into view first: the reader may have left the
  // thread anywhere by the time the cap appears.
  await page.evaluate(() => {
    const own = [...document.querySelectorAll("[data-slot=message-scroller-item]")].at(-1)
    own?.querySelector("[data-slot=thinking-body]")?.scrollIntoView({ block: "end" })
  })
  await rested()
  await shot("capped")
  pass(
    `a run past its cap draws ${capped.cap.height}px of itself, a fade and a ${capped.more.height}px Show more`,
  )

  // The answer folds it; then opening it from the top of the thread lands on its newest words.
  await until(
    async () => ((await lastReply(chatId))?.content ? true : null),
    30_000,
    "the reply's first answer token",
  )
  await until(
    async () => ((await row()).expanded === "false" ? true : null),
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
    async () => ((await row()).expanded === "true" ? true : null),
    5_000,
    "the row to open",
  )
  await rested()
  const read = await row()
  assert.ok(read.cap?.capped, "the opened row is drawn at its cap")
  assert.ok(
    read.body.bottom <= read.frame.bottom + 2,
    `the run's whole end is in view (${read.body.bottom}px of ${read.frame.bottom}px)`,
  )
  assert.ok(
    read.body.bottom > read.frame.top + (read.frame.bottom - read.frame.top) / 2,
    "in the lower half of the thread, not at the row's first line",
  )
  assert.ok(read.scroll.top > 0, `the thread moved down to it (${read.scroll.top}px)`)
  await shot("opened")
  pass(`opening the folded run landed the thread on its end (scrollTop ${read.scroll.top}px)`)

  // Show more reads the rest inline: nothing left hidden, and the control and the fade go with it.
  await page.getByRole("button", { name: "Show more" }).click()
  await settled(page)
  const whole = await row()
  assert.equal(whole.more, null, "revealing the rest drops the control")
  assert.equal(whole.fade, null, "and the fade with it")
  assert.equal(whole.cap.capped, false, "and the cap, so the run reads inline")
  assert.ok(
    whole.cap.scroll <= whole.cap.client + 1,
    `with nothing left hidden (${whole.cap.scroll}px in ${whole.cap.client}px)`,
  )
  assert.ok(
    (await page.getByText(LONG_LAST).count()) > 0,
    "the last of the working-out on the page",
  )
  await shot("revealed")
  pass("Show more reveals the rest of the run inline, the control and the fade gone with the cap")

  // The cap is the screen's own height, so it holds at a phone's width and a tablet's, and the fade
  // is a theme token, so it holds in the dark as it does in the light.
  const caps = []
  for (const [width, height] of [
    [390, 844],
    [834, 1112],
  ]) {
    await page.setViewportSize({ width, height })
    await page.reload()
    await until(
      async () => ((await line.count()) === 1 ? true : null),
      20_000,
      `the long row at ${width}px`,
    )
    await line.click()
    await until(
      async () => ((await row()).more ? true : null),
      10_000,
      `the cap at ${width}px`,
    )
    await rested()
    const at = await row()
    const share = Math.ceil(height * 0.3)
    assert.ok(
      at.cap.height <= share + 1,
      `at ${width}px the cap holds a screen's 30% (${at.cap.height}px of ${height}px)`,
    )
    assert.ok(at.cap.scroll > at.cap.client + 4, `with the rest of the run past it`)
    assert.match(at.fade?.image ?? "", /gradient/, `and a fade at the edge`)
    assert.ok(at.more.height >= 44, `and the Show more still 44px tall`)
    assert.ok(
      at.body.bottom <= at.frame.bottom + 2 && at.body.bottom > at.frame.top,
      `and the row's end in view (${at.body.bottom}px in ${at.frame.top}-${at.frame.bottom}px)`,
    )
    caps.push({
      width,
      height,
      cap: at.cap.height,
      more: at.more.height,
      fade: at.fade.image,
      end: at.body.bottom,
      frame: at.frame.bottom,
    })
    await shot(`cap-${width}`)
  }

  const light = caps.at(-1).fade
  await page.emulateMedia({ colorScheme: "dark" })
  await settled(page)
  const dark = await row()
  assert.ok(
    await page.evaluate(() => document.documentElement.classList.contains("dark")),
    "the app is in its dark theme",
  )
  assert.match(dark.fade?.image ?? "", /gradient/, "the fade is drawn in the dark too")
  assert.notEqual(dark.fade.image, light, "from the dark theme's own background")
  assert.ok(
    dark.fade.image.includes(dark.background) || dark.background === "rgba(0, 0, 0, 0)",
    `ending in the page's own background (${dark.background})`,
  )
  await shot("cap-dark")
  await page.emulateMedia({ colorScheme: "light" })
  pass(
    `the cap holds at 390px (${caps[0].cap}px) and 834px (${caps[1].cap}px), and the fade follows the theme`,
  )
})
