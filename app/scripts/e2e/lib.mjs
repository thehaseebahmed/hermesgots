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

/** The signed-in account the wizard flows start from. */
const user = { id: "11111111-2222-4333-8444-555555555555", email: "tester@example.com" }

/**
 * A browser signed in to Identity with the sync, community and Identity routes stubbed, for a flow
 * that has to start before the wizard: `vault` is "missing" for a first run, "exists" for an account
 * that already has one, or a holder `{ data }` the flow seeds — that stub then behaves like the sync
 * function, serving what it holds and taking writes with etags, so a flow can watch a vault change
 * over several writes. `vaults` collects every vault PUT and `joins` every leaderboard join, and
 * `shot(name)` saves a screenshot. The caller closes `browser`.
 */
export async function signedIn({ width = 1440, dark = false, vault = "exists" } = {}) {
  const browser = await chromium.launch({ headless: !headed, args: ["--no-sandbox"] })
  const context = await browser.newContext({
    viewport: { width, height: width < 768 ? 844 : 768 },
    colorScheme: dark ? "dark" : "light",
  })
  const now = Math.floor(Date.now() / 1000)
  const expires = now + 3600
  const jwtPayload = Buffer.from(JSON.stringify({ sub: user.id, exp: expires })).toString(
    "base64url",
  )
  const session = {
    ...user,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    url: `${app}/.netlify/identity`,
    token: {
      access_token: `h.${jwtPayload}.s`,
      token_type: "bearer",
      expires_at: expires * 1000,
      refresh_token: "r",
    },
  }
  await context.addInitScript(
    (session) => localStorage.setItem("gotrue.user", JSON.stringify(session)),
    session,
  )
  await context.addCookies([{ name: "nf_jwt", value: session.token.access_token, url: app }])

  const vaults = []
  // A vault the flow seeds (`{ data }`) is served like the sync function's: written over its etag,
  // and what it holds changes with each write.
  const held = typeof vault === "object" ? vault : undefined
  let etag = "v1"
  await context.route("**/.netlify/functions/sync?**", async (route) => {
    const request = route.request()
    const doc = new URL(request.url()).searchParams.get("doc")
    if (request.method() === "PUT") {
      const body = request.postDataJSON()
      if (doc === "vault") {
        vaults.push(body.data)
        if (held) {
          if (body.etag && body.etag !== etag) return route.fulfill({ status: 412, json: {} })
          held.data = body.data
          etag = `v${Number(etag.slice(1)) + 1}`
        }
      }
      return route.fulfill({ json: { ok: true } })
    }
    const data = held ? held.data : {}
    if (doc === "vault" && (held ? data !== undefined : vault !== "missing"))
      return route.fulfill({ json: { data, etag } })
    return route.fulfill({ status: 404, json: { error: "missing" } })
  })

  const joins = []
  await context.route("**/.netlify/functions/community?**", async (route) => {
    const url = new URL(route.request().url())
    if (url.searchParams.get("route") !== "join") return route.fulfill({ json: { joined: false } })
    joins.push(route.request().method())
    return route.fulfill({
      json: { joined: true, login: "tester", totals: { today: 0, week: 0, month: 0 } },
    })
  })

  // Identity's settings say which sign-in providers are on; without GitHub the app is unavailable.
  await context.route("**/.netlify/identity/**", (route) =>
    route.request().url().endsWith("/settings")
      ? route.fulfill({
          json: { external: { github: true }, autoconfirm: false, disable_signup: false },
        })
      : route.fulfill({ status: 500, body: "" }),
  )

  const page = await context.newPage()
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  return {
    browser,
    context,
    page,
    session,
    vaults,
    joins,
    errors,
    async shot(name) {
      if (!shots) return
      mkdirSync(shots, { recursive: true })
      await page.screenshot({ path: `${shots}/${name}.png` })
    },
  }
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
    /**
     * Holds every request matching `pattern` back, so a placeholder can be looked at while the bytes
     * are still coming: `hold()` holds what arrives from then on, `release()` lets it all through. A
     * hold lasts 10s at most, so a flow that throws can't hang. With `fail`, a url ending in it is
     * answered as a file the host can't serve (which reads as "Couldn't load").
     */
    async held(pattern, fail) {
      const waiting = []
      let holding = false
      await page.route(pattern, async (route) => {
        if (fail && route.request().url().endsWith(fail))
          return route.fulfill({ status: 500, contentType: "text/plain", body: "no capture" })
        if (holding)
          await new Promise((done) => {
            waiting.push(done)
            setTimeout(done, 10_000)
          })
        await route.continue().catch(() => {})
      })
      return {
        hold: () => {
          holding = true
        },
        release: () => {
          holding = false
          for (const done of waiting.splice(0)) done()
        },
      }
    },
    /**
     * Records every skeleton the page renders from then on, with the box it took: a placeholder can
     * live for a single commit, which polling misses. `skeletons()` reads them, `stopSkeletons()`
     * ends the recording.
     */
    async watchSkeletons() {
      await page.evaluate(() => {
        const boxes = new Map()
        window.__skeletons = []
        window.__skeletonObserver = new MutationObserver(() => {
          for (const node of document.querySelectorAll("[data-slot=skeleton]")) {
            const box = node.getBoundingClientRect()
            boxes.set(node, {
              width: Math.round(box.width),
              height: Math.round(box.height),
              inButton: Boolean(node.closest("button")),
            })
          }
          window.__skeletons = [...boxes.values()]
        })
        window.__skeletonObserver.observe(document.body, { childList: true, subtree: true })
      })
    },
    skeletons() {
      return page.evaluate(() => window.__skeletons ?? [])
    },
    stopSkeletons() {
      return page.evaluate(() => window.__skeletonObserver?.disconnect())
    },
  }
}

export const pass = (text) => console.log(`PASS: ${text}`)

/**
 * Fails unless the element's text fits on one line. Its height is compared with a line, since a block
 * reports a single client rect whether it wraps or not.
 */
export async function assertOneLine(locator, what) {
  const { height, line } = await locator.evaluate((el) => ({
    height: el.getBoundingClientRect().height,
    line: parseFloat(getComputedStyle(el).lineHeight),
  }))
  assert.ok(height <= line * 1.3, `${what} is on one line (${height}px of ${line}px)`)
}
