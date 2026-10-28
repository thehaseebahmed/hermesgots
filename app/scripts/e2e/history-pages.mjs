// A session started on another device and opened here while a turn longer than a transcript page
// runs: the newest turn loads whole, and the window growing backwards brings back a whole long turn
// twice without repeating a word of it, while the running reply stays one reply at the end of the
// chat. Main split the turn at the page edge, so it showed twice, and the live reply grew above the
// stale part. Then a chat left in that split state by an older version is mended by its next window
// step.
import { app, assert, flow, mock, pass, runId, runStatus, startRun } from "./lib.mjs"

const auth = { Authorization: "Bearer mock-key", "Content-Type": "application/json" }

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
    return (await getMessages(id)).map((m) => ({
      role: m.role,
      status: m.status,
      text: m.content,
      row: m.hermesRowId ?? null,
      at: m.createdAt,
      id: m.id,
    }))
  }, chatId)

/** Every step of each long turn is in the chat exactly once, in order, with one reply a turn. */
function assertWhole(messages) {
  const summary = messages.map((m) => `${m.role}#${m.row}:${m.text.slice(0, 24)}`).join(" | ")
  assert.deepEqual(
    messages.map((m) => m.role),
    ["user", "assistant", "user", "assistant", "user", "assistant"],
    `three turns, one reply each: ${summary}`,
  )
  const all = messages.map((m) => m.text).join("\n")
  for (const [i, name] of ["sprint", "relay", "marathon"].entries()) {
    assert.match(messages[2 * i].text, new RegExp(name))
    for (const step of [1, 20, 40]) {
      const line = `The ${name}'s step ${step} of 40.`
      assert.equal(all.split(line).length - 1, 1, `"${line}" shows once: ${summary}`)
    }
    const reply = messages[2 * i + 1].text
    assert.ok(reply.indexOf(`The ${name}'s step 1 of 40.`) >= 0, `${name}'s reply starts whole`)
    assert.ok(reply.includes(`The ${name} is over.`), `${name}'s reply ends whole`)
  }
}

/** One step of the window, as reaching the top of the thread takes. */
const growWindow = (page, chatId) =>
  page.evaluate(async (id) => (await import("/src/lib/history.ts")).loadEarlierHistory(id), chatId)

/** What each window step did, for a failing run's diagnosis. */
const trace = (page) => page.evaluate(() => globalThis.TRACE ?? [])

/** Whether Hermes still holds rows older than the ones on this device. */
const hasMore = (page, chatId) =>
  page.evaluate(
    async (id) =>
      Boolean((await (await import("/src/lib/db.ts")).db.conversations.get(id)).olderThan),
    chatId,
  )

await flow("history-pages", async ({ page, seed, until, shot }) => {
  const chatId = `e2e-pages-${runId()}`
  await seed([{ id: chatId, title: "Pages" }])
  const sessionId = await page.evaluate(
    async (id) => (await (await import("/src/lib/db.ts")).db.conversations.get(id)).hermesSessionId,
    chatId,
  )

  // Another device: two long turns, then a third still running.
  for (const input of ["go for a sprint", "now a relay"]) {
    const run = await startRun(sessionId, input)
    await until(async () => (await runStatus(run)) === "completed", 30_000, `"${input}" to finish`)
  }
  const marathon = await startRun(sessionId, "run a marathon")
  await until(
    async () => {
      const rows = await transcript(sessionId)
      const start = rows.findLastIndex((r) => r.role === "user")
      return rows.length - start > 55
    },
    20_000,
    "the running turn to outgrow a transcript page",
  )
  assert.equal(await runStatus(marathon), "running", "the marathon still runs")

  await page.goto(`${app}/c/${chatId}`)
  await until(
    async () => (await thread(page, chatId)).length >= 2,
    15_000,
    "the newest turn to load",
  )
  const opened = await thread(page, chatId)
  assert.equal(opened[0]?.role, "user", "the chat opens at the start of a turn")
  assert.match(opened[0].text, /marathon/)
  assert.equal(
    opened.filter((m) => m.role === "assistant").length,
    1,
    "the running turn is one reply",
  )
  assert.ok(await hasMore(page, chatId), "the window still holds the turns above it")
  pass("the newest turn loads whole, with the window still open above it")

  await growWindow(page, chatId)
  const grown = await until(
    async () => {
      const messages = await thread(page, chatId)
      return messages.length === 6 ? messages : null
    },
    30_000,
    "the relay and the sprint to load",
  )
  assert.equal(grown.length, 6, "three turns land")
  if (process.env.DEBUG_PAGES) {
    const rows = await transcript(sessionId)
    console.log(
      "thread:",
      grown.map((m) => `${m.role}#${m.row}@${m.at}:${m.text.slice(0, 14)}`).join(" | "),
    )
    console.log(
      "host:",
      rows.map((r) => `${r.role}#${r.id}@${Math.round(r.timestamp * 1000)}`).join(" | "),
    )
  }
  assert.equal(await hasMore(page, chatId), false, "the window reaches the session's start")
  pass("the window grows back whole turns and stops at the session's start")

  // The turn that was running when the chat opened is the host's to finish, and it lands whole.
  await until(async () => (await runStatus(marathon)) === "completed", 60_000, "the marathon to end")
  const whole = await until(
    async () => {
      const messages = await thread(page, chatId)
      return messages.at(-1)?.text.includes("The marathon is over.") ? messages : null
    },
    20_000,
    "the marathon's reply to land whole",
  )
  assertWhole(whole)
  pass("each long turn is in the chat once, in order, with one reply")

  const done = await until(
    async () => {
      const messages = await thread(page, chatId)
      return messages.at(-1)?.role === "assistant" && messages.at(-1).status === "done"
        ? messages
        : null
    },
    20_000,
    "the reply to finish here",
  )
  await shot("done")
  assertWhole(done)
  await page.getByText("The marathon is over.").waitFor({ timeout: 5_000 })
  pass("the running reply finished at the end of the chat, once")

  // A chat an older version opened mid-turn: the newest page with its first turn cut off.
  const oldChat = `e2e-pages-old-${runId()}`
  await seed([{ id: oldChat, title: "Pages, split" }])
  await page.evaluate(
    async ({ id, sessionId, mock }) => {
      const { db } = await import("/src/lib/db.ts")
      const { toMessages } = await import("/src/lib/history.ts")
      const res = await fetch(`${mock}/api/sessions/${sessionId}/messages?order=latest&limit=50`, {
        headers: { Authorization: "Bearer mock-key" },
      })
      const rows = (await res.json()).data
      await db.conversations.update(id, {
        hermesSessionId: sessionId,
        hermesTip: rows.at(-1).id,
        olderThan: { id: rows[0].id, offset: rows.length },
      })
      await db.messages.bulkPut(toMessages(id, sessionId, rows))
    },
    { id: oldChat, sessionId, mock },
  )
  await page.goto(`${app}/c/${oldChat}`)
  const split = await thread(page, oldChat)
  assert.equal(split[0]?.role, "assistant", "the old chat starts with a cut reply")
  // The cut turn's start (mended in place), then the relay, then the sprint.
  await growWindow(page, oldChat)
  await until(async () => !(await hasMore(page, oldChat)), 15_000, "the window to reach the start")
  assertWhole(await thread(page, oldChat))
  pass("one window step mends a chat whose first turn an older version cut")
})
