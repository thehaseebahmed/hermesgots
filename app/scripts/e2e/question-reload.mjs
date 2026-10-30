// A chat whose run already waits on a question, opened again — the phone coming back to it. The host
// keeps no replay of the request, so the question is recovered from the run's own status: its form is
// in the composer within a second of the chat drawing, and the thread says only that it waits —
// never "No answer" with Ask again, not even for the frame the thread is still loading into.
import { answerQuestion, assert, flow, LOOKS, openChatNext, pass, settled } from "./lib.mjs"

const QUESTION = "Which logs should I count as old?"
const CHOICE = "Older than 90 days"

const body =
  (look) =>
  async ({ page, seed, send, shot, watchText, sawText, stopText }) => {
    await watchText("No answer")
    await openChatNext({ page, seed }, { id: "e2e-question-reload", title: "Waiting question" })

    await send("ask me something")
    await page
      .getByRole("button", { name: new RegExp(CHOICE) })
      .first()
      .waitFor({ timeout: 30_000 })
    await settled(page)

    await page.reload()
    await page.locator("[data-chat-next]").first().waitFor({ timeout: 20_000 })
    const opened = Date.now()
    const form = page.locator("[data-slot=composer-slot]").getByText("Question", { exact: true })
    for (const end = opened + 10_000; ;) {
      if (await form.isVisible().catch(() => false)) break
      assert.ok(Date.now() < end, "the question's form comes back")
      await page.waitForTimeout(50)
    }
    const took = Date.now() - opened
    assert.ok(took < 1_000, `the form is back within a second (${took}ms)`)

    const thread = page.locator("[aria-label=Messages]")
    assert.equal(
      await thread.getByText("Waiting for your answer", { exact: true }).count(),
      1,
      "one waiting line in the thread",
    )
    assert.equal(await sawText(), false, "the waiting question never read as unanswered")
    assert.equal(
      await page.getByRole("button", { name: "Ask again" }).count(),
      0,
      "nothing is owed",
    )
    assert.equal(
      await thread.getByText(QUESTION, { exact: false }).count(),
      0,
      "the question is the form's, not the thread's",
    )
    await shot("form")

    await answerQuestion(page, CHOICE)
    await shot("answered")
    await stopText()
    pass(`a waiting question comes back from the run's status on a reload (${look})`)
  }

for (const { look, options } of LOOKS) await flow(`question-reload-${look}`, body(look), options)
