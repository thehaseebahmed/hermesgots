// The setup wizard's sync step: turning on sync always mints a recovery code, a passkey is only an
// addition, nothing is written until the code has been copied, and Continue waits for that copy.
import { app, assert, pass, signedIn } from "./lib.mjs"

async function scenario(name, { width, dark }) {
  // No vault on the account yet: this is a first run.
  const { browser, page, vaults, errors, shot } = await signedIn({ width, dark, vault: "missing" })
  try {
    await page.goto(app)
    const turnOn = page.getByRole("button", { name: "Turn on sync" })
    await turnOn.waitFor({ timeout: 15_000 })
    await turnOn.click()

    await page.getByRole("heading", { name: "Your recovery code" }).waitFor({ timeout: 15_000 })
    const code = await page.locator("code").first().innerText()
    assert.match(code.trim(), /^[0-9A-Z]{5}(-[0-9A-Z]{5}){4}$/, `a recovery code for ${name}`)
    await shot(`${name}-code`)

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
    await shot(`${name}-community`)
    assert.deepEqual(errors, [], `page errors for ${name}`)
    pass(`${name}: sync starts with a recovery code, the passkey only offered`)
  } catch (error) {
    await shot(`${name}-failed`)
    throw error
  } finally {
    await browser.close()
  }
}

await scenario("recovery-code-390-light", { width: 390, dark: false })
await scenario("recovery-code-1024-dark", { width: 1024, dark: true })
