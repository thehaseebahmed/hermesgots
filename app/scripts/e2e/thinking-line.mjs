// One turn on the mock, told to stall so its reasoning is the only thing on the wire for a while: the
// only way a poll can look at a thread mid-thought.
import { assert, app, flow, pass, settled } from "./lib.mjs"

/** One reply's own row in the thread: the header and the toaster say plenty this flow must not read. */
const ITEM = "[data-slot=message-scroller-item]"
const WORKING = '[aria-live="polite"]'
const LINE = /^(Thought|Thinking…)/
const WEIGHING = "weighing what's under /var/log"
const LAST = "leaves the delete to them"

await flow("thinking-line", async ({ page, send, lastReply, until, shot }) => {
  await page.goto(app)
  await send("think out loud, then stall: where did the space under /var/log go?")
  await page.waitForURL("**/c/**", { timeout: 15_000 })
  const chatId = new URL(page.url()).pathname.split("/").at(-1)
  const item = page.locator(ITEM).last()
  const line = item.getByRole("button", { name: LINE })
  // The text a line folds is named by aria-controls, whose id is React's and so not a selector.
  const body = (controls) =>
    page.evaluate((id) => {
      const found = document.getElementById(id)
      return { text: found?.textContent ?? "", hidden: found?.getAttribute("aria-hidden") ?? null }
    }, controls)

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
          if (last.reasoning || last.content) return null
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
    15_000,
    "the reply to be up with nothing said yet and its working line showing",
  )
  assert.match(beforeReasoning.says, /Writing…/, "the working line says what it is doing")
  assert.equal(beforeReasoning.lines, 0, "with no thinking line for a turn that hasn't thought yet")
  await shot("working")
  pass(
    "the working line reads Writing… before the turn's first reasoning, with no thinking line yet",
  )

  // One piece in with the rest still to come, and no tool run or answer that would stand the working
  // line down for a reason of its own: a single block would have put all four on the row at once.
  await until(
    async () => {
      const row = await lastReply(chatId)
      if (row?.status !== "streaming" || !row.reasoning.includes(WEIGHING)) return null
      return row.content || row.tools || row.reasoning.includes(LAST) ? null : row
    },
    20_000,
    "a reasoning piece to land with more of it still to come",
  )
  await until(
    async () => ((await item.textContent())?.includes(WEIGHING) ? true : null),
    5_000,
    "the reasoning to reach the thread",
  )
  assert.equal(await line.count(), 1, "the turn thinking draws one thinking line")
  assert.equal((await line.textContent())?.trim(), "Thinking…", "which says it is still thinking")
  assert.equal(await line.getAttribute("aria-expanded"), "true", "and stands open as it thinks")
  const midThought = await body(await line.getAttribute("aria-controls"))
  assert.ok(midThought.text.includes(WEIGHING), "its body readable, holding the piece that landed")
  assert.equal(
    await item.locator(WORKING).count(),
    0,
    "the working line has stood down while the reasoning streams",
  )
  assert.doesNotMatch(
    (await item.textContent()) ?? "",
    /Writing…/,
    "and nothing in the reply still says it is writing",
  )

  // The mock's last piece, then its hold: the line still open over all of it, nothing else begun.
  await until(
    async () => {
      const row = await lastReply(chatId)
      return row?.reasoning.includes(LAST) && !row.content && !row.tools ? row : null
    },
    10_000,
    "the last reasoning piece to land before any answer",
  )
  assert.equal(await line.getAttribute("aria-expanded"), "true", "the line is still open over it")
  await settled(page)
  await shot("thinking")
  pass(
    "mid-thought the line stands open reading Thinking…, the working line gone from the reply while no tool runs",
  )

  // The first answer token folds it over the span this page watched arrive.
  await until(
    async () => ((await lastReply(chatId))?.content ? true : null),
    30_000,
    "the reply's first answer token",
  )
  await until(
    async () => ((await line.getAttribute("aria-expanded")) === "false" ? true : null),
    5_000,
    "the line to fold",
  )
  const label = (await line.textContent())?.trim() ?? ""
  assert.match(label, /^Thought for \d+s$/, "the answer starting folds it over the span it watched")
  const folded = await body(await line.getAttribute("aria-controls"))
  assert.equal(folded.hidden, "true", "and the folded reasoning leaves the tree")

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
  pass(`the first answer token folded the line to "${label}" over the reasoning it watched arrive`)

  // A fresh page holds no span, so the same line reads Thought with no number at all.
  await page.reload()
  await until(
    async () => ((await line.count()) ? true : null),
    15_000,
    "the reloaded thread's line",
  )
  assert.equal(
    (await line.textContent())?.trim(),
    "Thought",
    "a page that watched none of it reads Thought, with no number on it",
  )
  assert.equal(await line.getAttribute("aria-expanded"), "false", "folded")
  const restored = await body(await line.getAttribute("aria-controls"))
  assert.equal(restored.hidden, "true", "its body folded away")
  assert.ok(restored.text.includes(LAST), "and the reasoning still there to open")
  await shot("restored")
  pass("a reload reads a bare Thought, folded, over the reasoning the turn still holds")
})
