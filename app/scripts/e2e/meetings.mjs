// Meetings, the Developer-gated design mock: the sidebar row only with the switch on, the sample
// meetings by project, a recording with typed notes walked through to its notes, a timestamp opening
// the transcript at its line, an added file, a failed meeting tried again, and Delete. At phone,
// tablet (dark) and laptop widths, with no errors in the console.
import { app, assert, flow, pass } from "./lib.mjs"

/** A second of silence as a WAV file, so the browser can read its length. */
function silence() {
  const rate = 8000
  const data = Buffer.alloc(rate * 2)
  const header = Buffer.alloc(44)
  header.write("RIFF", 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write("WAVEfmt ", 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write("data", 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

const errors = []
for (const [width, dark] of [
  [390, false],
  [1024, true],
  [1440, false],
]) {
  await flow(
    `meetings-${width}${dark ? "-dark" : ""}`,
    async ({ page, shot: take }) => {
      // Screens slide in; let them land before a screenshot.
      const shot = async (step) => {
        await page.waitForTimeout(400)
        return take(step)
      }
      page.on("pageerror", (error) => errors.push(`${width}: ${error.message}`))
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(`${width}: ${message.text()}`)
      })
      const setSwitch = (meetings) =>
        page.evaluate(async (meetings) => {
          const { db } = await import("/src/lib/db.ts")
          await db.settings.update("settings", { developer: true, meetings })
        }, meetings)

      // Off by default: no row, and the screen sends you home.
      await page.goto(`${app}/meetings`)
      await page.waitForURL((url) => url.pathname === "/", { timeout: 10_000 })
      assert.equal(await page.getByRole("link", { name: "Meetings" }).count(), 0)
      pass(`${width}: hidden until the Developer switch is on`)

      await setSwitch(true)
      await page.goto(`${app}/meetings`)
      await page.getByText("Weekly product sync").waitFor({ timeout: 15_000 })
      assert.ok(await page.getByRole("heading", { name: "Gots" }).isVisible())
      assert.ok(await page.getByRole("heading", { name: "Website" }).isVisible())
      if (width >= 1024)
        assert.ok(await page.getByRole("link", { name: "Meetings" }).isVisible(), "sidebar row")
      await shot("1-list")
      pass(`${width}: the sample meetings show by project`)

      // A ready meeting: notes, then a timestamp opens the transcript at its line.
      await page.getByText("Weekly product sync").click()
      await page.getByRole("heading", { name: "Action items" }).waitFor({ timeout: 5_000 })
      await shot("2-notes")
      await page.getByRole("button", { name: "Open the transcript at 1:52" }).click()
      const line = page.getByText("Yes, I'll send the tester link today.")
      await line.waitFor({ timeout: 5_000 })
      assert.equal(
        await page.getByRole("tab", { name: "Transcript" }).getAttribute("aria-selected"),
        "true",
      )
      await page.waitForTimeout(600)
      assert.ok(await line.isVisible())
      await shot("3-transcript")
      await page.getByRole("tab", { name: "Your notes" }).click()
      await page.getByText("android push untested!").waitFor({ timeout: 5_000 })
      pass(`${width}: a timestamp opens the transcript at its line`)

      // Record, type notes, stop, and follow it to its notes.
      await page.getByRole("button", { name: "Back to Meetings" }).click()
      await page.getByRole("button", { name: "Record", exact: true }).click()
      await page.getByText("Recording", { exact: true }).waitFor({ timeout: 5_000 })
      await page.getByRole("textbox", { name: "Title" }).fill("Plan for the import flow")
      await page.getByRole("textbox", { name: "Notes" }).fill("import first\nno speaker names yet")
      await page.waitForTimeout(2_200)
      await shot("4-recording")
      await page.getByRole("button", { name: "Pause" }).click()
      await page.getByText("Paused", { exact: true }).waitFor()
      await page.getByRole("button", { name: "Stop" }).click()
      await page.waitForURL("**/meetings/m_*", { timeout: 5_000 })
      await page
        .getByText(/Uploading|Transcribing/)
        .first()
        .waitFor({ timeout: 5_000 })
      await shot("5-progress")
      await page.getByRole("heading", { name: "Action items" }).waitFor({ timeout: 20_000 })
      pass(`${width}: a recording is written up as notes`)

      // An audio file from the device.
      await page.getByRole("button", { name: "Back to Meetings" }).click()
      await page.getByRole("button", { name: "Add recording" }).click()
      await page
        .locator("input[type=file]")
        .setInputFiles({ name: "standup.wav", mimeType: "audio/wav", buffer: silence() })
      await page.getByText("standup.wav").waitFor({ timeout: 5_000 })
      assert.equal(await page.getByLabel("Title").inputValue(), "standup")
      await shot("6-add")
      await page.getByRole("button", { name: "Add", exact: true }).click()
      await page.waitForURL("**/meetings/m_*", { timeout: 5_000 })
      await page.getByRole("heading", { name: "Action items" }).waitFor({ timeout: 20_000 })
      pass(`${width}: an added file is written up as notes`)

      // The failed sample, tried again.
      await page.getByRole("button", { name: "Back to Meetings" }).click()
      await page.getByText("Call with an early tester").click()
      await page.getByRole("button", { name: "Try again" }).waitFor({ timeout: 5_000 })
      await shot("7-failed")
      await page.getByRole("button", { name: "Try again" }).click()
      await page.getByRole("heading", { name: "Action items" }).waitFor({ timeout: 20_000 })
      pass(`${width}: a failed meeting runs again`)

      await page.getByRole("button", { name: "Meeting options" }).click()
      await page.getByRole("menuitem", { name: "Delete" }).click()
      await page.getByRole("button", { name: "Delete" }).click()
      await page.waitForURL("**/meetings", { timeout: 5_000 })
      assert.equal(await page.getByText("Call with an early tester").count(), 0)
      pass(`${width}: Delete removes a meeting`)
    },
    { viewport: { width, height: width < 768 ? 844 : 900 }, dark },
  )
}

// Resources the sandbox can't reach (models.dev, rankings) aren't the screen's errors.
const real = errors.filter((e) => !/Failed to load resource|CORS policy/.test(e))
assert.deepEqual(real, [], "no console errors")
pass("no console errors")
