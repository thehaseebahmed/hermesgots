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
    const profile = (await db.profiles.toArray())[0]
    await db.profiles.update(profile.id, {
      name: "Test bot",
      baseUrl: `${mock}/v1`,
      apiKey: "mock-key",
    })
    await db.settings.put({ id: "settings", activeProfileId: profile.id, onboarded: true })
    const at = Date.now()
    await db.conversations.bulkPut(
      ["one", "two"].map((id) => ({
        id,
        profileId: profile.id,
        title: `Chat ${id}`,
        hermesSessionId: `draft-${id}`,
        createdAt: at - 1000,
        updatedAt: at,
        changedAt: at,
      })),
    )
  }, mock)
  const composer = page.getByRole("textbox").last()
  const text = () => composer.inputValue()
  // The composer can remount once its chat has loaded, so wait for the text to settle.
  const shows = (value) =>
    page.waitForFunction(
      (value) => [...document.querySelectorAll("textarea")].at(-1)?.value === value,
      value,
      { timeout: 5000 },
    )

  // A new chat's text survives leaving for Settings and coming back.
  await page.goto(app)
  await composer.fill("half a new chat")
  await page.waitForTimeout(600)
  await page.goto(`${app}/settings`)
  await page.goto(app)
  await shows("half a new chat")

  // Each chat keeps its own text, across switching and a reload.
  await page.goto(`${app}/c/one`)
  await composer.fill("draft for one")
  await page.getByRole("navigation", { name: "Recents" }).getByText("Chat two").click()
  await page.waitForURL("**/c/two")
  await page.waitForTimeout(500)
  assert.equal(await text(), "", "another chat starts from its own text")
  await composer.fill("draft for two")
  await page.waitForTimeout(600)
  await page.reload()
  await shows("draft for two")
  await page.goto(`${app}/c/one`)
  await shows("draft for one")

  // An unsent session saved as a draft keeps its text, shown in Code.
  await page.evaluate(async () => {
    const { db } = await import("/src/lib/db.ts")
    const profile = (await db.profiles.toArray())[0]
    const at = Date.now()
    await db.conversations.put({
      id: "session",
      profileId: profile.id,
      title: "New session",
      hermesSessionId: "draft-session",
      projectId: "p_1a2b3c4d",
      createdAt: at,
      updatedAt: at,
      changedAt: at,
    })
  })
  await page.goto(`${app}/c/session`)
  await composer.fill("a session plan")
  await page.getByRole("button", { name: "Back to Code" }).click()
  await page.getByRole("button", { name: "Save draft" }).click()
  await page.waitForURL("**/code")
  await page.getByText("a session plan").waitFor()
  await page.getByText("a session plan").click()
  await page.waitForURL("**/c/session")
  await shows("a session plan")

  // Sending clears it.
  await page.goto(`${app}/c/one`)
  await shows("draft for one")
  await composer.press("Enter")
  await page.waitForTimeout(800)
  const left = await page.evaluate(async () => {
    const { db } = await import("/src/lib/db.ts")
    return (await db.drafts.get("c:one"))?.text
  })
  assert.equal(left, undefined, "a sent message leaves no draft")
  console.log("PASS: composer drafts are kept per chat and cleared on send")
} finally {
  await browser.close()
}
