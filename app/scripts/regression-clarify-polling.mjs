// Requires Vite and MOCK_BLOCK_RUN_EVENTS=1 mock on isolated ports, plus Playwright.
import assert from "node:assert/strict"
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright")
const app = process.env.APP_URL ?? "http://localhost:15173"
const mock = process.env.MOCK_URL ?? "http://localhost:18642"
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] })
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } })
  page.on("pageerror", (error) => console.log("Page error", error.message))
  let answered = false
  let staleReads = 0
  await page.route("**/api/sessions/*/messages?*", async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    if (answered) {
      staleReads++
      // Hermes may not have persisted the answer when the first post-submit poll arrives.
      for (const row of body.data ?? []) if (row.tool_name === "clarify") row.content = null
    }
    await route.fulfill({ response, json: body })
  })
  await page.route("**/v1/runs/*", async (route) => {
    if (route.request().method() !== "GET" || route.request().url().includes("/events"))
      return route.continue()
    const response = await route.fetch()
    const body = await response.json()
    if (answered && staleReads < 2 && body.status === "completed") body.status = "running"
    await route.fulfill({ response, json: body })
  })
  await page.route("**/v1/runs/*/events*", (route) => route.abort("failed"))
  await page.goto(app)
  await page.evaluate(async (mock) => {
    const { db, createConversation } = await import("/src/lib/db.ts")
    const profile = (await db.profiles.toArray())[0]
    await db.profiles.update(profile.id, {
      baseUrl: `${mock}/v1`,
      apiKey: "mock-key",
      pluginChats: true,
    })
    await db.settings.put({ id: "settings", activeProfileId: profile.id, onboarded: true })
    const c = await createConversation(profile.id, {
      title: "Clarify polling",
      projectId: "p_1a2b3c4d",
    })
    window.testConversation = c.id
  }, mock)
  const id = await page.evaluate(() => window.testConversation)
  await page.goto(`${app}/c/${id}`)
  await page.getByRole("textbox", { name: "Message" }).fill("ask")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await page.getByRole("button", { name: /Older than 90 days/ }).waitFor({ timeout: 30000 })
  await page.getByRole("button", { name: /Older than 90 days/ }).click()
  answered = true
  await page.getByRole("button", { name: "Send", exact: true }).click()
  for (let attempt = 0; attempt < 60; attempt++) {
    const done = await page.evaluate(async (id) => {
      const messages = await (await import("/src/lib/db.ts")).getMessages(id)
      return (
        messages.some((m) => m.role === "assistant") &&
        !messages.some((m) => m.status === "streaming")
      )
    }, id)
    if (done) break
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  assert.ok(staleReads >= 2, "Test must exercise post-answer transcript polling")
  const result = await page.evaluate(async (id) => {
    const { getMessages } = await import("/src/lib/db.ts")
    const m = (await getMessages(id)).findLast((m) => m.role === "assistant")
    return m.tools.findLast((t) => t.tool === "clarify").result
  }, id)
  assert.equal(
    JSON.parse(result ?? "{}").responses?.[0]?.user_response,
    "Older than 90 days",
    "Polling must preserve the settled answer",
  )
  await page.getByText("Answered", { exact: true }).waitFor()
  await page.reload()
  await page.getByText("Answered", { exact: true }).waitFor()
  console.log("PASS: settled clarify answer survives two stale polls, completion, and reload")
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  for (const context of browser.contexts())
    for (const page of context.pages()) await page.unrouteAll({ behavior: "ignoreErrors" })
  await browser.close()
}
