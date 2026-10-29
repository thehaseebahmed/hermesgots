// Throwaway: the level pick at phone, tablet, laptop and desktop widths.
import { join } from "node:path"
process.env.MOCK_URL ??= "http://127.0.0.1:18642"
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE)
const { launch, setUpBot } = await import("./scripts/e2e/lib.mjs")
const APP = "http://127.0.0.1:15173"
const OUT = process.env.SHOTS
const cases = [
  [390, 900, false, "sheet-phone-light"],
  [768, 900, false, "sheet-tablet-light"],
  [768, 900, true, "sheet-tablet-dark"],
  [1024, 900, false, "sheet-laptop-light"],
  [1440, 900, false, "sheet-desktop-light"],
  [1440, 900, true, "sheet-desktop-dark"],
]
let browser, page
for (const [width, height, dark, name] of cases) {
  if (page) { await browser.close() }
  browser = await launch(chromium, true)
  page = await browser.newPage({ viewport: { width, height }, colorScheme: dark ? "dark" : "light" })
  await page.goto(APP)
  const id = await setUpBot(page)
  await page.goto(`${APP}/settings/bots/${id}/speech-to-text`)
  await page.waitForLoadState("networkidle").catch(() => {})
  const row = page.locator('[data-setting="cleanup-level"]')
  await row.waitFor({ state: "visible", timeout: 15000 })
  await row.scrollIntoViewIfNeeded()
  await row.click()
  await page.locator("[data-cleanup-level]").first().waitFor({ state: "visible", timeout: 10000 })
  await page.waitForTimeout(600)
  const box = await page.evaluate(() => {
    const popup = document.querySelector("[data-cleanup-levels]")?.closest('[role="dialog"]')
    if (!popup) return null
    const r = popup.getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
  })
  await page.screenshot({ path: join(OUT, `${name}.png`) })
  console.log(name, JSON.stringify(box))
}
await browser.close()
