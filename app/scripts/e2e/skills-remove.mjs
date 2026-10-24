// Remove's geometry: the confirmation a removal asks first with, opened from the skill's own sheet at a
// phone's and a tablet's width, light and dark — a centred dialog on screen at both. Which origins offer
// Remove, what a cancel sends, what a confirmed removal leaves and what the host's refusal says are
// `test-skills-tab.tsx`'s; this is the box the question is drawn in.
import { app, assert, flow, mock, pass, settled } from "./lib.mjs"

/** The confirmation's own ceiling (`AlertDialogContent`'s `max-w-xs`), which no width may pass. */
const DIALOG_MAX = 320

const run = async ({ page, profileId, shot }) => {
  const screen = `/settings/bots/${profileId}/skills`
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  const row = (name) => page.locator(`[data-skill="${name}"]`)
  const sheet = () => page.locator("[data-skill-sheet]")
  const dialog = () => page.getByRole("alertdialog")

  try {
    // The interactions the box needs: the tab, the skill's own sheet, and the question on it.
    await page.goto(`${app}${screen}`)
    await row("hub-audit").waitFor({ timeout: 15_000 })
    await settled(page)
    await row("hub-audit").locator("button").first().click()
    await page.locator('[data-skill-sheet="hub-audit"]').waitFor({ timeout: 15_000 })
    await settled(page)
    assert.ok(await sheet().isVisible(), "the sheet Remove is offered on is up")
    await page.getByRole("button", { name: "Remove", exact: true }).click()
    await dialog().waitFor({ timeout: 15_000 })
    await settled(page)

    const viewport = page.viewportSize()
    assert.ok(viewport, "the page has a viewport")
    const box = await dialog().boundingBox()
    assert.ok(box, "the confirmation has a box")
    const width = Math.round(box.width)
    const height = Math.round(box.height)
    assert.ok(width > 0 && height > 0, `the confirmation is drawn (${width}×${height})`)
    assert.ok(width <= DIALOG_MAX, `a dialog's width, not the screen's (${width}px)`)
    assert.ok(
      box.x >= -1 && box.x + box.width <= viewport.width + 1,
      `the confirmation is on screen at ${viewport.width}px (${Math.round(box.x)}…${Math.round(box.x + box.width)})`,
    )
    assert.ok(
      Math.abs(box.x + box.width / 2 - viewport.width / 2) <= 1,
      "centred across the screen, as every confirmation is",
    )
    assert.ok(
      Math.abs(box.y + box.height / 2 - viewport.height / 2) <= 1,
      "and centred down it",
    )
    await shot("confirm")

    await shot("dialog")

    assert.deepEqual(errors, [], `no error in the console (${errors.join("; ")})`)
  } finally {
    await fetch(`${mock}/__mock/skills`, { method: "POST" })
  }
}

for (const width of [390, 1024]) {
  for (const dark of [false, true]) {
    const look = `${width}${dark ? "-dark" : ""}`
    await flow(`skills-remove-${look}`, run, {
      viewport: { width, height: width < 768 ? 844 : 768 },
      dark,
    })
  }
}
pass(
  "a removal asks first in a confirmation drawn in a box of its own, no wider than a dialog's, centred across and down the screen and on screen at both widths — at 390 and 1024px, light and dark",
)
