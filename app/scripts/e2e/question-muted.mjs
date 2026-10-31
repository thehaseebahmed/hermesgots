// A call that asks five questions, on a host that raises every one after the first while nothing is
// listening: those requests go out on nobody's stream, and the run's status is the only place they
// can be read. The chat stays open — no reload — so each form has to come back from the page's own
// status read.
import { answerWith, assert, flow, openChatNext, pass, settled } from "./lib.mjs"

const SERIES = [
  { ask: "Which environment should this run against?", pick: "staging" },
  { ask: "Which services are in scope?", pick: "api" },
  { ask: "What should the change be called?", type: "nightly-log-rotation" },
  { ask: "How should existing data be handled?", pick: "Migrate it in place" },
  { ask: "Who should review it?", pick: "Platform" },
]

await flow(
  "question-muted",
  async ({ page, seed, send, shot }) => {
    await openChatNext({ page, seed }, { id: "e2e-question-muted", title: "Muted questions" })
    const slot = page.locator("[data-slot=composer-slot]")
    const thread = page.locator("[aria-label=Messages]")

    await send("ask five")
    for (const [at, question] of SERIES.entries()) {
      // The first question's request reached the page; the rest were published to nobody, so each
      // of these waits is the page finding the prompt on the run's own status.
      await slot.getByText(question.ask, { exact: false }).waitFor({ timeout: 30_000 })
      await settled(page)
      for (const earlier of SERIES.slice(0, at))
        assert.equal(
          await slot.getByText(earlier.ask, { exact: false }).count(),
          0,
          `question ${at + 1} asks itself, not "${earlier.ask}"`,
        )
      if (at === 1) await shot("second")
      await answerWith(slot, question)
      await slot
        .getByText(question.ask, { exact: false })
        .waitFor({ state: "detached", timeout: 30_000 })
    }

    await thread
      .getByText("Got 5 of 5 answers.", { exact: false })
      .waitFor({ timeout: 30_000 })
    assert.equal(
      await thread.getByText("No answer", { exact: true }).count(),
      0,
      "nothing was left owed",
    )
    pass("prompts the stream never carried come back from the run's status, with the chat open")
  },
  { viewport: { width: 390, height: 844 }, dark: true },
)
