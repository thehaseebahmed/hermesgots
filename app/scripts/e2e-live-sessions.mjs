// Run with Vite on APP_URL and an isolated mock on MOCK_URL. Requires Playwright.
// End to end over the live-run state: one runs/live poll shared by every screen, the sidebar and
// the project screen agreeing on a session that waits, and a reply reattaching after a reload.
import assert from "node:assert/strict"
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright")

const app = process.env.APP_URL ?? "http://localhost:15173"
const mock = process.env.MOCK_URL ?? "http://localhost:18642"
const shots = process.env.SHOTS_DIR
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const shot = (name) => shots && page.screenshot({ path: `${shots}/${name}.png` })
try {
  const liveReads = []
  page.on("request", (request) => {
    if (request.url().includes("/api/plugins/memento/runs/live")) liveReads.push(Date.now())
  })
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
    const at = Date.now()
    const id = Math.random().toString(36).slice(2, 8)
    await db.conversations.bulkPut([
      {
        id: "e2e-session",
        profileId: profile.id,
        title: "Log cleanup",
        hermesSessionId: `e2e-session-${id}`,
        projectId: "p_1a2b3c4d",
        createdAt: at - 1000,
        updatedAt: at,
        changedAt: at,
        draftAt: at,
        titleEdited: true,
      },
      {
        id: "e2e-chat",
        profileId: profile.id,
        title: "Long story",
        titleEdited: true,
        hermesSessionId: `e2e-chat-${id}`,
        createdAt: at - 1000,
        updatedAt: at,
        changedAt: at,
      },
    ])
    return profile.id
  }, mock)
  const composer = page.getByRole("textbox").last()
  const send = async (text) => {
    await composer.fill(text)
    await composer.press("Enter")
  }
  const waiting = page.getByRole("navigation", { name: "Waiting for input" })
  const group = (label) => page.getByRole("region", { name: label })

  // A project session that asks for an approval waits in the sidebar and on its project screen.
  await page.goto(`${app}/c/e2e-session`)
  await send("clean up the old logs")
  await page.getByRole("button", { name: "Allow once" }).waitFor({ timeout: 20_000 })
  await waiting.getByText("Log cleanup").waitFor({ timeout: 15_000 })
  await page.goto(`${app}/code/${profileId}/p_1a2b3c4d`)
  await group("Waiting on you").getByText("Log cleanup").waitFor({ timeout: 15_000 })
  await shot("waiting")

  // Only one runs/live poll runs however many screens read it: every 10s (RUNS_MS) at most, and
  // every 5 minutes while the mock's change stream is open (run the mock with MOCK_NO_EVENTS=1).
  liveReads.length = 0
  await page.waitForTimeout(25_000)
  assert.ok(
    liveReads.length <= 3,
    `runs/live read ${liveReads.length} times in 25s (expected <= 3)`,
  )
  console.log(`PASS: runs/live read ${liveReads.length} times in 25s on the project screen`)

  // Answering it moves the session out of waiting everywhere.
  await page.goto(`${app}/c/e2e-session`)
  await page.getByRole("button", { name: "Allow once" }).click()
  await page.getByText("Approved once").waitFor({ timeout: 15_000 })
  await page.goto(`${app}/code/${profileId}/p_1a2b3c4d`)
  await group("Idle").getByText("Log cleanup").waitFor({ timeout: 30_000 })
  assert.equal(await waiting.getByText("Log cleanup").count(), 0, "the sidebar stops waiting")
  await shot("idle")
  console.log("PASS: the sidebar and the project screen agree on waiting, then idle")

  // A reply still running when the page reloads picks its run up again and finishes.
  const lastReply = () =>
    page.evaluate(async () => {
      const { db } = await import("/src/lib/db.ts")
      const rows = await db.messages.where("conversationId").equals("e2e-chat").sortBy("createdAt")
      const last = rows.at(-1)
      return last?.role === "assistant"
        ? { status: last.status, length: last.content.length }
        : null
    })
  const until = async (check, ms, what) => {
    for (const end = Date.now() + ms; Date.now() < end; await page.waitForTimeout(500)) {
      const value = await check()
      if (value) return value
    }
    throw new Error(`Timed out waiting for ${what}`)
  }
  await page.goto(`${app}/c/e2e-chat`)
  await send("tell me a long story")
  const before = await until(
    async () => ((await lastReply())?.length ? lastReply() : null),
    20_000,
    "the reply to start",
  )
  assert.equal(before.status, "streaming", "the reply is still running when the page reloads")
  await page.reload()
  const after = await until(
    async () => {
      const reply = await lastReply()
      return reply?.status === "done" ? reply : null
    },
    60_000,
    "the reply to finish after the reload",
  )
  assert.ok(after.length > before.length, "the reply carried on after the reload")
  await shot("reattached")
  console.log(
    `PASS: a reply reattached after a reload and finished (${before.length} → ${after.length} chars)`,
  )
} catch (error) {
  await shot("failed")
  throw error
} finally {
  await browser.close()
}
