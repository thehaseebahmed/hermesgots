// A chat the host compacted in place: the live transcript starts at the compaction's summary, so the
// thread shows only what was written since. The rows it archived come back when the reader reaches
// the top of the thread — the whole conversation, each turn once, with the compaction's divider
// where the compaction happened rather than at the top of a truncated window (ADR 0058). The reach
// replaces a button, so what only a browser can say is that nothing above the window is on the
// device before the reader gets to the pane's top and the whole archive is there after it.
import { app, assert, flow, mock, pass, runId } from "./lib.mjs"

const auth = { Authorization: "Bearer mock-key", "Content-Type": "application/json" }

/** Turns written straight to the host's transcript, so the archive spans more than one page. */
const BULK = 300

/** Starts a turn straight on the host, as another device would. */
async function startRun(sessionId, input) {
  const res = await fetch(`${mock}/v1/runs`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ session_id: sessionId, input }),
  })
  assert.equal(res.status, 202, `the host starts "${input}"`)
  return (await res.json()).run_id
}

async function runStatus(id) {
  const res = await fetch(`${mock}/v1/runs/${id}`, { headers: auth })
  return (await res.json()).status
}

/** What this device holds of the chat, oldest first. */
const thread = (page, chatId) =>
  page.evaluate(async (id) => {
    const { getMessages } = await import("/src/lib/db.ts")
    return (await getMessages(id)).map((m) => ({
      role: m.role,
      text: m.content,
      row: m.hermesRowId ?? null,
    }))
  }, chatId)

const hasMore = (page, chatId) =>
  page.evaluate(
    async (id) =>
      Boolean((await (await import("/src/lib/db.ts")).db.conversations.get(id)).olderThan),
    chatId,
  )

const drawn = (page) => page.evaluate(() => document.body.innerText)
const count = (messages, text) => messages.filter((m) => m.text.includes(text)).length

/** A user's words, long enough that a few turns fill a phone's pane. */
const long = (name) =>
  `${name}: ` + Array.from({ length: 10 }, (_, i) => `The ${name}'s point ${i + 1}.`).join(" ")

await flow(
  "chat-archive",
  async ({ page, seed, until, shot }) => {
    const chatId = `e2e-archive-${runId()}`
    await seed([{ id: chatId, title: "Archive" }])
    const sessionId = await page.evaluate(
      async (id) =>
        (await (await import("/src/lib/db.ts")).db.conversations.get(id)).hermesSessionId,
      chatId,
    )

    // The far history first, so the turns named below sit nearest the seam: more rows above it than
    // one page of the host's display read carries, so the reach has to walk several pages and put
    // them back in the host's order rather than its own read order.
    const bulk = await fetch(`${mock}/__mock/rows`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ session_id: sessionId, rows: 2 * BULK, from: 1 }),
    })
    assert.equal(bulk.status, 200, "the chat holds more turns than one page")
    // Another device wrote the whole conversation; this one has never opened it.
    const names = ["first", "second", "third"]
    // The turns the compaction will carry forward, enough of them that the live window is taller than
    // a phone's pane — so the archive above it waits for the reader rather than landing on open.
    const carried = ["fourth", "fifth", "sixth", "seventh", "eighth", "ninth"]
    for (const name of [...names, ...carried]) {
      const run = await startRun(sessionId, long(name))
      await until(async () => (await runStatus(run)) === "completed", 30_000, `"${name}" to end`)
    }
    // The host compacts in place, carrying the newest turns forward under fresh row ids: the rest
    // are archived, and the carried originals are superseded.
    const compacted = await fetch(`${mock}/__mock/compact`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ session_id: sessionId, rows: 2 * carried.length }),
    })
    assert.equal(compacted.status, 200, "the host compacts the chat")
    const after = await startRun(sessionId, long("tenth"))
    await until(async () => (await runStatus(after)) === "completed", 30_000, "the newest turn")

    // The chat opens on its live window: the carried turns and the one written since.
    await page.goto(`${app}/c/${chatId}`)
    await until(async () => count(await thread(page, chatId), "ninth") === 1, 20_000, "the window")
    const window = await thread(page, chatId)
    for (const name of names)
      assert.equal(count(window, name), 0, `"${name}" waits above the window, off the device`)
    assert.ok(await hasMore(page, chatId), "the host still holds rows above it")
    await shot("window")
    pass("a compacted chat opens on its live window, with the archive still above it")

    // The reach, in one go: nothing above the window is on the device before the reader gets to the
    // pane's top, and the whole archive is there after it.
    const before = await page.evaluate(() => {
      const el = document.querySelector('[aria-label="Messages"]')
      el.scrollTo({ top: 0 })
      return { top: el.scrollTop, height: el.scrollHeight }
    })
    await until(
      async () => count(await thread(page, chatId), "first") === 1,
      30_000,
      "the archived turns to land",
    )
    await page.getByText("first").first().waitFor({ timeout: 10_000 })

    const whole = await thread(page, chatId)
    for (const name of [...names, ...carried, "tenth"])
      assert.equal(count(whole, name), 1, `"${name}" is held once, not twice`)
    // Everything above the seam came back in the host's order. The archive spans more pages than
    // one read answers, so a walk that stacks its pages, rather than putting each in front of the
    // last, shows up here as a reversed stretch.
    const bulkOrder = whole
      .filter((m) => m.text.startsWith("Bulk "))
      .map((m) => Number(m.text.slice(5, m.text.indexOf(":"))))
    assert.equal(bulkOrder.length, 2 * BULK, "every archived turn is on the device")
    assert.deepEqual(
      [...bulkOrder].sort((a, b) => a - b),
      bulkOrder,
      "the archive is in the host's order, not the walk's read order",
    )
    assert.equal(await hasMore(page, chatId), false, "the window reaches the chat's first row")
    pass("reaching the top brings the archived turns back, each once, in the host's order")

    // The pane took the rows above it: it moved down the thread rather than staying where it was.
    const later = await page.evaluate(() => {
      const el = document.querySelector('[aria-label="Messages"]')
      return { top: el.scrollTop, height: el.scrollHeight }
    })
    assert.ok(
      later.height > before.height && later.top > before.top,
      `the archive grew the thread above the pane: ${before.height}/${before.top} → ${later.height}/${later.top}`,
    )
    pass("the archive lands above the pane, which grew to hold it")

    // The divider stands where the compaction happened: under the turns it carried, over the one
    // written since — not at the top of a truncated window.
    await page.getByText("Compaction").first().waitFor({ timeout: 10_000 })
    const page1 = await drawn(page)
    const divider = page1.indexOf("Compaction")
    assert.ok(
      divider > page1.indexOf("sixth") && divider < page1.indexOf("tenth"),
      "the compaction's divider sits between the turns it carried and the one after it",
    )
    assert.ok(
      page1.split("Compaction").length - 1 === 1,
      "one compaction, one divider",
    )
    await shot("archive")
    pass("the divider stands where the compaction happened, with the archive above it")
  },
  { viewport: { width: 390, height: 700 }, touch: true },
)
