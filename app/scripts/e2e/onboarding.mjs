// The setup wizard's Join the leaderboard step: on by default, Continue joins the board, and a user
// who switches it off goes on to link bots without joining.
import { mkdirSync } from "node:fs"
import { app, assert, pass } from "./lib.mjs"

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright")
const shots = process.env.SHOTS_DIR
const headed = process.env.E2E_HEADED === "1"

// A signed-in GitHub user and an unlocked vault, so the wizard is the first thing on screen.
const USER = { id: "11111111-2222-4333-8444-555555555555", email: "tester@example.com" }
const now = Math.floor(Date.now() / 1000)
const expires = now + 3600
const jwtPayload = Buffer.from(JSON.stringify({ sub: USER.id, exp: expires })).toString("base64url")
const sessionUser = {
  id: USER.id,
  email: USER.email,
  app_metadata: { provider: "github" },
  user_metadata: { full_name: "Tester", avatar_url: "" },
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

async function scenario(name, { width, dark, joinOn }) {
  const browser = await chromium.launch({ headless: !headed, args: ["--no-sandbox"] })
  const context = await browser.newContext({
    viewport: { width, height: width < 768 ? 844 : 768 },
    colorScheme: dark ? "dark" : "light",
  })
  await context.addInitScript((user) => {
    localStorage.setItem("gotrue.user", JSON.stringify(user))
  }, sessionUser)
  await context.addCookies([{ name: "nf_jwt", value: sessionUser.token.access_token, url: app }])
  const joins = []
  await context.route("**/.netlify/functions/sync?**", async (route) => {
    const request = route.request()
    if (request.method() === "PUT") return route.fulfill({ json: { ok: true } })
    if (request.url().includes("doc=vault"))
      return route.fulfill({ json: { data: {}, etag: "v1" } })
    return route.fulfill({ status: 404, json: { error: "missing" } })
  })
  await context.route("**/.netlify/functions/community?**", async (route) => {
    const url = new URL(route.request().url())
    const route_ = url.searchParams.get("route")
    if (route_ === "join") {
      joins.push(route.request().method())
      return route.fulfill({
        json: { joined: true, login: "tester", totals: { today: 0, week: 0, month: 0 } },
      })
    }
    return route.fulfill({ json: { joined: false } })
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
  const shot = async (step) => {
    if (!shots) return
    mkdirSync(shots, { recursive: true })
    await page.screenshot({ path: `${shots}/${name}-${step}.png` })
  }
  try {
    await page.goto(app)
    await page.evaluate(
      async ({ user }) => {
        const { db, getSettings, saveSettings } = await import("/src/lib/db.ts")
        const settings = await getSettings()
        await saveSettings({ ...settings, onboarded: false })
        const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
          "encrypt",
          "decrypt",
        ])
        await db.vault.put({ id: "key", userId: user.id, key })
      },
      { user: sessionUser },
    )
    await page.reload()
    const toggle = page.getByRole("switch")
    await toggle.waitFor({ timeout: 15_000 })
    assert.equal(await toggle.getAttribute("aria-checked"), "true", "the switch starts on")
    await shot("community")
    if (!joinOn) await toggle.click()
    await page.getByRole("button", { name: "Continue" }).click()
    await page.getByRole("heading", { name: "Link your bots" }).waitFor({ timeout: 15_000 })
    await shot("link")
    assert.deepEqual(joins, joinOn ? ["POST"] : [], `join calls for ${name}`)
    assert.deepEqual(errors, [], `page errors for ${name}`)
    pass(`${name}: ${joinOn ? "joins the board" : "switched off, does not join"}`)
  } catch (error) {
    await shot("failed")
    throw error
  } finally {
    await browser.close()
  }
}

await scenario("onboarding-390-light-on", { width: 390, dark: false, joinOn: true })
await scenario("onboarding-390-dark-off", { width: 390, dark: true, joinOn: false })
await scenario("onboarding-1024-dark-on", { width: 1024, dark: true, joinOn: true })
