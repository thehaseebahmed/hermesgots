// A subagent's work outlives the turn that dispatched it: the question the agent asks in its place
// while the subagent still runs, the delivery that landed after it, and the wake turn the plugin
// posts answered as a message of its own (#471). What only a browser reaches is the timing — the
// composer given back to the question while the host still lists the subagent at work, and the
// wake's text arriving a piece at a time rather than all at once.
import { app, assert, flow, mock, pass, runId } from "./lib.mjs"

const ASK = "delegate and ask"
const QUESTION = "Should the cap cover the archived journals too?"
/** The turn's words before the question, which the reply must draw once and not once per half. */
const LEADIN = "I'll have a subagent dig into the logs"
/** The result's own last words, which only the delivery carries. */
const RESULT_END = "frees the most for one line"
/** The wake turn's answer, in its own words — never the delivery's. */
const WAKE_OPEN = "The subagent is back."
const WAKE_END = "the cap holds across a reboot"

await flow("question-during-delegation", async ({ page, seed, send, lastReply, until, shot }) => {
  const chat = `e2e-delegation-${runId()}`
  await seed([{ id: chat, title: "Delegation and a question" }])
  await page.goto(`${app}/c/${chat}`)

  // The chat's Hermes session, so the plugin's own route can be read at the moment that matters.
  const sessionId = await page.evaluate(async (id) => {
    const { db } = await import("/src/lib/db.ts")
    return (await db.conversations.get(id))?.hermesSessionId
  }, chat)
  assert.ok(sessionId, "the chat has a Hermes session")
  const agents = async () => {
    const answered = await fetch(
      `${mock}/api/plugins/memento/sessions/${encodeURIComponent(sessionId)}/agents`,
    )
    return (await answered.json()).agents ?? []
  }
  // What the host says runs for this chat (`runs/live`), so a reply is known to have arrived while
  // its run was still going rather than after it ended.
  const live = async () => {
    const answered = await fetch(`${mock}/api/plugins/memento/runs/live`)
    const body = await answered.json()
    return { session: body.sessions?.[sessionId] ?? null }
  }
  // The thread as the app stored it, and the DOM order of two of its nodes — what the flow reads
  // instead of a message's place on a screen that scrolls under it.
  const precedes = async (first, second) =>
    page.evaluate(
      ([a, b]) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING),
      [await first.elementHandle(), await second.elementHandle()],
    )
  const messages = () =>
    page.evaluate(async (id) => {
      const { db } = await import("/src/lib/db.ts")
      return (await db.messages.where("conversationId").equals(id).sortBy("createdAt")).map(
        (message) => ({
          role: message.role,
          content: message.content,
          subagent: message.subagent ?? null,
        }),
      )
    }, chat)
  // How many times the thread draws a phrase: the reply settles again when the run that a question
  // paused ends, and the words before the question must not be drawn a second time by it.
  const drawnTimes = (phrase) =>
    page.evaluate((phrase) => {
      const thread = document.querySelector("[data-slot=message-scroller]")?.textContent ?? ""
      return thread.split(phrase).length - 1
    }, phrase)

  await send(ASK)

  const working = page.getByText("Running for", { exact: false })
  await page
    .getByText(/Sub-Agent: /)
    .first()
    .waitFor({ timeout: 20_000 })
  await working.first().waitFor({ timeout: 20_000 })
  const listed = await until(
    async () => {
      const found = await agents()
      return found.length && found.every((agent) => agent.status === "running") ? found : null
    },
    20_000,
    "the plugin to list the subagent as running",
  )
  assert.equal(listed.length, 1, "one subagent was dispatched")
  await shot("subagent-working")
  pass("the delegation's card shows its subagent running")

  await page.getByText(QUESTION).waitFor({ timeout: 20_000 })
  assert.equal(
    await page.getByLabel("Message", { exact: true }).count(),
    0,
    "the question stands where the composer was",
  )
  assert.deepEqual(
    (await agents()).map((agent) => agent.status),
    ["running"],
    "the subagent is still running while the question is up",
  )
  assert.ok(await working.first().isVisible(), "and its card still says it is working")
  await shot("question")
  pass("the question replaces the composer while the subagent still runs")

  await page.getByRole("button", { name: "Yes, cap everything" }).click()
  await page.getByRole("button", { name: "Send" }).click()
  await until(
    async () => (await page.getByLabel("Message", { exact: true }).count()) === 1,
    15_000,
    "the composer to come back once the answer is sent",
  )

  let tailWhenLanded = null
  const delivered = await until(
    async () => {
      const all = await messages()
      const index = all.findLastIndex((message) => message.subagent)
      if (index < 0) return null
      tailWhenLanded = all.slice(index + 1)
      return all[index]
    },
    40_000,
    "the subagent's result to be delivered into the thread",
  )
  assert.equal(delivered.role, "assistant", "the result is the bot's message, not the user's")
  assert.ok(delivered.content.includes(RESULT_END), "the result itself is what the message holds")
  assert.ok(
    !delivered.content.includes("ASYNC DELEGATION COMPLETE"),
    "and not the notification's header",
  )
  assert.ok(
    tailWhenLanded.every((message) => message.role === "assistant" && !message.subagent),
    "it landed at the thread's end",
  )
  const all = await messages()
  const at = all.findIndex((message) => message.content === delivered.content)
  const answered = all.findIndex((message) =>
    message.content.includes("Noted: yes, cap everything"),
  )
  assert.ok(at > answered, "after the reply the answer brought, not inside it")
  const row = page.locator("[data-slot=message]", { hasText: RESULT_END }).last()
  await row.waitFor({ timeout: 15_000 })
  assert.equal(await row.getAttribute("data-align"), "start", "on the bot's own side")
  assert.equal(
    await row.locator("[data-slot=bubble-content]").count(),
    0,
    "with no bubble, as a reply has none",
  )
  const resultCard = page.locator("[data-slot=subagent-result]").first()
  await resultCard.waitFor({ timeout: 15_000 })
  assert.match(await resultCard.innerText(), /Sub-Agent: /, "the result names its subagent")
  assert.ok(await precedes(resultCard, row), "and sits above the result's own words")
  await shot("result-delivered")
  pass("the result landed as the bot's own message at the thread's end")

  assert.equal(
    await drawnTimes(LEADIN),
    1,
    "the turn's words before the question are drawn once, not once for each half of its reply",
  )
  pass("the reply says what it said before the question exactly once")

  assert.deepEqual(
    all.filter((message) => message.role === "user").map((message) => message.content),
    [ASK],
    "the user's own message is the only one of theirs",
  )
  assert.deepEqual(
    all.filter((message) => message.content.includes("ASYNC DELEGATION COMPLETE")),
    [],
    "no message of the thread holds the wake prompt",
  )
  assert.equal(
    await page.getByText(/INTERNAL NOTIFICATION/).count(),
    0,
    "the footer the wake prompt arrived with is drawn nowhere",
  )
  assert.equal(await page.getByText(/ASYNC DELEGATION COMPLETE/).count(), 0, "nor is the header")
  pass("the wake prompt drew nothing of the thread")

  const drawn = () =>
    page.evaluate(
      () => document.querySelector("[data-slot=message-scroller]")?.textContent?.length ?? 0,
    )
  const lengths = new Set()
  let woken = null
  let liveWhenDrawn = false
  for (const end = Date.now() + 45_000; Date.now() < end;) {
    const last = await lastReply(chat)
    if (last?.content.startsWith(WAKE_OPEN)) {
      if (!lengths.size) liveWhenDrawn = Boolean((await live()).session)
      lengths.add(await drawn())
      assert.ok(
        !last.content.includes(RESULT_END),
        "the wake's answer is its own message, not the result's text again",
      )
      if (last.content.includes(WAKE_END)) {
        woken = last
        break
      }
    }
    await page.waitForTimeout(150)
  }
  assert.ok(woken, "the wake turn's answer landed")
  assert.ok(liveWhenDrawn, "its answer started arriving while its run was still going on the host")
  assert.ok(
    lengths.size > 2,
    `the thread grew a piece at a time as the wake turn ran (saw ${lengths.size} lengths)`,
  )
  await page.getByText(WAKE_END).first().waitFor({ timeout: 15_000 })
  const wakeRow = page.locator("[data-slot=message]", { hasText: WAKE_END }).last()
  assert.equal(await wakeRow.getAttribute("data-align"), "start", "the bot's own side")
  assert.equal(await wakeRow.locator("[data-slot=bubble-content]").count(), 0, "with no bubble")
  await row.getByText(RESULT_END).waitFor()
  const wokeTool = page.getByText("Ran a command", { exact: false }).last()
  await wokeTool.waitFor({ timeout: 15_000 })
  assert.ok(await precedes(row, wokeTool), "the wake turn ran a tool of its own, below the result")
  pass("the wake turn ran a tool and drew it")
  await shot("wake-turn")
  pass("the wake turn streamed in as a message of its own")

  // Read again from the transcript: a reload folds the turn afresh, and the reply's lead-in still
  // belongs to it once.
  await page.reload()
  await page.getByText(WAKE_END).first().waitFor({ timeout: 20_000 })
  assert.equal(await drawnTimes(LEADIN), 1, "and a reload draws those words once too")
  pass("the thread keeps the words before the question once, live and after a reload")
})
