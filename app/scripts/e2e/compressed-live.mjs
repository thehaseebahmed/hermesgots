// The device that sent the turn, compressed mid-run: Hermes moves the chat on to a child session
// while this device streams it, and the turn has to stay under the user's hand — the reply reaching
// its end here, picking up again after a reload, and coming down when Stop is pressed — instead of
// the chat wedging on a reply that never finishes.
//
// This guards the app's side of that, against the mock. The keying that made it wedge on a real host
// is the plugin's, and no browser flow reaches it: the mock answers `runs/live` itself. That half is
// pinned by plugin/tests/test_session_run_keying.py, which fails when the walk goes back to the
// session API.
import { app, assert, compress, flow, pass, runId } from "./lib.mjs"

/** Sends and waits for the turn to stream; answers the reply so far. */
async function streaming(chatId, { send, lastReply, until }) {
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
  return started
}

async function compressed(name, { reload }) {
  await flow(name, async ({ page, seed, send, lastReply, until, shot }) => {
    const chatId = `e2e-livecomp-${runId()}`
    const sessionId = `memento-${chatId}`
    await seed([{ id: chatId, title: "Live compression", hermesSessionId: sessionId }])
    await page.goto(`${app}/c/${chatId}`)

    const started = await streaming(chatId, { send, lastReply, until })
    const rotated = await compress(sessionId, `${sessionId}-c1`)
    assert.equal(rotated.status, 200, "the host compresses the chat mid-run")

    if (reload) {
      // The app was closed and comes back to the chat it was on: the run has to be found again.
      await page.reload()
      await until(
        async () => ((await page.getByText("tell me a long story").count()) > 0 ? true : null),
        15_000,
        "the chat to come back after the reload",
      )
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

async function stopped() {
  await flow("compressed-live-stop", async ({ page, seed, send, lastReply, until }) => {
    const chatId = `e2e-livecomp-${runId()}`
    const sessionId = `memento-${chatId}`
    await seed([{ id: chatId, title: "Stop under compression", hermesSessionId: sessionId }])
    await page.goto(`${app}/c/${chatId}`)

    await streaming(chatId, { send, lastReply, until })
    const rotated = await compress(sessionId, `${sessionId}-c1`)
    assert.equal(rotated.status, 200, "the host compresses the chat mid-run")

    // The user's recovery, in the state that used to need it: Stop brings the turn down here too.
    const stop = page.getByRole("button", { name: "Stop" })
    await until(() => stop.isVisible(), 15_000, "Stop to be offered")
    await stop.click()
    const settled = await until(
      async () => {
        const reply = await lastReply(chatId)
        return reply && reply.status !== "streaming" && reply.length ? reply : null
      },
      20_000,
      "Stop to bring the turn down",
    )
    pass(`Stop settled the reply at ${settled.length} characters`)
  })
}

const failures = []
for (const [name, run] of [
  ["compressed-live", () => compressed("compressed-live", { reload: false })],
  ["compressed-live-reload", () => compressed("compressed-live-reload", { reload: true })],
  ["compressed-live-stop", stopped],
]) {
  try {
    await run()
  } catch (error) {
    failures.push(`${name}: ${error.message}`)
  }
}
if (failures.length) throw new Error(failures.join("\n\n"))
