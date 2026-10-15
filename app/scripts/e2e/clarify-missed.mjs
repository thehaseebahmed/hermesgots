// A question whose window closed on the user (the host times it out) stays in the thread as a "No
// answer" card, with the question it asked, and a way to have the agent ask it again: nothing
// resumes the expired call, so the retry starts a new turn, which asks afresh.
import { app, assert, flow, mock, pass, runId } from "./lib.mjs"

const endQuestion = (outcome = "timed_out") =>
  fetch(`${mock}/__mock/clarify`, { method: "POST", body: JSON.stringify({ outcome }) })

// The card has to read right on a laptop and on a phone in the dark.
for (const [width, dark] of [
  [1440, false],
  [390, true],
]) {
  const look = width < 768 ? "phone-dark" : "laptop"
  await flow(
    `clarify-missed-${look}`,
    async ({ page, seed, send, shot }) => {
      const chat = `e2e-clarify-missed-${runId()}`
      await seed([{ id: chat, title: "Missed question" }])
      await page.goto(`${app}/c/${chat}`)

      await send("ask me something")
      const asked = page.getByRole("button", { name: /Older than 90 days/ })
      await asked.first().waitFor({ timeout: 20_000 })
      await endQuestion()
      // The abandoned question card leaves the composer, the reply carries on with no answer, and
      // the thread's own card says so.
      await page.getByText("No answer came, so I'll count anything older than 90 days.").waitFor({
        timeout: 20_000,
      })
      await page.getByText("No answer", { exact: true }).waitFor({ timeout: 20_000 })
      assert.equal(
        await page.getByRole("textbox", { name: "Type your answer" }).count(),
        0,
        "the question leaves the composer",
      )
      await shot("no-answer")

      // Asking again goes as the user's own message, which the agent answers by asking afresh.
      await page.getByRole("button", { name: "Ask again" }).click()
      await page.getByText("Ask me that again.").waitFor({ timeout: 10_000 })
      await asked.first().waitFor({ timeout: 20_000 })
      await shot("asked-again")
      pass(`a missed question can be asked again (${look})`)
    },
    { viewport: { width, height: width < 768 ? 844 : 900 }, dark },
  )
}
