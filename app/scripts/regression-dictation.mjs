// Chromium's fake microphone stands in for a real one; the long recording plays a made-up voice
// that stops for a moment twice, so the cut at a pause is what those blocks test.
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright")
import { launch, settleNav } from "./e2e/lib.mjs"

const app = process.env.APP_URL ?? "http://localhost:15173"
const mock = process.env.MOCK_URL ?? "http://localhost:18642"
const offMock = process.env.OFF_MOCK_URL
const shots = process.env.SHOTS_DIR
const SENTENCE = "Let's ship the dictation feature today."
const HEARD = `um ${SENTENCE}`
// Long enough for the stop a dead recorder never sends (STOP_MS) plus the state to render.
const FAILED_MS = 2500
const fakeMic = ["--no-sandbox", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"]
const browser = await launch(chromium, true, fakeMic.slice(1))

function speech() {
  const rate = 48000
  const parts = [
    [0.5, 0],
    [7, 1],
    [1.5, 0],
    [7, 1],
    [1.5, 0],
    [4, 1],
    [3, 0],
  ]
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

async function mockDictation() {
  const { clips, cleanups } = await (await fetch(`${mock}/__mock/dictation`)).json()
  return { clips, cleanups }
}

const PHONE = { width: 390, height: 844 }

/** The bot this device's one profile is, so a flow can open its editor's own screen. */
const botId = (page) =>
  page.evaluate(async () => (await (await import("/src/lib/db.ts")).db.profiles.toArray())[0].id)

async function addWord(page, word) {
  await page.goto(`${app}/settings/bots/${await botId(page)}/dictation`)
  const tab = page.locator("[data-bot-dictation]")
  await tab.waitFor({ timeout: 15_000 })
  await tab.locator("#vocabulary-word").fill(word)
  await tab.getByRole("button", { name: "Add" }).click()
  await tab.getByRole("button", { name: `Remove ${word}` }).waitFor({ timeout: 5000 })
}

/** Every recorder errors 1.2 s into its stretch, as an encoder that dies mid-take does. */
const recorderErrors = () => {
  const Recorder = window.MediaRecorder
  window.MediaRecorder = class extends Recorder {
    start(...args) {
      super.start(...args)
      window.setTimeout(() => this.dispatchEvent(new Event("error")), 1200)
    }
  }
}

/** Keeps the take's stream on the page, so a test can end its track as the device would. */
const exposeMic = () => {
  const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
  navigator.mediaDevices.getUserMedia = async (...args) => {
    const stream = await getUserMedia(...args)
    window.__mic = stream
    return stream
  }
}

/**
 * Retries a kept recording and its words land in the composer: a live take ends through the cleanup,
 * while one restored from the device is asked for whole and lands as the host heard it (ADR 0038
 * keeps the retry as it was).
 */
async function retried(page, words = SENTENCE) {
  await page.getByRole("button", { name: "Retry" }).click()
  await page.getByRole("button", { name: "Voice", exact: true }).waitFor()
  assert.equal(await page.getByRole("textbox").last().inputValue(), words)
}

async function open(server, viewport, colorScheme = "light", on = browser, touch = false, init) {
  const context = await on.newContext({ viewport, colorScheme, hasTouch: touch, isMobile: touch })
  if (init) await context.addInitScript(init)
  await context.grantPermissions(["microphone"], { origin: app })
  const page = await settleNav(await context.newPage())
  await page.goto(app)
  await page.evaluate(async (server) => {
    const { db } = await import("/src/lib/db.ts")
    const profile = (await db.profiles.toArray())[0]
    await db.profiles.update(profile.id, {
      name: "Test bot",
      baseUrl: `${server}/v1`,
      apiKey: "mock-key",
    })
    await db.settings.put({ id: "settings", activeProfileId: profile.id, onboarded: true })
  }, server)
  await page.goto(app)
  return page
}

const shot = (page, name) =>
  shots && page.screenshot({ path: `${shots}/${name}.png`, animations: "disabled" })

try {
  for (const [label, viewport, scheme] of [
    ["phone-light", { width: 390, height: 844 }, "light"],
    ["tablet-dark", { width: 820, height: 1180 }, "dark"],
  ]) {
    const page = await open(mock, viewport, scheme)
    const composer = page.getByRole("textbox").last()
    const mic = page.getByRole("button", { name: "Voice", exact: true })

    await composer.fill("Note:")
    await mic.click()
    await page.getByRole("button", { name: "Stop" }).waitFor()
    // How long this recording runs: one under 300ms is dropped, so Stop would have nothing to send.
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

    await mic.click()
    await page.getByRole("button", { name: "Cancel" }).click()
    await mic.waitFor()
    await page.close()
  }

  // A recording left by a reload comes back with Retry.
  {
    const page = await open(mock, PHONE)
    await page.getByRole("button", { name: "Voice", exact: true }).click()
    await page.getByRole("button", { name: "Stop" }).waitFor()
    // Until the open piece is kept on the device (saved every 2s), which is what a reload must find.
    for (let kept = false, end = Date.now() + 10_000; !kept; await page.waitForTimeout(100)) {
      kept = await page.evaluate(async () => {
        const { db } = await import("/src/lib/db.ts")
        const rows = await db.dictations.toArray()
        return rows.some((row) => row.pieces.some((piece) => piece.blob.size > 0))
      })
      assert.ok(kept || Date.now() < end, "the recording is kept on the device")
    }
    await page.reload()
    await page.getByText("hasn't been transcribed yet").waitFor()
    await shot(page, "phone-light-6-kept")
    await retried(page, HEARD)
    await page.reload()
    await page.getByRole("button", { name: "Voice", exact: true }).waitFor()
    await page.close()
  }

  // A long recording goes in pieces cut at the pauses, each sent while the voice carries on.
  {
    const talker = await launch(chromium, true, [...fakeMic.slice(1), `--use-file-for-fake-audio-capture=${speech()}`])
    const page = await open(mock, PHONE, "light", talker)
    const before = (await mockDictation()).clips.length
    await page.getByRole("button", { name: "Voice", exact: true }).click()
    await page.getByRole("button", { name: "Stop" }).waitFor()
    for (let end = Date.now() + 30_000; (await mockDictation()).clips.length - before < 2;) {
      assert.ok(Date.now() < end, "two pieces were cut at the pauses before Stop")
      await page.waitForTimeout(100)
    }
    const sent = (await mockDictation()).clips.slice(before)
    assert.equal(sent.length, 2, "two pieces sent before Stop")
    assert.equal(sent[1].context, HEARD, "the second piece carries on from what the host heard")
    await page.waitForTimeout(1500)
    await page.getByRole("button", { name: "Stop" }).click()
    await page.getByRole("button", { name: "Voice", exact: true }).waitFor()
    const all = (await mockDictation()).clips.slice(before)
    assert.equal(all.length, 3)
    assert.equal(
      await page.getByRole("textbox").last().inputValue(),
      [SENTENCE, HEARD, HEARD].join(" "),
    )
    await talker.close()
  }

  // A recorder that errors while live is a failure the user can retry, never a bar stuck transcribing.
  {
    const page = await open(mock, PHONE, "light", browser, false, recorderErrors)
    const mic = page.getByRole("button", { name: "Voice", exact: true })
    const before = (await mockDictation()).clips.length
    await mic.click()
    await page.getByRole("button", { name: "Stop" }).waitFor()
    await page.getByRole("button", { name: "Retry" }).waitFor({ timeout: FAILED_MS })
    assert.equal(
      await page.getByText("Transcribing…").count(),
      0,
      "no transcribing that never ends",
    )
    await page.getByText("The recording stopped.").waitFor()
    await page.getByText("Check the microphone in this app's permissions, then try again.").waitFor()
    await page.getByRole("button", { name: "Discard" }).waitFor()
    await shot(page, "phone-light-9-recorder-failed")

    await retried(page)
    assert.equal((await mockDictation()).clips.length, before + 1, "one phrase reached the host")

    await mic.click()
    await page.getByRole("button", { name: "Retry" }).waitFor({ timeout: FAILED_MS })
    await page.getByRole("button", { name: "Discard" }).click()
    await mic.waitFor()
    assert.equal((await mockDictation()).clips.length, before + 1, "Discard sent nothing")
    assert.equal(await page.getByRole("textbox").last().inputValue(), SENTENCE)
    assert.equal(
      await page.evaluate(async () => (await import("/src/lib/db.ts")).db.dictations.count()),
      0,
      "Discard kept nothing on the device",
    )
    await page.close()
  }

  // A track the device ends under the app — another app takes the microphone, permission is
  // revoked — fails the same way, and Retry sends what was already recorded.
  {
    const page = await open(mock, PHONE, "light", browser, false, exposeMic)
    await page.getByRole("button", { name: "Voice", exact: true }).click()
    await page.getByRole("button", { name: "Stop" }).waitFor()
    await page.waitForTimeout(1500)
    await page.evaluate(() => window.__mic.getAudioTracks()[0].dispatchEvent(new Event("ended")))
    await page.getByRole("button", { name: "Retry" }).waitFor({ timeout: FAILED_MS })
    assert.equal(
      await page.getByText("Transcribing…").count(),
      0,
      "no transcribing that never ends",
    )
    await page.getByText("The microphone is in use by another app.").waitFor()
    await shot(page, "phone-light-10-track-ended")
    await retried(page)
    await page.close()
  }

  // A tap on a phone keeps recording: its click must not land on the bar that took the mic's place.
  {
    const page = await open(mock, PHONE, "light", browser, true)
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

  {
    const page = await open(mock, PHONE)
    const tab = page.locator("[data-bot-dictation]")
    await addWord(page, "Gots")
    await shot(page, "phone-light-18-dictation-word")

    await page.reload()
    await page.getByRole("button", { name: "Remove Gots" }).waitFor({ timeout: 15_000 })
    assert.equal(
      await page.getByRole("button", { name: "Remove Gots" }).count(),
      1,
      "the word added on the tab is still the bot's after a reload",
    )

    const models = tab.locator('[aria-label="Speech models"] button')
    const row = (name) => models.filter({ hasText: new RegExp(`^${name}`) })
    await models.first().waitFor({ timeout: 15_000 })
    assert.match(await row("small").innerText(), /In use/, "the model in play says so")
    assert.equal(await row("base").getAttribute("aria-pressed"), "false")

    await row("base").click()
    for (let picked = false, end = Date.now() + 10_000; !picked; await page.waitForTimeout(100)) {
      picked = (await row("base").getAttribute("aria-pressed")) === "true"
      assert.ok(picked || Date.now() < end, "the model picked on the tab is the one in use")
    }
    assert.match(await row("base").innerText(), /In use/)
    assert.equal(await row("small").getAttribute("aria-pressed"), "false", "the old one steps down")
    await shot(page, "phone-light-19-dictation-model")

    await page.reload()
    await models.first().waitFor({ timeout: 15_000 })
    assert.equal(
      await row("base").getAttribute("aria-pressed"),
      "true",
      "the pick written to the host is the one in play",
    )
    await page.close()
  }

  {
    const page = await open(mock, PHONE)
    await addWord(page, "Gots")

    await page.goto(app)
    const composer = page.getByRole("textbox").last()
    const before = await mockDictation()
    await page.getByRole("button", { name: "Voice", exact: true }).click()
    await page.getByRole("button", { name: "Stop" }).waitFor()
    await page.waitForTimeout(1200)
    await page.getByRole("button", { name: "Stop" }).click()
    await page.getByRole("button", { name: "Voice", exact: true }).waitFor({ timeout: 15_000 })
    assert.equal(await composer.inputValue(), SENTENCE, "the cleanup's tidied text is what lands")
    await shot(page, "phone-light-20-vocabulary")

    const after = await mockDictation()
    const sent = after.clips.slice(before.clips.length)
    assert.equal(sent.length, 1)
    assert.deepEqual(sent[0].vocabulary, ["Gots"], "the bot's word rode on the clip")
    const tidied = after.cleanups.slice(before.cleanups.length)
    assert.equal(tidied.length, 1, "one cleanup ended the dictation")
    assert.equal(tidied[0].text, HEARD, "the cleanup was asked for the words as they were heard")
    assert.deepEqual(tidied[0].vocabulary, ["Gots"], "…and carried the bot's word too")
    await page.close()
  }

  console.log("dictation: ok")
} finally {
  await browser.close()
}
