// A call that asks several questions, and a reader who comes back to it. A host asks one prompt at a
// time and takes its own while between two; the card holds its place for a moment and is gone in
// between, so what the reader filled in ahead must outlive it. One Send carries every answer.
//
// Three ways of coming back: the wait is up and the chat is left and opened again; the chat is left
// before the host asks and opened onto a call already waiting; and the run is answered, carries on
// and asks a second call, whose card is its own.
import {
  answerWith,
  assert,
  chatPane,
  flow,
  mock,
  mockAuth,
  openChatNext,
  pass,
  questionPage,
  settled,
} from "./lib.mjs"

const SERIES = [
  { ask: "Which environment should this run against?", pick: "staging" },
  { ask: "Which services are in scope?", pick: "api" },
  { ask: "What should the change be called?", type: "nightly-log-rotation" },
  { ask: "How should existing data be handled?", pick: "Migrate it in place" },
  { ask: "Who should review it?", pick: "Platform" },
]

/** The call this script's second flow asks first: two of the five, then a call of one. */
const FIRST_CALL = SERIES.slice(0, 2)

const slotOf = (page) => page.locator("[data-slot=composer-slot]")
/** The chat's own thread, never a bot's Main drawn beside it. */
const threadOf = (page) => chatPane(page).locator("[aria-label=Messages]")

/**
 * Away from the chat and back, as leaving it and tapping it again is: the card the chat held is gone,
 * and everything it knew is read again from the host. `until` is what must be true before coming
 * back — a host that asks the call's question while nobody is watching it.
 */
async function leaveAndReturn(page, away) {
  const chat = page.url()
  await page.goto(`${new URL(chat).origin}/`)
  if (away) await away()
  await page.goto(chat)
  await chatPane(page).waitFor({ timeout: 20_000 })
}

/** The host's own account of the runs it has in flight, as its plugin lists them. */
async function liveRuns() {
  const res = await fetch(`${mock}/api/plugins/gots/runs/live`, { headers: mockAuth })
  return res.ok ? res.json() : {}
}

/** The Hermes session the chat on screen is, which is how the host names it in that account. */
const sessionOf = (page) =>
  page.evaluate(async () => {
    const { db } = await import("/src/lib/db.ts")
    const id = window.location.pathname.split("/").filter(Boolean).at(-1)
    return (await db.conversations.get(id))?.hermesSessionId
  })

/** Waits on the host's own account until the turn this chat's message started is at work. */
const runAtWork = (until, session) =>
  until(
    async () => Boolean((await liveRuns()).sessions?.[session]),
    30_000,
    "the host to take the message and start its turn",
  )

/** Waits on the host's own account until it says this chat's question waits, with nobody watching it. */
const raisedWhileAway = (until, session) =>
  until(
    async () => (await liveRuns()).waiting?.[session]?.kind === "question",
    60_000,
    "the host to raise the call's question while the chat is left",
  )

/** Fills the card's pages in, a question at a time, and sends the form on the last one. */
async function fill(page, series) {
  const slot = slotOf(page)
  for (const [at, question] of series.entries()) {
    await slot.getByText(`${at + 1} of ${series.length}`, { exact: true }).waitFor({
      timeout: 60_000,
    })
    await questionPage(slot).getByText(question.ask, { exact: false }).waitFor({ timeout: 60_000 })
    await settled(page)
    await answerWith(slot, question, at === series.length - 1 ? "Send" : "Next")
  }
}

/** Waits for a call's first page, the one a chat opened onto a waiting run draws itself. */
async function firstPage(page, pages, timeout = 60_000) {
  await slotOf(page)
    .getByText(`1 of ${pages}`, { exact: true })
    .waitFor({ timeout })
  await settled(page)
}

