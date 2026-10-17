// The limit notice above the composer: a window's percentage is not the account running out. A
// spent allowance beside credits in hand shows nothing, a spent account with nothing behind it says
// so, a dismissal doesn't outlive the state it dismissed, and the reset line counts down ("Resets in
// 3d 4h", never a clock time). The Usage sheet names the model in a box of its own, above the meter.
import { app, assert, flow, mock, pass } from "./lib.mjs"

/** Moves the mock's account to `percent` for every later read; "" puts it back to the env's figure. */
const accountAt = (percent) =>
  fetch(`${mock}/api/plugins/memento/usage?percent=${encodeURIComponent(percent)}`).then((r) =>
    r.json(),
  )

const alerts = (page) => page.locator("[data-slot=alert]")
/** The notice's own text, or null while there is none. */
const notice = (page) => alerts(page).first().textContent().catch(() => null)
/** How long a notice that is going, or a drawer that is coming, takes to settle: Playwright counts
 *  a drawer visible from its first frame, which a screenshot would catch half off the screen. */
const settled = (page) => page.waitForTimeout(600)

// The screen the app paints the notice on: any chat, its provider being the bot's host model.
await flow("usage-limit", async ({ page, profileId, seed, until, shot }) => {
  const id = `usage-limit-${Math.random().toString(36).slice(2, 8)}`
  await seed([{ id, title: "Usage" }])
  // A plain chat hides the Context ring behind the Simplified chats switch; the sheet is what this
  // flow reads, so it comes off.
  await page.evaluate(async () => {
    const { db } = await import("/src/lib/db.ts")
    await db.settings.update("settings", { simplifiedChats: false })
  })
  // The dev server re-bundles its dependencies now and then and answers a reload with a blank page;
  // a flow's assertions can't tell that from the app being broken, so it loads again.
  const reload = async () => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      await page.reload({ waitUntil: "domcontentloaded" })
      try {
        await page.getByRole("button", { name: "Chat options" }).waitFor({ timeout: 15_000 })
        return
      } catch {
        if (attempt === 3) throw new Error("the app never rendered")
      }
    }
  }
  /** Waits for the app to hold the account the mock is serving: a read still in flight would
   *  otherwise leave the notice showing the figure before it, which is what these assertions are
   *  about. */
  const read = (provider, usedPercent) =>
    until(
      () =>
        page.evaluate(
          async ([id, provider, usedPercent]) => {
            const { db } = await import("/src/lib/db.ts")
            const usage = (await db.profiles.get(id))?.providerUsage
            const hit =
              usage?.provider === provider &&
              usage.windows.some((w) => Math.round(w.usedPercent) === usedPercent)
            return hit || null
          },
          [profileId, provider, usedPercent],
        ),
      20_000,
      `the ${provider} account read at ${usedPercent}%`,
    )

  // Approaching, on a bot whose provider reports periods only: the tightest window warns and names
  // itself, and its reset line is a countdown.
  await accountAt("94")
  await page.goto(`${app}/c/${id}`)
  await read("openrouter", 94)
  const approaching = await until(
    async () => {
      const text = await notice(page)
      return text?.startsWith("Approaching") ? text : null
    },
    10_000,
    "the composer's limit notice",
  )
  assert.match(approaching, /^Approaching \S+ Limit/, "the banner names the window it is about")
  assert.match(approaching, /Resets in \d/, "its reset line counts down rather than naming a clock")
  assert.doesNotMatch(approaching, /Resets at/, "a clock time is never the line under the banner")
  await shot("approaching")

  // The sheet's Context half: the model in a box of its own, the meter under it, and the token line
  // no longer repeating the model.
  await page.getByRole("button", { name: "View usage" }).click()
  const sheet = page.getByRole("dialog")
  await sheet.waitFor({ timeout: 5_000 })
  await settled(page)
  const sheetText = (await sheet.textContent()) ?? ""
  assert.ok(
    sheetText.includes("openrouter/anthropic/claude-sonnet-4.5"),
    `the model shows in a box of its own, as provider/model: the sheet reads ${sheetText.slice(0, 120)}`,
  )
  assert.ok(
    sheetText.indexOf("openrouter/") < sheetText.indexOf("Context window"),
    "the box sits above the meter it belongs to",
  )
  const tokens = (await sheet.locator("text=/ of .* tokens$/").first().textContent()) ?? ""
  assert.doesNotMatch(tokens, /openrouter/, "the meter's own line carries the count alone")
  assert.ok(
    sheetText.indexOf("Session") < sheetText.indexOf("Weekly"),
    "the sheet keeps the route's order",
  )
  await shot("sheet")
  await page.keyboard.press("Escape")
  await sheet.waitFor({ state: "hidden", timeout: 5_000 })

  // Dismissing the warning doesn't dismiss the account being out: the key carries the state.
  await page.getByRole("button", { name: "Dismiss" }).click()
  await until(async () => (await alerts(page).count()) === 0 || null, 5_000, "the dismissal")
  await reload()
  await settled(page)
  assert.equal(await alerts(page).count(), 0, "a dismissed notice stays dismissed")
  await accountAt("100")
  await reload()
  await read("openrouter", 100)
  const out = await until(
    async () => {
      const text = await notice(page)
      return text?.includes("Reached") ? text : null
    },
    10_000,
    "the notice for a window with nothing left",
  )
  assert.match(out, /Limit Reached/, "the same window, now spent, is not silenced by the dismissal")
  assert.match(out, /Resets in \d/, "and it still counts down to its reset")
  await shot("out")

  // A spent monthly allowance with credits in hand: nothing above the composer, and the sheet
  // showing both halves honestly.
  const pick = async (model) => {
    await page.getByRole("button", { name: /^Model:/ }).click()
    const picker = page.getByRole("dialog")
    await picker.getByRole("textbox", { name: "Search models" }).fill(model)
    await picker.getByRole("button", { name: new RegExp(`^${model} `) }).click()
    await picker.waitFor({ state: "hidden" })
  }
  await pick("gpt-oss:120b")
  await reload()
  await read("ollama-cloud", 100)
  await settled(page)
  assert.equal(
    await alerts(page).count(),
    0,
    "a spent allowance beside a credit balance is not the account being out",
  )
  await page.getByRole("button", { name: /^Context/ }).click()
  const credits = page.getByRole("dialog")
  await credits.waitFor({ timeout: 5_000 })
  await settled(page)
  const limits = (await credits.textContent()) ?? ""
  assert.match(limits, /Monthly\s*100% used/, "the spent allowance is still shown as spent")
  assert.match(limits, /\$25\.00/, "and the credits in hand are shown beside it")
  assert.ok(
    limits.indexOf("Credits") > limits.indexOf("Monthly"),
    "the route's order is the sheet's: the monthly allowance, then bought credits",
  )
  assert.ok(limits.includes("ollama-cloud/gpt-oss:120b"), "the box names the model the chat runs")
  await shot("credits")
  await page.keyboard.press("Escape")
  await credits.waitFor({ state: "hidden", timeout: 5_000 })

  // A phone, in the dark: the notice drops the window's name, and the sheet is a bottom sheet with
  // the box on top of it.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ colorScheme: "dark" })
  await pick("claude-sonnet-4-5")
  await accountAt("94")
  await reload()
  await read("anthropic", 94)
  const narrow = await until(
    async () => {
      const text = await notice(page)
      return text?.startsWith("Approaching Limit") ? text : null
    },
    10_000,
    "the composer's limit notice on a phone",
  )
  assert.match(narrow, /^Approaching Limit/, "a phone's banner leaves the window's name out")
  assert.match(narrow, /Resets in \d/)
  await shot("phone")
  await page.getByRole("button", { name: "View usage" }).click()
  const phone = page.getByRole("dialog")
  await phone.waitFor({ timeout: 5_000 })
  await settled(page)
  assert.ok(
    ((await phone.textContent()) ?? "").includes("claude-sonnet-4-5"),
    "the phone's sheet carries the box too",
  )
  await shot("phone-sheet")

  // Its light side, and a tablet: the banner names the window again from 768px up, while the sheet is
  // still a bottom sheet right up to the drawer breakpoint.
  await page.emulateMedia({ colorScheme: "light" })
  await settled(page)
  await shot("phone-light-sheet")
  await page.setViewportSize({ width: 768, height: 1024 })
  await settled(page)
  await shot("tablet-sheet")
  await page.keyboard.press("Escape")
  await phone.waitFor({ state: "hidden", timeout: 5_000 })
  await until(
    async () => {
      const text = await notice(page)
      return text?.startsWith("Approaching Session Limit") ? text : null
    },
    5_000,
    "the named notice back on a tablet",
  )
  await shot("tablet")
  await page.emulateMedia({ colorScheme: "dark" })
  await settled(page)
  await shot("tablet-dark")

  await accountAt("")
  pass("the notice followed the account: quiet with credits, warning near a limit, out without")
})
