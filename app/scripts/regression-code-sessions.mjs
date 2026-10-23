// Run with Vite on APP_URL and an isolated mock on MOCK_URL. Requires Playwright.
import assert from "node:assert/strict"
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright")
import { launch, settleNav } from "./e2e/lib.mjs"

const app = process.env.APP_URL ?? "http://localhost:15173"
const mock = process.env.MOCK_URL ?? "http://localhost:18642"
const browser = await launch(chromium, true)
try {
  const page = await settleNav(await browser.newPage({ viewport: { width: 1024, height: 768 } }))
  await page.goto(app)
  await page.evaluate(async (mock) => {
    const { db } = await import("/src/lib/db.ts")
    const profiles = await db.profiles.toArray()
    const profile = profiles[0]
    await db.profiles.update(profile.id, {
      name: "Test bot",
      baseUrl: `${mock}/v1`,
      apiKey: "mock-key",
      pluginChats: true,
    })
    await db.settings.put({ id: "settings", activeProfileId: profile.id, onboarded: true })
    const at = Date.now()
    await db.conversations.bulkPut([
      {
        id: "plain",
        profileId: profile.id,
        title: "Plain chat",
        hermesSessionId: "plain-test",
        createdAt: at - 1000,
        updatedAt: at,
        changedAt: at,
      },
      {
        id: "code",
        profileId: profile.id,
        title: "Code session",
        hermesSessionId: "code-test",
        projectId: "p_1a2b3c4d",
        createdAt: at - 1000,
        updatedAt: at + 100,
        changedAt: at + 100,
        draftAt: at,
      },
    ])
  }, mock)
  await page.reload()
  await page
    .getByRole("navigation", { name: "Recents" })
    .getByText("Plain chat", { exact: true })
    .waitFor()
  assert.equal(
    await page
      .getByRole("navigation", { name: "Recents" })
      .getByText("Code session", { exact: true })
      .count(),
    0,
    "Code sessions must not appear under bot chats",
  )
  await page.goto(`${app}/code`)
  await page.getByText("Code session", { exact: true }).waitFor()
  await page.getByText("Code session", { exact: true }).click()
  await page.waitForURL("**/c/code")
  console.log("PASS: sessions stay in Code and open from Code")
} finally {
  await browser.close()
}
