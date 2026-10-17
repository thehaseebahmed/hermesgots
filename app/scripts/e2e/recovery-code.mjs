// The setup wizard's sync step: turning on sync always mints a recovery code, a passkey is only an
// addition, nothing is written until the code has been copied, and Continue waits for that copy.
// A passkey that can't be made — a prompt backed out of, or an authenticator without PRF — is a
// quiet choice to go on with the code alone, and a device that can't hold one isn't offered one.
import { app, assert, pass, signedIn } from "./lib.mjs"

async function scenario(name, { width, dark, credentials, passkeys = true }) {
  // No vault on the account yet: this is a first run.
  const { browser, context, page, vaults, errors, shot } = await signedIn({
    width,
    dark,
    vault: "missing",
  })
  try {
    // What the browser's own passkey prompt would do, with no real authenticator: reject as a
    // cancelled prompt does, or answer with a credential that has no PRF.
    if (credentials) await context.addInitScript(credentials)
    // A browser with no WebAuthn at all, as a WebView or an older browser is.
    if (!passkeys) await context.addInitScript(() => delete window.PublicKeyCredential)
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
    // A device that can hold a passkey is offered one, but never required to take it.
    const add = page.getByRole("button", { name: "Add a passkey" })
    assert.equal(await add.count(), passkeys ? 1 : 0, `the passkey button for ${name}`)

    // With the prompt stubbed, taking it fails the way a cancelled or PRF-less one does: the step
    // says nothing and goes on with the code. (Unstubbed, headless Chromium refuses on an IP origin,
    // which is a real failure and says so.)
    if (credentials) {
      await add.click()
      await page.waitForTimeout(500)
      assert.equal(
        await page.locator("[data-sonner-toast]").count(),
        0,
        `${name} stays quiet about a passkey it couldn't make`,
      )
      assert.equal(await cont.isDisabled(), true, "Continue still waits for the copy")
    }

    await page.getByRole("button", { name: "Copy recovery code" }).click()
    // The clipboard write settles asynchronously, so the button enables a tick later.
    for (let i = 0; i < 20 && (await cont.isDisabled()); i++) await page.waitForTimeout(50)
    assert.equal(await cont.isDisabled(), false, "copying the code lets setup go on")

    // Nothing is written until the code has been handled, so a tab closed here leaves no vault
    // wrapped by a code nobody saw.
    assert.equal(vaults.length, 0, `no vault written before the code is copied, for ${name}`)

    await cont.click()
    await page.getByRole("heading", { name: "Join the leaderboard" }).waitFor({ timeout: 15_000 })

    // Continuing wrote a vault wrapped by the code alone: no passkey joined it, not even a half one
    // from a prompt that failed.
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

/** The prompt closed without a passkey, as a tap outside it or a cancel does. */
const cancelled = () => {
  navigator.credentials.create = () =>
    Promise.reject(
      new DOMException("The operation either timed out or was not allowed.", "NotAllowedError"),
    )
}

/** An authenticator that makes a passkey but can't evaluate PRF, so it can't wrap the key. */
const noPrf = () => {
  navigator.credentials.create = async () => ({
    id: "test",
    rawId: new Uint8Array([1, 2, 3]).buffer,
    type: "public-key",
    getClientExtensionResults: () => ({}),
  })
}

await scenario("recovery-code-390-light", { width: 390, dark: false })
await scenario("recovery-code-1024-dark", { width: 1024, dark: true })
await scenario("recovery-code-390-light-cancelled", {
  width: 390,
  dark: false,
  credentials: cancelled,
})
await scenario("recovery-code-1024-dark-no-prf", { width: 1024, dark: true, credentials: noPrf })
await scenario("recovery-code-390-light-no-passkey", { width: 390, dark: false, passkeys: false })
