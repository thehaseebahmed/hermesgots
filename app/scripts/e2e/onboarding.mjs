// The setup wizard's Join the leaderboard step: on by default, Continue joins the board, and a user
// who switches it off goes on to link bots without joining.
import { app, assert, pass, signedIn } from "./lib.mjs"

async function scenario(name, { width, dark, joinOn }) {
  // A signed-in user with an unlocked vault, so the wizard is the first thing on screen.
  const { browser, page, session, joins, errors, shot } = await signedIn({ width, dark })
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
      { user: session },
    )
    await page.reload()
    const toggle = page.getByRole("switch")
    await toggle.waitFor({ timeout: 15_000 })
    assert.equal(await toggle.getAttribute("aria-checked"), "true", "the switch starts on")
    await shot(`${name}-community`)
    if (!joinOn) await toggle.click()
    await page.getByRole("button", { name: "Continue" }).click()
    await page.getByRole("heading", { name: "Link your bots" }).waitFor({ timeout: 15_000 })
    await shot(`${name}-link`)
    assert.deepEqual(joins, joinOn ? ["POST"] : [], `join calls for ${name}`)
    assert.deepEqual(errors, [], `page errors for ${name}`)
    pass(`${name}: ${joinOn ? "joins the board" : "switched off, does not join"}`)
  } catch (error) {
    await shot(`${name}-failed`)
    throw error
  } finally {
    await browser.close()
  }
}

await scenario("onboarding-390-light-on", { width: 390, dark: false, joinOn: true })
await scenario("onboarding-390-dark-off", { width: 390, dark: true, joinOn: false })
await scenario("onboarding-1024-dark-on", { width: 1024, dark: true, joinOn: true })
