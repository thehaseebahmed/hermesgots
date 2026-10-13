// Run with Vite on APP_URL and an isolated mock on MOCK_URL (MOCK_DICTATION=off on OFF_MOCK_URL).
// Requires Playwright; Chromium's fake microphone stands in for a real one.
import assert from "node:assert/strict"
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright")

const app = process.env.APP_URL ?? "http://localhost:15173"
const mock = process.env.MOCK_URL ?? "http://localhost:18642"
const offMock = process.env.OFF_MOCK_URL
const shots = process.env.SHOTS_DIR
const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
})

async function open(server, viewport, colorScheme = "light") {
  const context = await browser.newContext({ viewport, colorScheme })
  await context.grantPermissions(["microphone"], { origin: app })
  const page = await context.newPage()
  await page.goto(app)
  await page.evaluate(async (server) => {
    const { db } = await import("/src/lib/db.ts")
    const profile = (await db.profiles.toArray())[0]
    await db.profiles.update(profile.id, { name: "Test bot", baseUrl: `${server}/v1`, apiKey: "mock-key" })
    await db.settings.put({ id: "settings", activeProfileId: profile.id, onboarded: true })
  }, server)
  await page.goto(app)
  return page
}

const shot = (page, name) => shots && page.screenshot({ path: `${shots}/${name}.png` })

try {
  for (const [label, viewport, scheme] of [
    ["phone-light", { width: 390, height: 844 }, "light"],
    ["tablet-dark", { width: 820, height: 1180 }, "dark"],
  ]) {
    const page = await open(mock, viewport, scheme)
    const composer = page.getByRole("textbox").last()
    const mic = page.getByRole("button", { name: "Voice" })

    // Tap to toggle: the bar records until Stop, then the host's text lands at the cursor.
    await composer.fill("Note:")
    await mic.click()
    await page.getByRole("button", { name: "Stop" }).waitFor()
    await page.waitForTimeout(1200)
    await shot(page, `${label}-1-recording`)
    await page.getByRole("button", { name: "Stop" }).click()
    await page.getByText("Transcribing…").waitFor()
    await shot(page, `${label}-2-transcribing`)
    await page.waitForFunction(
      () => [...document.querySelectorAll("textarea")].at(-1)?.value.includes("dictation"),
      undefined,
      { timeout: 5000 },
    )
    assert.equal(await composer.inputValue(), "Note: Let's ship the dictation feature today.")
    await shot(page, `${label}-3-inserted`)

    // Hold to talk: letting go finishes.
    await composer.fill("")
    const box = await mic.boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.waitForTimeout(1000)
    await page.mouse.up()
    await page.waitForFunction(
      () => [...document.querySelectorAll("textarea")].at(-1)?.value.length > 0,
      undefined,
      { timeout: 5000 },
    )
    assert.equal(await composer.inputValue(), "Let's ship the dictation feature today.")

    // Cancel drops the clip without asking the host.
    await mic.click()
    await page.getByRole("button", { name: "Cancel" }).click()
    await mic.waitFor()
    await page.close()
  }

  if (offMock) {
    const page = await open(offMock, { width: 390, height: 844 })
    await page.getByRole("textbox").last().waitFor()
    await page.waitForTimeout(1500)
    assert.equal(await page.getByRole("button", { name: "Voice" }).count(), 0, "no mic without faster-whisper")
    await shot(page, "phone-light-4-no-mic")
    await page.close()
  }
  console.log("dictation: ok")
} finally {
  await browser.close()
}
