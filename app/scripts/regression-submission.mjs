// Regression: verify that concurrent sends to the same chat don't duplicate runs.
// Run with Vite on APP_URL and an isolated mock on MOCK_URL. Requires Playwright.
import assert from "node:assert/strict"
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright")

const app = process.env.APP_URL ?? "http://localhost:15173"
const mock = process.env.MOCK_URL ?? "http://localhost:18642"
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] })
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } })
  await page.goto(app)
  await page.evaluate(async (mock) => {
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
      id: "overlap-test",
      profileId: profile.id,
      title: "Overlap test",
      hermesSessionId: "overlap-test",
      createdAt: at,
      updatedAt: at,
      changedAt: at,
    })
  }, mock)
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

  await page.goto(`${app}/c/overlap-test`)
  await page.waitForSelector("textarea")

  // Send two messages as fast as possible without awaiting the first
  await page.evaluate(async () => {
    const { sendMessage } = await import("/src/lib/chat.ts")
    // Fire both without awaiting — tests the guard
    const p1 = sendMessage("overlap-test", "first message")
    const p2 = sendMessage("overlap-test", "second message")
    await Promise.allSettled([p1, p2])
  })

  // Wait for any runs to settle
  await page.waitForTimeout(3000)

  // Only one POST /v1/runs should have been made
  assert.ok(
    runPosts <= 1,
    `Expected at most 1 POST /v1/runs, got ${runPosts} — concurrent sends bypassed the guard`,
  )
  console.log(`PASS: ${runPosts} run POST(s) for concurrent sends (expected <= 1)`)

  // Verify only one assistant reply exists
  const replyCount = await page.evaluate(async () => {
    const { db } = await import("/src/lib/db.ts")
    const msgs = await db.messages.where("conversationId").equals("overlap-test").toArray()
    return msgs.filter((m) => m.role === "assistant").length
  })
  assert.ok(
    replyCount <= 1,
    `Expected at most 1 assistant reply, got ${replyCount} — guard allowed duplicate turn`,
  )
  console.log(`PASS: ${replyCount} assistant reply for concurrent sends (expected <= 1)`)
} finally {
  await browser.close()
}
