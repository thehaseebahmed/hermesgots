// Run with Vite on APP_URL and an isolated mock on MOCK_URL. Requires Playwright.
// Smoke test of the screens that read the host on a timer: Code, a project, Routines and a chat,
// each loading its data and leaving no errors in the console.
import assert from "node:assert/strict"
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright")

const app = process.env.APP_URL ?? "http://localhost:15173"
const mock = process.env.MOCK_URL ?? "http://localhost:18642"
const shots = process.env.SHOTS_DIR
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] })
const errors = []
for (const viewport of [
  { width: 390, height: 844 },
  { width: 1024, height: 768 },
]) {
  const page = await browser.newPage({ viewport })
  const shot = (name) =>
    shots && page.screenshot({ path: `${shots}/${name}-${viewport.width}.png` })
  page.on("pageerror", (error) => errors.push(`${viewport.width}px: ${error.message}`))
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`${viewport.width}px: ${message.text()}`)
  })
  try {
    await page.goto(app)
    const profileId = await page.evaluate(async (mock) => {
      const { db } = await import("/src/lib/db.ts")
      const profile = (await db.profiles.toArray())[0]
      await db.profiles.update(profile.id, {
        name: "Test bot",
        baseUrl: `${mock}/v1`,
        apiKey: "mock-key",
        pluginChats: true,
      })
      await db.settings.put({ id: "settings", activeProfileId: profile.id, onboarded: true })
      return profile.id
    }, mock)

    await page.goto(`${app}/code`)
    await page.getByText("Smart Home", { exact: true }).first().waitFor({ timeout: 15_000 })
    await shot("code")

    await page.goto(`${app}/code/${profileId}/p_1a2b3c4d`)
    await page.getByRole("tab", { name: "Sessions" }).waitFor({ timeout: 15_000 })
    await page.getByRole("button", { name: "New session" }).waitFor({ timeout: 15_000 })
    await shot("project")

    await page.goto(`${app}/routines`)
    await page.getByText("Inbox triage").first().waitFor({ timeout: 15_000 })
    await shot("routines")

    await page.goto(app)
    await page.getByRole("textbox").last().fill("hello")
    await page.getByRole("textbox").last().press("Enter")
    await page.waitForURL("**/c/**", { timeout: 15_000 })
    const chatId = new URL(page.url()).pathname.split("/").at(-1)
    for (let tries = 0; ; tries++) {
      const status = await page.evaluate(async (id) => {
        const { db } = await import("/src/lib/db.ts")
        const rows = await db.messages.where("conversationId").equals(id).sortBy("createdAt")
        return rows.at(-1)?.role === "assistant" ? rows.at(-1).status : null
      }, chatId)
      if (status === "done") break
      assert.ok(tries < 40, `the reply finished (last status ${status})`)
      await page.waitForTimeout(500)
    }
    await shot("chat")
    console.log(`PASS: Code, a project, Routines and a chat load at ${viewport.width}px`)
  } catch (error) {
    await shot("failed")
    throw error
  } finally {
    await page.close()
  }
}
await browser.close()
// A failed fetch the browser logs on its own (a 404 with no CORS headers) isn't the app's error.
const real = errors.filter((e) => !/Failed to load resource|CORS policy/.test(e))
assert.deepEqual(real, [], "no errors in the console")
console.log("PASS: no errors in the console")
