// The setup wizard's sync step: turning on sync always mints a recovery code, a passkey is only an
// addition, and Continue stays disabled until the code has been copied.
import { mkdirSync } from "node:fs"
import { app, assert, pass } from "./lib.mjs"

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright")
const shots = process.env.SHOTS_DIR
const headed = process.env.E2E_HEADED === "1"

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

async function scenario(name, { width, dark }) {
  const browser = await chromium.launch({ headless: !headed, args: ["--no-sandbox"] })
  const context = await browser.newContext({
    viewport: { width, height: width < 768 ? 844 : 768 },
    colorScheme: dark ? "dark" : "light",
  })
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: app })
  await context.addInitScript((user) => {
    localStorage.setItem("gotrue.user", JSON.stringify(user))
  }, sessionUser)
  await context.addCookies([{ name: "nf_jwt", value: sessionUser.token.access_token, url: app }])
  const vaults = []
  await context.route("**/.netlify/functions/sync?**", async (route) => {
    const request = route.request()
    if (request.method() === "PUT") {
      const body = request.postDataJSON()
      if (new URL(request.url()).searchParams.get("doc") === "vault") vaults.push(body.data)
      return route.fulfill({ json: { ok: true } })
    }
    // No vault yet: this is a first run.
    return route.fulfill({ status: 404, json: { error: "missing" } })
  })
  await context.route("**/.netlify/functions/community?**", (route) =>
    route.fulfill({ json: { joined: false } }),
  )
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
    const turnOn = page.getByRole("button", { name: "Turn on sync" })
    await turnOn.waitFor({ timeout: 15_000 })
    await turnOn.click()

    await page.getByRole("heading", { name: "Your recovery code" }).waitFor({ timeout: 15_000 })
    const code = await page.locator("code").first().innerText()
    assert.match(code.trim(), /^[0-9A-Z]{5}(-[0-9A-Z]{5}){4}$/, `a recovery code for ${name}`)
    await shot("code")

    const cont = page.getByRole("button", { name: "Continue" })
    assert.equal(await cont.isDisabled(), true, "Continue waits for the code to be copied")
    // A device that can hold a passkey is offered one, but never requires it.
    assert.ok(
      await page.getByRole("button", { name: "Add a passkey" }).isVisible(),
      "the passkey is offered beside the code",
    )

    await page.getByRole("button", { name: "Copy recovery code" }).click()
    // The clipboard write settles asynchronously, so the button enables a tick later.
    for (let i = 0; i < 20 && (await cont.isDisabled()); i++) await page.waitForTimeout(50)
    assert.equal(await cont.isDisabled(), false, "copying the code lets setup go on")

    // Nothing is written until the code has been handled, so a tab closed here leaves no vault
    // wrapped by a code nobody saw.
    assert.equal(vaults.length, 0, `no vault written before the code is copied, for ${name}`)

    await cont.click()
    await page.getByRole("heading", { name: "Join the leaderboard" }).waitFor({ timeout: 15_000 })

    // Continuing wrote a vault wrapped by the code alone: no passkey prompt was answered.
    assert.equal(vaults.length, 1, `one vault written for ${name}`)
    const wrappers = vaults[0].wrappers ?? []
    assert.deepEqual(
      wrappers.map((wrapper) => wrapper.kind),
      ["recovery"],
      `the vault holds only the recovery wrapper for ${name}`,
    )
    await shot("community")
    assert.deepEqual(errors, [], `page errors for ${name}`)
    pass(`${name}: sync starts with a recovery code, the passkey only offered`)
  } catch (error) {
    await shot("failed")
    throw error
  } finally {
    await browser.close()
  }
}

await scenario("recovery-code-390-light", { width: 390, dark: false })
await scenario("recovery-code-1024-dark", { width: 1024, dark: true })
