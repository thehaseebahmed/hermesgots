// A chat whose run waits on a question, on a host whose event stream keeps dying under it — the phone
// asleep, a proxy closing idle connections, a slow subscriber a host lets go of. The stream is only
// how the page watches the run, so the question is the run's to settle: its form stays in the
// composer, the thread keeps its one waiting line, and the answer still lands.
import {
  answerQuestion,
  assert,
  flow,
  LOOKS,
  openChatNext,
  pass,
  settled,
  watchQuestion,
} from "./lib.mjs"

const CHOICE = "Older than 90 days"
/** How long the card is watched while the mock keeps cutting the stream (`MOCK_DROP_EVENTS_MS`). */
const HELD_MS = 20_000

const body =
  (look) =>
  async ({ page, seed, send, shot, watchText, sawText, stopText }) => {
    await watchText("No answer")
    await openChatNext({ page, seed }, { id: "e2e-question-drop", title: "Waiting question" })

    await send("ask me something")
    const form = page.locator("[data-slot=composer-slot]").getByText("Question", { exact: true })
    await form.waitFor({ timeout: 30_000 })
    await settled(page)
    const thread = page.locator("[aria-label=Messages]")
    await thread.getByText("Waiting for your answer", { exact: true }).first().waitFor({
      timeout: 20_000,
    })

    // Held across several streams, each cut by the host a second and a half in. A blink is what this
    // watches for, so the page counts the frames: an observer sees every one, a poll sees whichever it
    // lands on.
    await watchQuestion(page)
    await page.waitForTimeout(HELD_MS)
    const lost = await page.evaluate(() => window.__questionLost())
    assert.equal(lost.form, 0, "the form never left the composer")
    assert.equal(lost.line, 0, "the thread never stopped saying it waits")
    assert.equal(await sawText(), false, "the waiting question never read as unanswered")
    assert.equal(
      await page.getByRole("button", { name: "Ask again" }).count(),
      0,
      "nothing is owed",
    )
    await shot("held")

    await answerQuestion(page, CHOICE)
    await shot("answered")
    await stopText()
    pass(`a waiting question outlives the stream that brought it (${look})`)
  }

for (const { look, options } of LOOKS) await flow(`question-drop-${look}`, body(look), options)
