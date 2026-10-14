// Shared setup for the e2e flows: a browser on the app (APP_URL) with its first bot pointed at the
// mock Hermes (MOCK_URL), and helpers to seed chats, send, wait and take screenshots. The CLI
// (`pnpm e2e`, `cli.mjs`) starts the servers and sets these variables; a flow also runs on its own.
import assert from "node:assert/strict"
import { mkdirSync } from "node:fs"

export { assert }
export const app = process.env.APP_URL ?? "http://localhost:15173"
export const mock = process.env.MOCK_URL ?? "http://localhost:18642"
const shots = process.env.SHOTS_DIR
const headed = process.env.E2E_HEADED === "1"
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright")

/** A short id so each run's sessions are new to the mock, which keeps its state between flows. */
export const runId = () => Math.random().toString(36).slice(2, 8)

/**
 * Opens the app with the bot set up, runs `body`, and closes the browser. A failure saves
 * `failed.png` (with SHOTS_DIR set) before it is thrown.
 */
export async function flow(name, body, { viewport = { width: 1440, height: 900 }, dark } = {}) {
  const browser = await chromium.launch({ headless: !headed, args: ["--no-sandbox"] })
  const page = await browser.newPage({ viewport, colorScheme: dark ? "dark" : "light" })
  const shot = async (step) => {
    if (!shots) return
    mkdirSync(shots, { recursive: true })
    const path = `${shots}/${name}-${step}.png`
    await page.screenshot({ path })
    return path
  }
  try {
    await page.goto(app)
    const profileId = await setUpBot(page)
    await body({ page, profileId, shot, ...helpers(page) })
  } catch (error) {
    await shot("failed").catch(() => {})
    throw error
  } finally {
    await browser.close()
  }
}

/** Points the first bot at the mock and skips the setup wizard; answers the bot's id. */
export async function setUpBot(page) {
  return page.evaluate(async (mock) => {
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
}

function helpers(page) {
  const composer = page.getByRole("textbox").last()
  return {
    /** Writes chats straight to Dexie: `{ id, title, projectId? }`, titled for good. */
    async seed(chats) {
      await page.evaluate(async (chats) => {
        const { db } = await import("/src/lib/db.ts")
        const profile = (await db.profiles.toArray())[0]
        const at = Date.now()
        await db.conversations.bulkPut(
          chats.map((chat) => ({
            profileId: profile.id,
            hermesSessionId: `${chat.id}-${Math.random().toString(36).slice(2, 8)}`,
            createdAt: at - 1000,
            updatedAt: at,
            changedAt: at,
            titleEdited: true,
            ...(chat.projectId ? { draftAt: at } : {}),
            ...chat,
          })),
        )
      }, chats)
    },
    /** Types into the composer and sends. */
    async send(text) {
      await composer.fill(text)
      await composer.press("Enter")
    },
    /** The chat's newest message when it's a reply: its status and length. */
    lastReply(chatId) {
      return page.evaluate(async (id) => {
        const { db } = await import("/src/lib/db.ts")
        const last = (await db.messages.where("conversationId").equals(id).sortBy("createdAt")).at(
          -1,
        )
        return last?.role === "assistant"
          ? { status: last.status, length: last.content.length }
          : null
      }, chatId)
    },
    /** The pull requests the app has stored for a chat. */
    stored(chatId) {
      return page.evaluate(async (id) => {
        const { db } = await import("/src/lib/db.ts")
        return (await db.conversations.get(id))?.prs ?? null
      }, chatId)
    },
    /**
     * Polls `check` until it answers something truthy. Use it over `page.waitForFunction` with an
     * async predicate, whose promise is truthy and so ends the wait at once.
     */
    async until(check, ms, what) {
      for (const end = Date.now() + ms; Date.now() < end; await page.waitForTimeout(500)) {
        const value = await check()
        if (value) return value
      }
      throw new Error(`Timed out after ${ms / 1000}s waiting for ${what}`)
    },
  }
}

export const pass = (text) => console.log(`PASS: ${text}`)
