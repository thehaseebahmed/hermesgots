// A session started on another device and opened here while a turn longer than a transcript page
// runs: the newest turn loads whole, "Load earlier" pages back a whole long turn twice, and the running
// reply stays one reply at the end of the chat. Main split the turn at the page edge, so it showed
// twice, and the live reply grew above the stale part. Then a chat left in that split state by an
// older version is mended by its next "Load earlier".
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

/** Every step of each long turn is in the chat exactly once, in order, with one reply a turn. */
function assertWhole(messages) {
  const summary = messages.map((m) => `${m.role}:${m.text.slice(0, 40)}`).join(" | ")
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
  const earlier = page.getByRole("button", { name: "Load earlier messages" })
  await earlier.waitFor({ timeout: 15_000 })
  const opened = await thread(page, chatId)
  assert.equal(opened[0]?.role, "user", "the chat opens at the start of a turn")
  assert.match(opened[0].text, /marathon/)
  assert.equal(
    opened.filter((m) => m.role === "assistant").length,
    1,
    "the running turn is one reply",
  )
  pass("the newest turn loads whole, with Load earlier above it")

  await earlier.click()
  await until(async () => (await thread(page, chatId)).length === 4, 15_000, "the relay to load")
  await earlier.click()
  await until(async () => (await thread(page, chatId)).length === 6, 15_000, "the sprint to load")
  await earlier.waitFor({ state: "detached", timeout: 10_000 })
  pass("Load earlier pages back whole turns, twice, and goes once the session's start is in")

  await until(async () => (await runStatus(marathon)) === "completed", 40_000, "the run to finish")
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
  for (let i = 0; i < 3; i++) {
    const before = (await thread(page, oldChat)).length
    await earlier.click()
    await until(
      async () => (await thread(page, oldChat)).length !== before,
      15_000,
      "earlier turns to load",
    )
  }
  await earlier.waitFor({ state: "detached", timeout: 10_000 })
  assertWhole(await thread(page, oldChat))
  pass("Load earlier mends a chat whose first turn an older version cut")
})
