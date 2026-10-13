// A reply still streaming when the page reloads picks its run up again and finishes.
import { app, assert, flow, pass } from "./lib.mjs"

await flow("reattach", async ({ page, seed, send, lastReply, until, shot }) => {
  await seed([{ id: "e2e-reattach", title: "Long story" }])
  await page.goto(`${app}/c/e2e-reattach`)
  await send("tell me a long story")
  const before = await until(
    async () => {
      const reply = await lastReply("e2e-reattach")
      return reply?.length ? reply : null
    },
    20_000,
    "the reply to start",
  )
  assert.equal(before.status, "streaming", "the reply is still running when the page reloads")
  await page.reload()
  const after = await until(
    async () => {
      const reply = await lastReply("e2e-reattach")
      return reply?.status === "done" ? reply : null
    },
    60_000,
    "the reply to finish after the reload",
  )
  assert.ok(after.length > before.length, "the reply carried on after the reload")
  await shot("finished")
  pass(
    `the reply reattached after a reload and finished (${before.length} → ${after.length} chars)`,
  )
})
