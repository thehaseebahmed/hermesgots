// A code session returned to mid-run keeps offering its steer: the offer is this screen's capability,
// not whether it has joined the run's events.
import { app, assert, flow, pass, queueOf, runId, startRun } from "./lib.mjs"

const STORY = "tell me a long story"
const STEER = "Steer the response…"
const QUEUE = "Queue a message…"

await flow(
  "steer-offer",
  async ({ page, seed, until }) => {
    const chatId = `e2e-steer-${runId()}`
    await seed([{ id: chatId, title: "Steer offer", projectId: "p_1a2b3c4d" }])
    await page.evaluate(async () => {
      const { db } = await import("/src/lib/db.ts")
      await db.settings.update("settings", {
        steerByDefault: true,
        developer: true,
        chatNext: true,
      })
    })
    await page.addInitScript(() => {
      window.__placeholders = []
      const take = () => {
        const value = document.querySelector('textarea[aria-label="Message"]')?.placeholder
        if (value) window.__placeholders.push({ at: Date.now(), value })
      }
      window.addEventListener("DOMContentLoaded", () => {
        take()
        window.__sampler = setInterval(take, 50)
      })
    })
    const session = await page.evaluate(async (id) => {
      const { db } = await import("/src/lib/db.ts")
      return (await db.conversations.get(id)).hermesSessionId
    }, chatId)

    // Return through Code, as a phone does: the screen opens onto a run it has not joined yet.
    const startedAt = Date.now()
    await startRun(session, STORY)
    await page.goto(`${app}/code`)
    await page.getByText("Steer offer").first().click()
    await page.waitForURL(`**/c/${chatId}`)

    const placeholder = () =>
      page.evaluate(() => document.querySelector('textarea[aria-label="Message"]')?.placeholder)
    await until(
      async () => page.evaluate(() => Boolean(document.querySelector("[data-chat-next]"))),
      15_000,
      "the chat-next thread",
    )
    await until(async () => (await placeholder()) === STEER, 20_000, "the steer it returned to")

    for (const words of ["one more thing", "and another"]) {
      await page.evaluate(
        async ([id, text]) => {
          const { queueMessage } = await import("/src/lib/chat.ts")
          await queueMessage(id, text, [])
        },
        [chatId, words],
      )
    }
    const queue = await until(
      async () => {
        const view = await queueOf(session)
        const ran =
          view.sent.length === 2 && view.sent.every((sent) => sent.run_status === "completed")
        return ran && view.items.length === 0 ? view : null
      },
      90_000,
      "the two queued turns to run to their end",
    )
    const samples = await page.evaluate(() => {
      clearInterval(window.__sampler)
      return window.__placeholders
    })

    const seen = [...new Set(samples.map((sample) => sample.value))]
    assert.ok(samples.length > 0, "the field was seen at all")
    assert.deepEqual(
      samples.filter((sample) => sample.value === QUEUE),
      [],
      `a running reply is never called a queue: ${JSON.stringify(seen)}`,
    )
    const starts = [startedAt, ...queue.sent.map((sent) => sent.sent_at)]
    for (const [index, from] of starts.entries()) {
      const to = starts[index + 1] ?? Date.now()
      const inside = samples.filter((sample) => sample.at >= from && sample.at < to)
      assert.ok(
        inside.some((sample) => sample.value === STEER),
        `run ${index + 1} offered the steer: ${JSON.stringify(seen)}`,
      )
    }
    pass(
      `the offer stood through ${starts.length} runs and never read a queue (${JSON.stringify(seen)})`,
    )
  },
  { viewport: { width: 390, height: 844 } },
)
