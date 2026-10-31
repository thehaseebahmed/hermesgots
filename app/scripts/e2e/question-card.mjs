// The question the agent asks, on the new chat screen (chat-next): its form is the composer's, so
// the thread says only that it waits — reported once as the same question drawn twice, a card in
// the thread beside the form under it. Answered, the thread's card reads the answer, and keeps
// reading it after a reload from the host's transcript. That the card reads the answer the moment
// it is given, rather than a beat later when the transcript lands, is the reducer's claim
// (`scripts/test-chat-next-state.tsx`): here the mock's transcript answers too promptly to hold
// the window open, so this flow proves the shape of the thread, not the instant.
import { answerQuestion, answerWith, assert, flow, openChatNext, pass, settled } from "./lib.mjs"

const QUESTION = "Which logs should I count as old?"
const ANSWER = "Older than 90 days"

const SERIES = [
  { ask: "Which environment should this run against?", pick: "staging" },
  { ask: "Which services are in scope?", pick: "api" },
  { ask: "What should the change be called?", type: "nightly-log-rotation" },
  { ask: "How should existing data be handled?", pick: "Migrate it in place" },
  { ask: "Who should review it?", pick: "Platform" },
]

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

      // A question with more choices than a phone screen holds: the card stops at half the screen,
      // so its own buttons stay on it and the choices scroll inside it.
      await send("ask a lot")
      await page
        .getByRole("button", { name: /Older than 90 days, across every service/ })
        .first()
        .waitFor({ timeout: 30_000 })
      await settled(page)

      const slot = page.locator("[data-slot=composer-slot]")
      const box = await slot.locator("[data-slot=card]").first().boundingBox()
      const screen = page.viewportSize()
      assert.ok(box, "the question is the composer's")
      assert.ok(
        box.height <= screen.height / 2 + 1,
        `the card stops at half the screen: ${Math.round(box.height)} of ${screen.height}`,
      )
      const footer = await slot.locator("[data-slot=card-footer]").first().boundingBox()
      assert.ok(
        footer && footer.y + footer.height <= screen.height,
        "its own buttons are still on the screen",
      )
      assert.ok(
        await slot
          .locator('[data-slot="card-content"]')
          .first()
          .evaluate((one) => one.scrollHeight > one.clientHeight + 1),
        "the choices scroll inside the card",
      )
      assert.equal(
        await page.getByRole("button", { name: "Skip", exact: true }).count(),
        1,
        "and a question that asked too much can be skipped",
      )
      await shot("long")

      // One call that asked five questions: the host serves them one prompt at a time, and each
      // prompt names the question it asks while the call's whole list rides along. The form must ask
      // that one — never the first question again — and the run must carry every answer with the
      // chat left open.
      await page.getByRole("button", { name: "Skip", exact: true }).click()
      await thread
        .getByText("No answer came, so I'll count anything older than 90 days.", { exact: false })
        .waitFor({ timeout: 30_000 })
      // The walk is the same at either width — a call's questions are asked one prompt at a time —
      // so it runs on the wide case alone and the phone case keeps the checks the layout decides.
      if (width >= 768) {
        await send("ask five")
        for (const [at, question] of SERIES.entries()) {
          await slot.getByText(question.ask, { exact: false }).waitFor({ timeout: 30_000 })
          await settled(page)
          for (const earlier of SERIES.slice(0, at))
            assert.equal(
              await slot.getByText(earlier.ask, { exact: false }).count(),
              0,
              `question ${at + 1} asks itself, not "${earlier.ask}"`,
            )
          await answerWith(slot, question)
          await slot
            .getByText(question.ask, { exact: false })
            .waitFor({ state: "detached", timeout: 30_000 })
        }
        await thread
          .getByText("Got 5 of 5 answers.", { exact: false })
          .waitFor({ timeout: 30_000 })
        const card = thread.locator("[data-slot=card]").filter({ hasText: SERIES[0].ask })
        for (const question of SERIES) {
          assert.ok(
            await card.getByText(question.ask, { exact: false }).count(),
            `the call's card holds "${question.ask}"`,
          )
          assert.ok(
            await card.getByText(question.pick ?? question.type, { exact: true }).count(),
            `the call's card holds the answer to "${question.ask}"`,
          )
        }
        await shot("series")
      }
      pass(
        `a question is the composer's alone and reads answered once given (${look})${
          width >= 768 ? ", and a call's five questions are asked and answered in turn" : ""
        }`,
      )
    },
    { viewport: { width, height: width < 768 ? 844 : 900 }, dark },
  )
}
