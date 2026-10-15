// A notification about a question opens a chat this device hasn't loaded: the question reads as
// waiting from the first frame (never "No answer"), and its form follows. Then the same for a chat
// that hasn't reached this device at all: the notification's link waits for sync instead of
// landing on the home screen. Main showed "No answer" until the run was followed, and sent the
// second one home.
import { app, assert, flow, mock, pass, runId } from "./lib.mjs"

const auth = { Authorization: "Bearer mock-key", "Content-Type": "application/json" }

/** Another device's turn that asks a question, started straight on the host. */
async function askElsewhere(sessionId) {
  const res = await fetch(`${mock}/v1/runs`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ session_id: sessionId, input: "ask me before you delete anything" }),
  })
  assert.equal(res.status, 202, "the host starts the run")
  for (const end = Date.now() + 20_000; Date.now() < end;) {
    const rows = await fetch(`${mock}/api/sessions/${sessionId}/messages?order=latest&limit=5`, {
      headers: auth,
    }).then((r) => r.json())
    const last = rows.data?.at(-1)
    if (last?.tool_calls?.some((call) => call.function?.name === "clarify")) return
    await new Promise((done) => setTimeout(done, 300))
  }
  throw new Error("The question never reached the transcript")
}

await flow("question-from-push", async ({ page, seed, shot }) => {
  /** Opens the notification's link and watches until the question's form shows. */
  async function openFromPush(sessionId, chatId) {
    await page.goto(`${app}/s/${sessionId}`)
    const form = page.getByRole("button", { name: "Older than 90 days" })
    for (const end = Date.now() + 25_000; ;) {
      assert.equal(
        await page.getByText("No answer", { exact: true }).count(),
        0,
        "the waiting question never reads as unanswered",
      )
      if (await form.isVisible().catch(() => false)) break
      assert.ok(Date.now() < end, "the question's form shows")
      await page.waitForTimeout(150)
    }
    assert.ok(page.url().endsWith(`/c/${chatId}`), `the link opens the chat (${page.url()})`)
  }

  // A chat synced here whose transcript this device hasn't loaded.
  const synced = `e2e-ask-${runId()}`
  const syncedSession = `memento-${synced}`
  await seed([{ id: synced, title: "Asked on the laptop", hermesSessionId: syncedSession }])
  await askElsewhere(syncedSession)
  await openFromPush(syncedSession, synced)
  await shot("synced")
  pass("a question in a chat not loaded here shows as waiting, then its form")

  // A chat started on another device that hasn't reached this one yet.
  // The chat list answers slowly, as a host over a tunnel does: the link has to wait for it.
  await page.route("**/api/plugins/memento/chats", async (route) => {
    await new Promise((done) => setTimeout(done, 2500))
    await route.continue().catch(() => {})
  })
  const fresh = `e2e-ask-new-${runId()}`
  const freshSession = `memento-${fresh}`
  await askElsewhere(freshSession)
  const now = Date.now()
  const record = {
    at: now,
    value: {
      title: "Started on the laptop",
      titleEdited: true,
      hermesSessionId: freshSession,
      createdAt: now - 60_000,
      updatedAt: now,
    },
  }
  const saved = await fetch(`${mock}/api/plugins/memento/chats`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ chats: { [fresh]: record } }),
  })
  assert.equal(saved.status, 200, "the other device's chat list reaches the host")
  await openFromPush(freshSession, fresh)
  await page.unroute("**/api/plugins/memento/chats")
  await shot("fresh")
  pass("a question in a chat not on this device yet opens it once synced")
})
