// A chat the host compacted in place: the live transcript starts at the compaction's summary, so the
// thread shows only what was written since. The rows it archived come back when the reader reaches
// the top of the thread — the whole conversation, each turn once, with the compaction's divider
// where the compaction happened rather than at the top of a truncated window (ADR 0058). The reach
// replaces a button, so what only a browser can say is that nothing above the window is on the
// device before the reader gets to the pane's top and the whole archive is there after it.
import { app, assert, flow, mock, pass, runId } from "./lib.mjs"

const auth = { Authorization: "Bearer mock-key", "Content-Type": "application/json" }

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

/** The chat's live transcript, as the host counts it: the archived rows aren't in it. */
async function transcript(sessionId) {
  const res = await fetch(`${mock}/api/sessions/${sessionId}/messages?order=latest&limit=500`, {
    headers: auth,
  })
  return (await res.json()).data
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

    // Another device wrote the whole conversation; this one has never opened it.
    const names = ["first", "second", "third", "fourth", "fifth", "sixth"]
    for (const name of names) {
      const run = await startRun(sessionId, long(name))
      await until(async () => (await runStatus(run)) === "completed", 30_000, `"${name}" to end`)
    }
    const done = await transcript(sessionId)
    const starts = done.flatMap((row, i) => (row.role === "user" ? [i] : []))
    // The host compacts in place, carrying the newest two turns forward under fresh row ids: the
    // four before them are archived, and the carried originals are superseded.
    const compacted = await fetch(`${mock}/__mock/compact`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ session_id: sessionId, rows: done.length - starts[starts.length - 2] }),
    })
    assert.equal(compacted.status, 200, "the host compacts the chat")
    const after = await startRun(sessionId, long("seventh"))
    await until(async () => (await runStatus(after)) === "completed", 30_000, "the newest turn")

    // The chat opens on its live window: the carried turns and the one written since.
    await page.goto(`${app}/c/${chatId}`)
    await until(async () => count(await thread(page, chatId), "fifth") === 1, 20_000, "the window")
    const window = await thread(page, chatId)
    for (const name of ["first", "second", "third", "fourth"])
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
    for (const name of [...names, "seventh"])
      assert.equal(count(whole, name), 1, `"${name}" is held once, not twice`)
    assert.equal(await hasMore(page, chatId), false, "the window reaches the chat's first row")
    pass("reaching the top brings the archived turns back, each once")

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
      divider > page1.indexOf("sixth") && divider < page1.indexOf("seventh"),
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
