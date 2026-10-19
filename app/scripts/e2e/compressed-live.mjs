// The device that sent the turn, compressed mid-run: Hermes moves the chat on to a child session
// while this device streams it, and the reply has to reach its end here — streaming on, and picked
// up again after a reload — instead of the chat wedging on a reply that never finishes. The
// compressed-run flow covers the other device; this is the one that started the session.
import { app, assert, compress, flow, pass, runId } from "./lib.mjs"

async function compressed(name, { reload }) {
  await flow(name, async ({ page, seed, send, lastReply, until, shot }) => {
    const chatId = `e2e-livecomp-${runId()}`
    const sessionId = `memento-${chatId}`
    const childId = `${sessionId}-c1`
    await seed([{ id: chatId, title: "Live compression", hermesSessionId: sessionId }])
    await page.goto(`${app}/c/${chatId}`)

    await send("tell me a long story")
    const started = await until(
      async () => {
        const reply = await lastReply(chatId)
        return reply?.status === "streaming" && reply.length ? reply : null
      },
      25_000,
      "the reply to start",
    )
    pass(`the turn runs (${started.length} characters so far)`)

    const rotated = await compress(sessionId, childId)
    assert.equal(rotated.status, 200, "the host compresses the chat mid-run")

    if (reload) {
      // The app was closed and comes back to the chat it was on: the run has to be found again.
      await page.reload()
      await page.waitForTimeout(2000)
    }

    const done = await until(
      async () => {
        const reply = await lastReply(chatId)
        return reply?.status === "done" ? reply : null
      },
      45_000,
      reload ? "the reply to finish after the reload" : "the reply to finish after compression",
    )
    assert.ok(done.length > started.length, `the reply carried on (${done.length} characters)`)
    await shot("done")
    pass(`the reply finished after ${reload ? "the reload" : "compression"} (${done.length} chars)`)
  })
}

const failures = []
for (const reload of [false, true]) {
  try {
    await compressed(reload ? "compressed-live-reload" : "compressed-live", { reload })
  } catch (error) {
    failures.push(error.message)
  }
}
if (failures.length) throw new Error(failures.join("\n\n"))
