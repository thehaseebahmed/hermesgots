// A session compacted on the host while this device already showed its turns: the compression carries
// the newest turns forward under fresh row ids, so catch-up meets turns it has already drawn. It must
// end up with each turn once — the whole sequence showing twice is what a user sees as their messages
// repeating, with the carried turns landing around the messages they sent since.
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

async function transcript(sessionId) {
  const res = await fetch(`${mock}/api/sessions/${sessionId}/messages?order=latest&limit=500`, {
    headers: auth,
  })
  return (await res.json()).data
}

/** The chat as it reads: each message's role, status and text, oldest first. */
const thread = (page, chatId) =>
  page.evaluate(async (id) => {
    const { getMessages } = await import("/src/lib/db.ts")
    return (await getMessages(id)).map((m) => ({ role: m.role, status: m.status, text: m.content }))
  }, chatId)

const sessionOf = (page, chatId) =>
  page.evaluate(
    async (id) => (await (await import("/src/lib/db.ts")).db.conversations.get(id)).hermesSessionId,
    chatId,
  )

const count = (messages, text) => messages.filter((m) => m.text.includes(text)).length

await flow("history-generations", async ({ page, seed, until, shot }) => {
  const chatId = `e2e-gens-${runId()}`
  await seed([{ id: chatId, title: "Generations" }])
  const sessionId = await sessionOf(page, chatId)

  // Another device: two turns, both finished.
  for (const input of ["first turn's work", "second turn's work"]) {
    const run = await startRun(sessionId, input)
    await until(async () => (await runStatus(run)) === "completed", 30_000, `"${input}" to finish`)
  }

  await page.goto(`${app}/c/${chatId}`)
  await until(async () => (await thread(page, chatId)).length >= 4, 20_000, "both turns to load")
  const opened = await thread(page, chatId)
  assert.equal(count(opened, "first turn's work"), 1, "the first turn shows once")
  assert.equal(count(opened, "second turn's work"), 1, "the second turn shows once")
  const replies = opened.filter((m) => m.role === "assistant").length
  pass("two turns from another device show once each")

  // The host compacts the session in place: the carried tail comes back under fresh row ids, behind
  // the task-list notice row, and the rows before it leave the active transcript. The tail is the
  // newest turns — both of them here, since what a user reports is a whole block of the thread
  // repeating, not one turn of it.
  const rows = await transcript(sessionId)
  const users = rows.flatMap((row, i) => (row.role === "user" ? [i] : []))
  const carried = rows.length - users[users.length - 2]
  const compacted = await fetch(`${mock}/__mock/compact`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ session_id: sessionId, rows: carried }),
  })
  assert.equal(compacted.status, 200, "the host compacts the session")
  await shot("compacted")

  // Catch-up, the way it runs in an open chat: the compaction's rows reach a thread this device has
  // already drawn, and its live queries redraw from the write.
  await page.goto(`${app}/c/${chatId}`)
  await page.getByText("second turn's work").first().waitFor({ timeout: 20_000 })
  await page.evaluate(
    async (id) => (await import("/src/lib/history.ts")).reconcileHistory(id),
    chatId,
  )
  const after = await thread(page, chatId)
  const summary = after.map((m) => `${m.role}:${m.text.slice(0, 24)}`).join(" | ")

  assert.equal(
    count(after, "second turn's work"),
    1,
    `the carried turn still shows once: ${summary}`,
  )
  assert.equal(
    count(after, "first turn's work"),
    1,
    `the turn before it still shows once: ${summary}`,
  )
  assert.equal(
    after.filter((m) => m.role === "assistant").length,
    replies,
    `the compaction adds no reply: ${summary}`,
  )
  // And what is drawn, once the live queries have drawn each turn: a turn drawn twice still fails
  // the assertion below rather than the wait.
  await page
    .waitForFunction(
      (texts) => texts.every((text) => document.body.innerText.includes(text)),
      ["first turn's work", "second turn's work"],
      { timeout: 10_000 },
    )
    .catch(() => {})
  const drawn = await page.evaluate(() => document.body.innerText)
  for (const text of ["first turn's work", "second turn's work"])
    assert.equal(drawn.split(text).length - 1, 1, `"${text}" is drawn once: ${drawn.slice(-400)}`)
  pass("a compaction the device already showed leaves its turns shown once")
  // The boundary row compression writes is the host's own bookkeeping: it rides a user row, but it
  // is nobody's message, so the thread draws nothing of it — a user bubble of it reads as if the
  // user had typed the host's notes themselves.
  const note = "[Your active task list was preserved across context compression]"
  assert.ok(!drawn.includes(note), `the compaction's task-list note draws no message: ${drawn.slice(-600)}`)
  pass("the compaction's own note draws nothing in the thread")
})
