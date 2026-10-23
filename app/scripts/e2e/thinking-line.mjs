// One turn on the mock, told to stall so its reasoning is the only thing on the wire for a while: the
// only way a poll can look at a thread mid-thought. The mock breaks that reasoning with a tool call
// between its second and third pieces, so the turn is two runs — one drawn above the call, one below.
import { assert, app, flow, pass, settled } from "./lib.mjs"

/** One reply's own row in the thread: the header and the toaster say plenty this flow must not read. */
const ITEM = "[data-slot=message-scroller-item]"
const WORKING = '[aria-live="polite"]'
const LINE = /^(Thought|Thinking…)/
const SPAN = /^Thought for \d+s$/
const FIRST = "working-out, not just the answer"
const ROTATIONS = "gzipped rotations are the bulk of it"
const LAST = "leaves the delete to them"

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
})
