// A steer is offered while a run is listed, not only while this page has joined its events: a code
// session returned to mid-run, with turns queued behind it, must not swap the field between
// "Steer the response…" and "Queue a message…" as one run hands over to the next (the send reaches
// the run by its id, `steerTurn` → the plugin's queue action, so the join is not the fact).
import { app, assert, flow, pass, runId, startRun } from "./lib.mjs"

const STORY = "tell me a long story"

await flow(
  "steer-offer",
  async ({ page, seed }) => {
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
    // chat-next needs a host that reports a Hermes version (ADR 0065).
    await page.route("**/health", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify({ status: "ok", platform: "hermes-agent", version: "0.22.5" }),
      }),
    )
    const session = await page.evaluate(async (id) => {
      const { db } = await import("/src/lib/db.ts")
      return (await db.conversations.get(id)).hermesSessionId
    }, chatId)

    // A run started elsewhere, then the session returned to: what this page opens onto is a run it
    // has not joined yet.
    await startRun(session, STORY)
    await page.goto(`${app}/code`)
    await page.waitForTimeout(2000)
    await page.goto(`${app}/c/${chatId}`)
    await page.waitForTimeout(2000)

    await page.evaluate(() => {
      window.__placeholders = []
      const take = () => {
        const field = document.querySelector('textarea[aria-label="Message"]')
        const value = field?.placeholder
        if (value && window.__placeholders.at(-1) !== value) window.__placeholders.push(value)
      }
      take()
      window.__sampler = setInterval(take, 50)
    })
    // Two more turns wait on the plugin's queue, so the runs hand over back to back — the moment the
    // offer used to drop to "Queue a message…".
    for (const words of ["one more thing", "and another"]) {
      await page.evaluate(
        async ([id, text]) => {
          const { queueMessage } = await import("/src/lib/chat.ts")
          await queueMessage(id, text, [])
        },
        [chatId, words],
      )
      await page.waitForTimeout(200)
    }
    await page.waitForTimeout(25_000)
    const seen = await page.evaluate(() => {
      clearInterval(window.__sampler)
      return window.__placeholders
    })

    assert.ok(
      seen.includes("Steer the response…"),
      `the run a session is returned to is steerable: ${JSON.stringify(seen)}`,
    )
    assert.deepEqual(
      seen.filter((value) => value === "Queue a message…"),
      [],
      `a listed run is never called a queue: ${JSON.stringify(seen)}`,
    )
    pass(`the field kept offering the steer across the turns it followed (${JSON.stringify(seen)})`)
  },
  { viewport: { width: 390, height: 844 } },
)
