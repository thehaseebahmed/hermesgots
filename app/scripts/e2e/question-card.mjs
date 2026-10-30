// The question the agent asks, on the new chat screen (chat-next): its form is the composer's, so
// the thread says only that it waits — reported once as the same question drawn twice, a card in
// the thread beside the form under it. Answered, the thread's card reads the answer, and keeps
// reading it after a reload from the host's transcript. That the card reads the answer the moment
// it is given, rather than a beat later when the transcript lands, is the reducer's claim
// (`scripts/test-chat-next-state.tsx`): here the mock's transcript answers too promptly to hold
// the window open, so this flow proves the shape of the thread, not the instant.
import { answerQuestion, assert, flow, openChatNext, pass, settled } from "./lib.mjs"

const QUESTION = "Which logs should I count as old?"
const ANSWER = "Older than 90 days"

for (const [width, dark] of [
  [1440, false],
  [390, true],
]) {
  const look = width < 768 ? "phone-dark" : "laptop"
  await flow(
    `question-card-${look}`,
    async ({ page, seed, send, shot }) => {
      await openChatNext({ page, seed }, { id: "e2e-question-card", title: "Question card" })

      await send("ask me something")
      const choice = page.getByRole("button", { name: new RegExp(ANSWER) })
      await choice.first().waitFor({ timeout: 30_000 })
      await settled(page)

      const thread = page.locator("[aria-label=Messages]")
      const waiting = thread.getByText("Waiting for your answer", { exact: true })
      // The line is the call's, so it lands with the call a beat after the form.
      await waiting.waitFor({ timeout: 10_000 })
      assert.equal(await waiting.count(), 1, "one waiting line in the thread")
      assert.equal(
        await thread.getByText(QUESTION, { exact: false }).count(),
        0,
        "the question is the composer's, not the thread's",
      )
      assert.equal(
        await thread.locator("[data-slot=card]").filter({ hasText: QUESTION }).count(),
        0,
        "no card of the question's own in the thread",
      )
      assert.equal(
        await page.locator("[data-slot=composer-slot]").getByText("Question", { exact: true }).count(),
        1,
        "the form is in the composer slot",
      )
      await shot("asked")

      await answerQuestion(page, ANSWER)
      assert.equal(
        await thread.getByRole("button", { name: "Ask again" }).count(),
        0,
        "nothing is owed",
      )
      await shot("answered")

      // A reload reads the same answer from the host's own transcript.
      await page.reload()
      await thread.getByText("Answered", { exact: true }).waitFor({ timeout: 20_000 })
      pass(`a question is the composer's alone, and reads answered once given (${look})`)
    },
    { viewport: { width, height: width < 768 ? 844 : 900 }, dark },
  )
}