await flow(
  "question-reload-many-in-wait",
  async ({ page, seed, send, shot }) => {
    await openChatNext({ page, seed }, { id: "e2e-question-reload-many", title: "Waiting questions" })

    await send("ask five")
    await firstPage(page, SERIES.length)
    await shot("waiting")

    // The wait is up, and the chat is left and opened again: the card comes back on the call's first
    // page, from the run's own status and the call's row.
    await leaveAndReturn(page)
    await firstPage(page, SERIES.length)
    await shot("back")

    // The whole form, filled in on the pages the card holds, sent once.
    await fill(page, SERIES)

    // Every answer, and no second tap: a card drawn again in the host's gap answers the question it
    // is asked from the form it took, so the chat is never left again to give the next one.
    const thread = threadOf(page)
    await thread.getByText("Got 5 of 5 answers.", { exact: false }).waitFor({ timeout: 90_000 })
    assert.equal(
      await thread.getByText("No answer", { exact: true }).count(),
      0,
      "nothing was left owed",
    )
    assert.equal(
      await slotOf(page).getByText("Questions", { exact: true }).count(),
      0,
      "and no question is left waiting on the reader",
    )
    await shot("answered")
    pass("one Send after the wait is come back to carries a call's every answer")
  },
  { viewport: { width: 390, height: 844 }, dark: true },
)

await flow(
  "question-reload-many-away",
  async ({ page, seed, send, shot, until }) => {
    await openChatNext({ page, seed }, { id: "e2e-question-away", title: "Asked while away" })

    // The chat is left while the turn is at work and before the host asks anything of the call, so
    // the question is raised with nobody watching it: the run's status is the one place it can be
    // read, and the chat comes back onto a call already waiting.
    await send("ask five")
    const session = await sessionOf(page)
    await runAtWork(until, session)
    await leaveAndReturn(page, () => raisedWhileAway(until, session))
    await firstPage(page, SERIES.length, 90_000)
    await shot("back")

    await fill(page, SERIES)
    const thread = threadOf(page)
    await thread.getByText("Got 5 of 5 answers.", { exact: false }).waitFor({ timeout: 90_000 })
    assert.equal(
      await thread.getByText("No answer", { exact: true }).count(),
      0,
      "nothing was left owed",
    )
    assert.equal(
      await slotOf(page).getByText("Questions", { exact: true }).count(),
      0,
      "and no question is left waiting on the reader",
    )
    await shot("answered")
    pass("a call raised while the chat was left is answered whole once it is come back to")
  },
  { viewport: { width: 1024, height: 900 } },
)

await flow(
  "question-second-call",
  async ({ page, seed, send, shot }) => {
    await openChatNext({ page, seed }, { id: "e2e-question-twice", title: "Two calls" })
    const slot = slotOf(page)
    const thread = threadOf(page)

    await send("ask twice")
    await firstPage(page, FIRST_CALL.length)
    // Left and opened again with the call waiting, as a phone comes back to it: the second call's
    // card must still be its own when this one is answered.
    await leaveAndReturn(page)
    await firstPage(page, FIRST_CALL.length)
    // The first call's whole form, sent once, and the host takes it: both its answers on the thread's
    // card, and no question left for it.
    await fill(page, FIRST_CALL)
    await thread.getByText("Answered", { exact: true }).waitFor({ timeout: 60_000 })
    await thread.getByText("staging", { exact: true }).waitFor({ timeout: 60_000 })
    await thread.getByText("api", { exact: true }).waitFor({ timeout: 60_000 })

    // The second call is its own card: one question, nothing of the first form picked, and the
    // reader's own answer, not one carried over.
    await slot.getByText("Question", { exact: true }).waitFor({ timeout: 60_000 })
    assert.equal(
      await slot.getByText(/^\d of \d$/).count(),
      0,
      "one question, not a page of the last call's ask",
    )
    await settled(page)
    assert.equal(
      await slot.getByRole("button", { name: /^Platform/ }).getAttribute("aria-pressed"),
      "false",
      "nothing of the first call's form is picked on it",
    )
    await shot("second")

    await answerWith(slot, { pick: "Platform" })
    await thread.getByText("Second call: reviewed by Platform.", { exact: false }).waitFor({
      timeout: 90_000,
    })
    await shot("done")
    pass("a second call in one run is its own card, answered on its own")
  },
  { viewport: { width: 390, height: 844 }, dark: true },
)
