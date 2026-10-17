// Settings: replacing a recovery code. This device holds no data key and the account has no passkey,
// so the app asks for the current code; the new wrapper is written before the new code is shown and
// the old one is retired only once the new one has been copied, over the version it just wrote. Both
// steps are the one dialog, and the code fits a line on a phone while a small one wraps it — at a
// hyphen, between two of its groups rather than through one.
import {
  app,
  assert,
  assertBreakAtHyphen,
  assertOneLine,
  pass,
  signedIn,
  setUpBot,
} from "./lib.mjs"

const USER_ID = "11111111-2222-4333-8444-555555555555"

async function scenario(name, { width, dark, narrow = false }) {
  // A vault holder the stub serves and takes writes to, seeded below the way a returning device's
  // is: a code-wrapped key on the server, its unwrapped copy on this device.
  const held = {}
  const { browser, context, page, vaults, errors, shot } = await signedIn({
    width,
    dark,
    vault: held,
  })
  try {
    await page.goto(app)
    const seeded = await page.evaluate(async (id) => {
      const vault = await import("/src/lib/vault.ts")
      const { db } = await import("/src/lib/db.ts")
      const dataKey = await vault.generateDataKey()
      const code = vault.newRecoveryCode()
      const doc = vault.newVault()
      doc.wrappers.push(await vault.recoveryWrapper(dataKey, code))
      await db.vault.put({ id: "key", userId: id, key: await vault.lockDown(dataKey) })
      return { doc, code, iv: doc.wrappers[0].iv }
    }, USER_ID)
    held.data = seeded.doc
    await setUpBot(page)
    await page.reload()

    await page.goto(`${app}/settings/account`)
    const rotate = page.getByRole("button", { name: "New recovery code" })
    await rotate.waitFor({ timeout: 15_000 })
    // Unlocking may have added the vault's inbox; from here nothing is written until it's asked for.
    await page.waitForTimeout(1000)
    const before = vaults.length

    // Backing out of the dialog asks for nothing and writes nothing.
    await rotate.click()
    await page.getByText("Enter your current recovery code").waitFor({ timeout: 15_000 })
    await page.getByRole("button", { name: "Cancel" }).click()
    await page.getByText("Enter your current recovery code").waitFor({ state: "detached" })
    assert.equal(vaults.length, before, `cancelling writes nothing, for ${name}`)

    await rotate.click()
    // Nothing here can unwrap the key, so the dialog asks for the code before anything is written.
    await page.getByText("Enter your current recovery code").waitFor({ timeout: 15_000 })
    await page.waitForTimeout(500)
    await shot(`${name}-ask`)
    // Which dialog this is, so that the one showing the new code can be checked against it.
    await page.evaluate(() => {
      document.querySelector("[role=alertdialog]").dataset.step = "ask"
    })
    assert.equal(vaults.length, before, `nothing written before the current code, for ${name}`)
    // Submitting with Enter, twice, as an impatient user does. The write is held back so the second
    // lands while the first is still in flight: a disabled button must not be the only thing
    // stopping a second rotation.
    let heldBack = 0
    await context.route("**/.netlify/functions/sync?**", async (route) => {
      heldBack += 1
      await new Promise((resolve) => setTimeout(resolve, 400))
      await route.fallback()
    })
    const field = page.getByRole("textbox", { name: "Current recovery code" })
    await field.fill(seeded.code)
    await field.press("Enter")
    await field.press("Enter")

    await page.getByText("Your new recovery code").waitFor({ timeout: 15_000 })
    assert.equal(
      await page.locator("[role=alertdialog][data-step=ask]").count(),
      1,
      `the same dialog shows the new code, for ${name}`,
    )
    const shown = (await page.locator("code").first().innerText()).trim()
    assert.match(shown, /^[0-9A-Z]{5}(-[0-9A-Z]{5}){4}$/, `a new recovery code for ${name}`)
    assert.notEqual(shown, seeded.code, `the new code differs from the old, for ${name}`)
    // One line wherever there's room for it; a small phone wraps it, and it wraps at a hyphen.
    if (narrow) {
      const lines = await assertBreakAtHyphen(
        page.locator("[role=alertdialog] code"),
        `the new code for ${name}`,
      )
      assert.ok(lines.length > 1, `the new code for ${name} wraps on a small phone`)
    } else {
      await assertOneLine(page.locator("[role=alertdialog] code"), `the new code for ${name}`)
    }
    await shot(`${name}-new-code`)

    // The old code still works until the new one is handled: both wrappers are on the server.
    assert.equal(
      vaults.length,
      before + 1,
      `one write to show a new code, however often it's asked for, for ${name}`,
    )
    assert.ok(heldBack > 0, `the write was held back for ${name} (${heldBack})`)
    assert.deepEqual(
      (vaults[before].wrappers ?? []).map((wrapper) => wrapper.kind),
      ["recovery", "recovery"],
      `the old wrapper is still there beside the new one, for ${name}`,
    )

    const save = page.getByRole("button", { name: "Use this code" })
    assert.equal(await save.isDisabled(), true, "the new code has to be copied first")
    await page.getByRole("button", { name: "Copy recovery code" }).click()
    for (let i = 0; i < 20 && (await save.isDisabled()); i++) await page.waitForTimeout(50)
    assert.equal(await save.isDisabled(), false, "copying the new code lets it be used")
    await save.click()

    // The old wrapper is dropped over the version the first write left, and the new one stays.
    for (let i = 0; i < 20 && vaults.length < before + 2; i++) await page.waitForTimeout(100)
    assert.equal(
      vaults.length,
      before + 2,
      `the old code is retired in a second write, for ${name}`,
    )
    const wrappers = vaults[before + 1].wrappers ?? []
    assert.equal(wrappers.length, 1, `one wrapper left for ${name}`)
    assert.equal(wrappers[0].kind, "recovery", `the code left is a recovery code, for ${name}`)
    assert.notEqual(wrappers[0].iv, seeded.iv, `the old wrapper is the one dropped, for ${name}`)
    assert.equal(
      held.data.wrappers.length,
      1,
      `the vault served now holds one wrapper, for ${name}`,
    )
    await shot(`${name}-done`)

    assert.deepEqual(errors, [], `page errors for ${name}`)
    pass(`${name}: a new recovery code replaces the old one once it's copied`)
  } catch (error) {
    await shot(`${name}-failed`)
    throw error
  } finally {
    await browser.close()
  }
}

await scenario("recovery-code-rotation-390-light", { width: 390, dark: false })
await scenario("recovery-code-rotation-1024-dark", { width: 1024, dark: true })
await scenario("recovery-code-rotation-320-light", { width: 320, dark: false, narrow: true })
