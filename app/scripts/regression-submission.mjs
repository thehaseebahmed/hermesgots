// Regression: verify that concurrent sends to the same chat don't duplicate runs.
// Run with Vite on APP_URL and an isolated mock on MOCK_URL. Requires Playwright.
import assert from "node:assert/strict"
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright")
import { settleNav } from "./e2e/lib.mjs"

const app = process.env.APP_URL ?? "http://localhost:15173"
const mock = process.env.MOCK_URL ?? "http://localhost:18642"
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] })
// A session new to the mock, which keeps every session's transcript between runs: a fixed id read
// back the replies earlier runs left, so the count grew with each run rather than with this one.
const id = `overlap-${Math.random().toString(36).slice(2, 8)}`
try {
  const page = await settleNav(await browser.newPage({ viewport: { width: 1024, height: 768 } }))
  await page.goto(app)
  await page.evaluate(async ({ mock, id }) => {
    const { db } = await import("/src/lib/db.ts")
    const profiles = await db.profiles.toArray()
    const profile = profiles[0]
    await db.profiles.update(profile.id, {
      name: "Test bot",
      baseUrl: `${mock}/v1`,
      apiKey: "test-key",
      pluginChats: true,
    })
    await db.settings.put({ id: "settings", activeProfileId: profile.id, onboarded: true })
    const at = Date.now()
    await db.conversations.put({
      id,
      profileId: profile.id,
      title: "Overlap test",
      hermesSessionId: id,
      createdAt: at,
      updatedAt: at,
      changedAt: at,
    })
  }, { mock, id })
  await page.reload()
  await page
    .getByRole("navigation", { name: "Recents" })
    .getByText("Overlap test", { exact: true })
    .waitFor()

  // Count POST /v1/runs requests
  let runPosts = 0
  page.on("request", (req) => {
    if (req.method() === "POST" && new URL(req.url()).pathname === "/v1/runs") runPosts++
  })

  await page.goto(`${app}/c/${id}`)
  await page.waitForSelector("textarea")

  // Send two messages as fast as possible without awaiting the first
  await page.evaluate(async (id) => {
    const { sendMessage } = await import("/src/lib/chat.ts")
    // Fire both without awaiting — tests the guard
    const p1 = sendMessage(id, "first message")
    const p2 = sendMessage(id, "second message")
    await Promise.allSettled([p1, p2])
  }, id)

  // Until the reply is done and nothing waits behind it: a second run would have gone out by then.
  for (const end = Date.now() + 30_000; Date.now() < end; await page.waitForTimeout(100)) {
    const settled = await page.evaluate(async (id) => {
      const { db } = await import("/src/lib/db.ts")
      const rows = await db.messages.where("conversationId").equals(id).toArray()
      return (
        rows.some((m) => m.role === "assistant" && m.status === "done") &&
        !rows.some((m) => m.status === "queued" || m.status === "streaming")
      )
    }, id)
    if (settled) break
  }

  // Only one POST /v1/runs should have been made
  assert.ok(
    runPosts <= 1,
    `Expected at most 1 POST /v1/runs, got ${runPosts} — concurrent sends bypassed the guard`,
  )
  console.log(`PASS: ${runPosts} run POST(s) for concurrent sends (expected <= 1)`)

  // Verify only one assistant reply exists
  const replyCount = await page.evaluate(async (id) => {
    const { db } = await import("/src/lib/db.ts")
    const msgs = await db.messages.where("conversationId").equals(id).toArray()
    return msgs.filter((m) => m.role === "assistant").length
  }, id)
  assert.ok(
    replyCount <= 1,
    `Expected at most 1 assistant reply, got ${replyCount} — guard allowed duplicate turn`,
  )
  console.log(`PASS: ${replyCount} assistant reply for concurrent sends (expected <= 1)`)
} finally {
  await browser.close()
}
