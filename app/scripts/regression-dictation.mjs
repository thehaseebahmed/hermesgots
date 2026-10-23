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
const streamMock = process.env.STREAM_MOCK_URL
const shots = process.env.SHOTS_DIR
const SENTENCE = "Let's ship the dictation feature today."
const TAKE = "Let us ship 25 things. and then two more items"
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

const clips = async () => (await (await fetch(`${mock}/__mock/dictation`)).json()).clips
const streamClips = async () => (await (await fetch(`${streamMock}/__mock/dictation`)).json()).clips
const takeState = async () => await (await fetch(`${streamMock}/__mock/dictation-take`)).json()
async function takeHeld(what) {
  for (let end = Date.now() + 10_000; !(await takeState()).takes.length;) {
    assert.ok(Date.now() < end, what)
    await new Promise((done) => setTimeout(done, 50))
  }
}

async function noTakes(what) {
  for (let end = Date.now() + 5000; (await takeState()).takes.length;) {
    assert.ok(Date.now() < end, what)
    await new Promise((done) => setTimeout(done, 50))
  }
}

const PHONE = { width: 390, height: 844 }

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

/** Retries a kept recording and the host's sentence lands in the composer. */
async function retried(page) {
  await page.getByRole("button", { name: "Retry" }).click()
  await page.getByRole("button", { name: "Voice", exact: true }).waitFor()
  assert.equal(await page.getByRole("textbox").last().inputValue(), SENTENCE)
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
    await retried(page)
    await page.reload()
    await page.getByRole("button", { name: "Voice", exact: true }).waitFor()
    await page.close()
  }

  // A long recording goes in pieces cut at the pauses, each sent while the voice carries on.
  {
    const talker = await launch(chromium, true, [...fakeMic.slice(1), `--use-file-for-fake-audio-capture=${speech()}`])
    const page = await open(mock, PHONE, "light", talker)
    const before = (await clips()).length
    await page.getByRole("button", { name: "Voice", exact: true }).click()
    await page.getByRole("button", { name: "Stop" }).waitFor()
    for (let end = Date.now() + 30_000; (await clips()).length - before < 2;) {
      assert.ok(Date.now() < end, "two pieces were cut at the pauses before Stop")
      await page.waitForTimeout(100)
    }
    const sent = (await clips()).slice(before)
    assert.equal(sent.length, 2, "two pieces sent before Stop")
    assert.equal(sent[1].context, SENTENCE, "the second piece carries on from the first")
    await page.waitForTimeout(1500)
    await page.getByRole("button", { name: "Stop" }).click()
    await page.getByRole("button", { name: "Voice", exact: true }).waitFor()
    const all = (await clips()).slice(before)
    assert.equal(all.length, 3)
    assert.equal(
      await page.getByRole("textbox").last().inputValue(),
      Array(3).fill(SENTENCE).join(" "),
    )
    await talker.close()
  }

  // A recorder that errors while live is a failure the user can retry, never a bar stuck transcribing.
  {
    const page = await open(mock, PHONE, "light", browser, false, recorderErrors)
    const mic = page.getByRole("button", { name: "Voice", exact: true })
    const before = (await clips()).length
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
    assert.equal((await clips()).length, before + 1, "one phrase reached the host")

    await mic.click()
    await page.getByRole("button", { name: "Retry" }).waitFor({ timeout: FAILED_MS })
    await page.getByRole("button", { name: "Discard" }).click()
    await mic.waitFor()
    assert.equal((await clips()).length, before + 1, "Discard sent nothing")
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
  if (streamMock) {
    for (const [label, viewport, scheme] of [
      ["phone-light", { width: 390, height: 844 }, "light"],
      ["tablet-dark", { width: 820, height: 1180 }, "dark"],
    ]) {
      const page = await open(streamMock, viewport, scheme)
      await page.waitForLoadState("networkidle").catch(() => {})
      const composer = page.getByRole("textbox").last()
      const mic = page.getByRole("button", { name: "Voice", exact: true })
      const bar = page.getByRole("region", { name: "Dictation" })

      await composer.fill("Note:")
      await mic.click()
      await bar.getByText("Preparing…").waitFor()
      await shot(page, `${label}-9-preparing`)
      await page.evaluate(() => {
        window.__heard = []
        window.__hearWatcher = window.setInterval(() => {
          const region = document.querySelector('[role="region"][aria-label="Dictation"]')
          const text = [...(region?.querySelectorAll("p") ?? [])]
            .map((line) => line.textContent)
            .filter((line) => line && line !== "Behind")
            .join(" ")
            .trim()
          if (text && window.__heard.at(-1) !== text) window.__heard.push(text)
        }, 40)
      })
      await bar.getByText("Let us ship 25 things.").waitFor({ timeout: 15_000 })
      await bar.getByText("Behind").waitFor()
      assert.equal(await bar.getAttribute("aria-live"), "off", "the transcript is read on request")
      await shot(page, `${label}-10-hearing`)

      await page.getByRole("button", { name: "Stop" }).click()
      await mic.waitFor({ timeout: 15_000 })
      assert.equal(
        await composer.inputValue(),
        "Note: Let us ship 25 things. and then two more items",
      )
      assert.equal(
        await page.getByText("um Let us", { exact: false }).count(),
        0,
        "the filler the host heard is not what the user reads",
      )
      assert.equal(
        await page.evaluate(async () => (await import("/src/lib/db.ts")).db.dictations.count()),
        0,
        "a take that ended keeps nothing on the device",
      )
      await shot(page, `${label}-11-heard`)
      const moments = await page.evaluate(() => {
        window.clearInterval(window.__hearWatcher)
        return window.__heard
      })
      assert.ok(moments.length >= 2, `the bar was read at two moments (${JSON.stringify(moments)})`)
      assert.ok(
        moments.some((text) => text.includes("um Let us")),
        `the words arrive as the host heard them (${JSON.stringify(moments)})`,
      )
      const tidied = moments.findIndex((text) => text.includes("Let us ship 25 things."))
      assert.ok(tidied >= 0, `the phrase arrived tidied (${JSON.stringify(moments)})`)
      for (const text of moments.slice(tidied))
        assert.ok(
          text.includes("Let us ship 25 things."),
          `"${text}" keeps the phrase the host tidied`,
        )
      assert.ok(
        moments.some((text) => text.split(" ").length > 1),
        `the take's words arrived over more than one moment (${JSON.stringify(moments)})`,
      )
      const heard = await (await fetch(`${streamMock}/__mock/dictation-take`)).json()
      assert.ok(heard.slices.length > 1, "the take was sent slice by slice")
      assert.equal(heard.peak, 1, "one slice in flight at a time")

      await composer.fill("")
      await mic.click()
      await page.getByRole("button", { name: "Stop" }).waitFor()
      await takeHeld("the host has the take being cancelled")
      await page.waitForTimeout(900)
      await page.getByRole("button", { name: "Cancel" }).click()
      await mic.waitFor()
      assert.equal(await composer.inputValue(), "")
      await noTakes("a cancelled take is dropped on the host")
      assert.equal(
        await page.evaluate(async () => (await import("/src/lib/db.ts")).db.dictations.count()),
        0,
        "a cancelled take keeps nothing on the device",
      )

      await mic.click()
      await bar.getByText("Let us ship 25 things.").waitFor({ timeout: 15_000 })
      await bar.getByText("and then two more items").waitFor({ timeout: 15_000 })
      await shot(page, `${label}-13-sending`)
      await page.getByRole("button", { name: "Send" }).click()
      await page.getByText(TAKE).first().waitFor({ timeout: 15_000 })
      await mic.waitFor({ timeout: 15_000 })
      assert.equal(
        await page.getByRole("textbox").last().inputValue(),
        "",
        "the take went out as the message, not into the field as well",
      )
      await noTakes("the send finished the take on the host")
      await shot(page, `${label}-14-sent`)
      await page.close()
    }

    {
      const page = await open(streamMock, PHONE)
      const composer = page.getByRole("textbox").last()
      const mic = page.getByRole("button", { name: "Voice", exact: true })
      const bar = page.getByRole("group", { name: "Dictation take" })
      const refusal = "This Hermes can't decode audio while it is spoken."
      let asked = 0
      await page.route("**/api/plugins/memento/dictation/take", async (route) => {
        asked += 1
        if (asked > 1) return route.continue()
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ error: { message: refusal } }),
        })
      })
      await composer.fill("Note:")
      await mic.click()
      await page.getByText(refusal).waitFor({ timeout: 15_000 })
      await page.getByText("Check that this bot's host can dictate, then try again.").waitFor()
      assert.equal(await page.getByText("Preparing…").count(), 0, "a refused take is not left preparing")
      await shot(page, "phone-light-15-start-refused")

      await bar.getByRole("button", { name: "Retry" }).click()
      await bar.getByText("Preparing…").waitFor({ timeout: 15_000 })
      assert.equal(asked, 2, "Retry asked the host again")
      await takeHeld("the retried take open on the host")
      await bar.getByRole("button", { name: "Cancel" }).click()
      await mic.waitFor()
      assert.equal(await composer.inputValue(), "Note:", "the composer is as it was")
      assert.deepEqual((await takeState()).takes, [], "the cancelled take is dropped on the host")
      await page.close()
    }

    {
      const page = await open(streamMock, PHONE)
      const composer = page.getByRole("textbox").last()
      const mic = page.getByRole("button", { name: "Voice", exact: true })
      const bar = page.getByRole("group", { name: "Dictation take" })
      const broken = "Couldn't decode the recording: bad container"
      let slices = 0
      await page.route("**/api/plugins/memento/dictation/take/**/audio", async (route) => {
        slices += 1
        if (slices !== 6) return route.continue()
        await route.fulfill({
          status: 502,
          contentType: "application/json",
          body: JSON.stringify({ error: { message: broken } }),
        })
      })
      await composer.fill("")
      await mic.click()
      await bar.getByText("Let us ship 25 things.").waitFor({ timeout: 15_000 })
      await page.getByText(broken).waitFor({ timeout: 15_000 })
      await page.getByText("Try again; the words it already heard are kept.").waitFor()
      assert.equal(
        await page.getByText("Transcribing…").count(),
        0,
        "no transcribing that never ends",
      )
      await shot(page, "phone-light-16-host-gone")
      await bar.getByRole("button", { name: "Dismiss" }).click()
      await mic.waitFor()
      assert.equal(
        await composer.inputValue(),
        TAKE,
        "the words the host had committed land where the take began",
      )
      await noTakes("the failed take is let go on the host")
      assert.equal(
        await page.evaluate(async () => (await import("/src/lib/db.ts")).db.dictations.count()),
        0,
        "a failed take keeps nothing on the device",
      )
      await mic.click()
      await bar.getByText("Preparing…").waitFor({ timeout: 15_000 })
      await page.waitForTimeout(1500)
      await shot(page, "phone-light-17-after-failure-take")
      await takeHeld("a take open after the failure")
      await bar.getByRole("button", { name: "Cancel" }).click()
      await mic.waitFor()
      await page.close()
    }

    {
      const page = await open(streamMock, PHONE)
      await page.waitForLoadState("networkidle").catch(() => {})
      const composer = page.getByRole("textbox").last()
      const mic = page.getByRole("button", { name: "Voice", exact: true })
      await composer.fill("Before after")
      await composer.evaluate((field) => field.setSelectionRange(7, 7))
      const before = (await streamClips()).length
      await mic.click()
      await page.getByRole("region", { name: "Dictation" }).waitFor()
      for (let kept = false, end = Date.now() + 10_000; !kept; await page.waitForTimeout(100)) {
        kept = await page.evaluate(async () => {
          const { db } = await import("/src/lib/db.ts")
          const rows = await db.dictations.toArray()
          return rows.some(
            (row) => row.kind === "stream" && row.pieces.some((piece) => piece.blob.size > 0),
          )
        })
        assert.ok(kept || Date.now() < end, "the take is kept on the device")
      }
      await page.reload()
      await page.getByText("hasn't been transcribed yet").waitFor()
      await shot(page, "phone-light-12-kept-take")
      await page.getByRole("button", { name: "Retry" }).click()
      await page.getByRole("button", { name: "Voice", exact: true }).waitFor({ timeout: 15_000 })
      assert.equal(
        await page.getByRole("textbox").last().inputValue(),
        `Before ${SENTENCE} after`,
        "the take's words go where it began, with the draft around them",
      )
      const asked = (await streamClips()).slice(before)
      assert.equal(asked.length, 1, "a restored take is asked for whole, not slice by slice")
      assert.match(asked[0].type, /^audio\/webm/, "the slices went as the one recording they were")
      assert.equal(asked[0].context ?? null, null, "nothing was heard before it")
      assert.equal(
        await page.evaluate(async () => (await import("/src/lib/db.ts")).db.dictations.count()),
        0,
        "its text is in, so it is not kept again",
      )
      await page.close()
    }
  }
  console.log("dictation: ok")
} finally {
  await browser.close()
}
