// Run with Vite on APP_URL and an isolated mock on MOCK_URL (MOCK_DICTATION=off on OFF_MOCK_URL).
// Requires Playwright; Chromium's fake microphone stands in for a real one, and for the pieces cut
// at pauses it plays a made-up voice that stops for a moment twice.
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright")

const app = process.env.APP_URL ?? "http://localhost:15173"
const mock = process.env.MOCK_URL ?? "http://localhost:18642"
const offMock = process.env.OFF_MOCK_URL
const shots = process.env.SHOTS_DIR
const SENTENCE = "Let's ship the dictation feature today."
const fakeMic = ["--no-sandbox", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"]
const browser = await chromium.launch({ headless: true, args: fakeMic })

/** 7s of a buzzing, syllable-shaped voice, 1.5s of quiet, 7s more, 1.5s, 4s, then quiet. */
function speech() {
  const rate = 48000
  const parts = [[0.5, 0], [7, 1], [1.5, 0], [7, 1], [1.5, 0], [4, 1], [3, 0]]
  const total = parts.reduce((sum, [seconds]) => sum + Math.round(seconds * rate), 0)
  const wav = Buffer.alloc(44 + total * 2)
  wav.write("RIFF", 0)
  wav.writeUInt32LE(36 + total * 2, 4)
  wav.write("WAVEfmt ", 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(rate, 24)
  wav.writeUInt32LE(rate * 2, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write("data", 36)
  wav.writeUInt32LE(total * 2, 40)
  let at = 0
  for (const [seconds, voiced] of parts) {
    for (let i = 0; i < Math.round(seconds * rate); i++, at++) {
      const t = at / rate
      let value = 0.0005 * (Math.random() * 2 - 1)
      if (voiced) {
        const envelope = Math.max(0, Math.sin(2 * Math.PI * 4.3 * t)) ** 0.6
        const pitch = 140 + 25 * Math.sin(2 * Math.PI * 0.7 * t)
        let tone = 0
        for (let k = 1; k < 8; k++) tone += Math.sin(2 * Math.PI * pitch * k * t) / k
        value = envelope * (0.25 * tone + 0.08 * (Math.random() * 2 - 1))
      }
      wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), 44 + at * 2)
    }
  }
  const path = join(mkdtempSync(join(tmpdir(), "memento-dictation-")), "speech.wav")
  writeFileSync(path, wav)
  return path
}

const clips = async () => (await (await fetch(`${mock}/__mock/dictation`)).json()).clips

async function open(server, viewport, colorScheme = "light", on = browser, touch = false) {
  const context = await on.newContext({ viewport, colorScheme, hasTouch: touch, isMobile: touch })
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
    const mic = page.getByRole("button", { name: "Voice", exact: true })

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
    assert.equal(await composer.inputValue(), `Note: ${SENTENCE}`)
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
    assert.equal(await composer.inputValue(), SENTENCE)

    // Cancel drops the clip without asking the host.
    await mic.click()
    await page.getByRole("button", { name: "Cancel" }).click()
    await mic.waitFor()
    await page.close()
  }

  // A recording left by a reload comes back with Retry.
  {
    const page = await open(mock, { width: 390, height: 844 })
    await page.getByRole("button", { name: "Voice", exact: true }).click()
    await page.getByRole("button", { name: "Stop" }).waitFor()
    await page.waitForTimeout(3500)
    await page.reload()
    await page.getByText("hasn't been transcribed yet").waitFor()
    await shot(page, "phone-light-6-kept")
    await page.getByRole("button", { name: "Retry" }).click()
    await page.getByRole("button", { name: "Voice", exact: true }).waitFor()
    assert.equal(await page.getByRole("textbox").last().inputValue(), SENTENCE)
    await page.reload()
    await page.getByRole("button", { name: "Voice", exact: true }).waitFor()
    await page.close()
  }

  // A long recording goes in pieces cut at the pauses, each sent while the voice carries on.
  {
    const talker = await chromium.launch({
      headless: true,
      args: [...fakeMic, `--use-file-for-fake-audio-capture=${speech()}`],
    })
    const page = await open(mock, { width: 390, height: 844 }, "light", talker)
    const before = (await clips()).length
    await page.getByRole("button", { name: "Voice", exact: true }).click()
    await page.getByRole("button", { name: "Stop" }).waitFor()
    await page.waitForTimeout(19_000)
    const sent = (await clips()).slice(before)
    assert.equal(sent.length, 2, "two pieces sent before Stop")
    assert.equal(sent[1].context, SENTENCE, "the second piece carries on from the first")
    await page.getByRole("button", { name: "Stop" }).click()
    await page.getByRole("button", { name: "Voice", exact: true }).waitFor()
    const all = (await clips()).slice(before)
    assert.equal(all.length, 3)
    assert.equal(await page.getByRole("textbox").last().inputValue(), Array(3).fill(SENTENCE).join(" "))
    await talker.close()
  }

  // A tap on a phone keeps recording: its click must not land on the bar that took the mic's place.
  {
    const page = await open(mock, { width: 390, height: 844 }, "light", browser, true)
    const mic = page.getByRole("button", { name: "Voice", exact: true })
    const box = await mic.boundingBox()
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2)
    await page.getByRole("button", { name: "Stop" }).waitFor()
    await page.waitForTimeout(1500)
    assert.equal(await page.getByRole("button", { name: "Stop" }).count(), 1, "still recording")
    await page.getByRole("button", { name: "Stop" }).tap()
    await mic.waitFor()
    assert.equal(await page.getByRole("textbox").last().inputValue(), SENTENCE)
    await page.close()
  }

  // While the host is asked, the mic is greyed out and does nothing.
  {
    const page = await open(mock, { width: 390, height: 844 })
    await page.route("**/api/plugins/memento/info", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 3000))
      await route.continue().catch(() => {})
    })
    await page.reload()
    const greyed = page.getByRole("button", { name: "Voice unavailable" })
    await greyed.waitFor()
    assert.ok(await greyed.isDisabled(), "greyed out while checking")
    await shot(page, "phone-light-7-checking")
    await page.getByRole("button", { name: "Voice", exact: true }).waitFor({ timeout: 10_000 })
    await page.close()
  }

  // A host that can't check says why on a tap, and so does one that couldn't be asked.
  for (const [label, server, words] of [
    ["off", offMock, "faster-whisper isn't installed"],
    ["failed", "http://localhost:9", "Couldn't check with Hermes"],
  ]) {
    if (!server) continue
    const page = await open(server, { width: 390, height: 844 })
    const greyed = page.getByRole("button", { name: "Voice unavailable" })
    await greyed.waitFor()
    await page.waitForFunction(
      () => !document.querySelector('[aria-label="Voice unavailable"]')?.hasAttribute("disabled"),
      undefined,
      { timeout: 10_000 },
    )
    await greyed.click()
    await page.getByText(words).waitFor()
    await shot(page, `phone-light-8-${label}`)
    assert.equal(await page.getByRole("button", { name: "Voice", exact: true }).count(), 0)
    await page.close()
  }
  console.log("dictation: ok")
} finally {
  await browser.close()
}
