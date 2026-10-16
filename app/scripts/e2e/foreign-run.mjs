// A run started somewhere else (another device, the plugin's queue) shows the same on the session
// screen as in Code: the open chat finds it on the host and follows it to the end.
import { app, assert, flow, mock, pass } from "./lib.mjs"

await flow("foreign-run", async ({ page, seed, send, lastReply, until, shot }) => {
  await seed([{ id: "e2e-foreign", title: "Elsewhere", projectId: "p_1a2b3c4d" }])
  await page.goto(`${app}/c/e2e-foreign`)
  await send("hello there")
  await until(
    async () => (await lastReply("e2e-foreign"))?.status === "done",
    20_000,
    "the first reply to finish",
  )

  // Another device sends the next turn, straight to the host.
  const sessionId = await page.evaluate(async () => {
    const { db } = await import("/src/lib/db.ts")
    return (await db.conversations.get("e2e-foreign")).hermesSessionId
  })
  const started = await fetch(`${mock}/v1/runs`, {
    method: "POST",
    headers: { Authorization: "Bearer mock-key", "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId, input: "tell me a long story" }),
  })
  assert.equal(started.status, 202, "the host starts the run")

  const region = page.getByRole("region", { name: "Working" })
  await page.goto(`${app}/code`)
  await region.getByText("Elsewhere").waitFor({ timeout: 15_000 })
  pass("Code shows the session working")

  await page.getByText("Elsewhere").first().click()
  await page.waitForURL("**/c/e2e-foreign")
  await shot("open")
  const streaming = await until(
    async () => {
      const reply = await lastReply("e2e-foreign")
      return reply?.status === "streaming" ? reply : null
    },
    20_000,
    "the open session to show the run as streaming",
  )
  pass(`the session screen follows the run (${streaming.length} characters so far)`)

  const done = await until(
    async () => {
      const reply = await lastReply("e2e-foreign")
      return reply?.status === "done" ? reply : null
    },
    60_000,
    "the run to finish on the session screen",
  )
  assert.ok(done.length > streaming.length, "the reply carried on to its end")
  const replies = await page.evaluate(async () => {
    const { db } = await import("/src/lib/db.ts")
    const all = await db.messages.where("conversationId").equals("e2e-foreign").toArray()
    return all.filter((m) => m.role === "assistant").length
  })
  assert.equal(replies, 2, "each turn has one reply")
  pass("the reply finished with no duplicate")
})
