// The first app (#858): a plus on Apps, a prompt sheet, a build's blocks as the app's pages, the
// consent list as the sheet's last step, and the new app opening on its root page.
import { assert, flow, pass } from "./lib.mjs"

await flow(
  "app-build",
  async ({ page, shot, until, profileId }) => {
    await page.goto(`${(await import("./lib.mjs")).app}/apps`)
    await page.getByRole("button", { name: /New app/ }).click()
    await page.locator("#app-prompt").fill("A home dashboard, build an app")
    await shot("sheet-prompt")
    await page.getByRole("button", { name: /^Build$/ }).click()
    await page.getByRole("button", { name: /^Save app$/ }).waitFor({ timeout: 30_000 })
    assert.match(await page.locator("body").innerText(), /light\.list/)
    pass("the consent list names what the pages read, before anything is written")
    await shot("sheet-consent")
    await page.getByRole("button", { name: /^Save app$/ }).click()
    await page.waitForURL(/\/apps\/app_1/, { timeout: 15_000 })
    await until(
      async () => /Your lights/.test(await page.locator("body").innerText()),
      15_000,
      "the root page to draw",
    )
    pass("the new app opens on its root page")
    await shot("root-page")
    void profileId
  },
  { viewport: { width: 390, height: 844 } },
)
