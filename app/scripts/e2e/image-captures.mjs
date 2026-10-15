// A checkpoint's capture screenshots hold their place with a skeleton while the plugin serves them,
// and a capture that can't be read says so. The evidence route is held back, and one capture is
// failed on purpose, so both states are on screen at once.
import { app, assert, flow, pass } from "./lib.mjs"

const projectId = "p_1a2b3c4d"
const chatId = "theseus-session"

for (const look of [
  { width: 1024, dark: false },
  { width: 390, dark: true },
]) {
  await flow(
    `image-captures-${look.width}${look.dark ? "-dark" : ""}`,
    async ({ page, until, shot, seed, send }) => {
      // One capture waits on the plugin; the other is a file the host can't serve.
      let open = true
      await page.route("**/theseus/evidence/**", async (route) => {
        if (route.request().url().endsWith("build.svg"))
          return route.fulfill({ status: 500, contentType: "text/plain", body: "no capture" })
        for (const end = Date.now() + 10_000; open && Date.now() < end; )
          await new Promise((done) => setTimeout(done, 100))
        await route.continue().catch(() => {})
      })

      await seed([{ id: chatId, title: "Run", projectId }])
      await page.goto(`${app}/c/${chatId}`)
      await page.evaluate(async (id) => {
        const { db } = await import("/src/lib/db.ts")
        await db.settings.update("settings", { developer: true, theseus: true })
        const { setSessionMode } = await import("/src/lib/workspace.ts")
        // Theseus is chosen before the first turn, which is the turn that carries the mode.
        await setSessionMode(id, "theseus")
      }, chatId)
      await send("start the run")

      // The run's pill (its summary reads "3 of 7 · …") opens the sheet; its checkpoint row opens
      // the captures. The composer's `+` also carries a sailboat — the session's mode mark — so the
      // pill is found by its summary.
      const pill = page.getByRole("button", { name: /\d+ of \d+/ })
      await until(async () => (await pill.count()) > 0, 20_000, "the run's pill")
      await pill.first().click()
      const row = page.locator('button:has-text("CP3")').first()
      await row.waitFor({ timeout: 20_000 })
      await row.click()

      await until(
        async () => (await page.locator("[data-slot=skeleton]").count()) === 1,
        20_000,
        "the capture placeholder",
      )
      await page.getByText("Couldn't load").waitFor({ timeout: 10_000 })
      const box = await page.locator("[data-slot=skeleton]").boundingBox()
      assert.ok(
        box.height > box.width,
        `the placeholder keeps the capture frame's shape (${Math.round(box.width)}x${Math.round(box.height)})`,
      )
      await shot("loading")

      open = false
      await until(
        async () => (await page.locator("[data-slot=skeleton]").count()) === 0,
        20_000,
        "the capture to load",
      )
      const painted = await page.evaluate(
        () =>
          [...document.querySelectorAll("figure img")].filter((img) => img.naturalWidth > 0).length,
      )
      assert.equal(painted, 1, "the capture the plugin serves is on screen")
      assert.equal(
        await page.getByText("Couldn't load").count(),
        1,
        "the capture that can't be read still says so",
      )
      await shot("loaded")
      pass(`captures hold their place at ${look.width}${look.dark ? " dark" : ""}`)
    },
    { viewport: { width: look.width, height: look.width < 768 ? 844 : 768 }, dark: look.dark },
  )
}
