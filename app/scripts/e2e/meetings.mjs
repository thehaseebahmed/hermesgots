// Meetings, the Developer-gated design mock: the sidebar row only with the switch on, the sample
// meetings by when they happened, searched and filtered by project, a recap's timeline and a time opening its topic at that line, an action
// started and a question answered, a recording with a marked moment walked through to its recap,
// an uploaded recording, a transcript file and a pasted one, a failed meeting tried again, and Delete. At phone,
// tablet (dark) and laptop widths, with no errors in the console.
import { app, assert, flow, pass, settled } from "./lib.mjs"

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

const SRT = `1
00:00:01,000 --> 00:00:04,000
Welcome to the retro.

2
00:00:05,500 --> 00:00:09,000
What went well this sprint?
`

const PASTED = `[00:03] Alex: Should the free plan keep three bots?
[00:21] Sam: Two, and a third once you link a host.
[00:47] Alex: Fine, let's try that for the beta.`

const errors = []
for (const [width, dark] of [
  [390, false],
  [1024, true],
  [1440, false],
]) {
  await flow(
    `meetings-${width}${dark ? "-dark" : ""}`,
    async ({ page, shot }) => {
      page.on("pageerror", (error) => errors.push(`${width}: ${error.message}`))
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(`${width}: ${message.text()}`)
      })
      // Beside the meeting from 1280px, the list needs no way back to it.
      const toList = async () => {
        if (width < 1280) await page.getByRole("button", { name: "Back to Meetings" }).click()
      }
      const newMeeting = async (tab) => {
        await page.getByRole("button", { name: "New meeting" }).click()
        await page.getByRole("tab", { name: tab }).click()
      }
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
      // A second bot, so the cards that switch between them show.
      await page.evaluate(async () => {
        const { db } = await import("/src/lib/db.ts")
        const [first] = await db.profiles.toArray()
        await db.profiles.put({ ...first, id: "e2e-second", name: "Second", botId: "penny" })
      })
      await page.goto(`${app}/meetings`)
      await page.getByText("Weekly product sync").waitFor({ timeout: 15_000 })
      if (width >= 1280) {
        // The third pane is never empty: the top meeting is open.
        await page.waitForURL("**/meetings/m_*", { timeout: 5_000 })
        pass(`${width}: the first meeting opens beside the list`)
        await page.goto(`${app}/meetings`)
        await page.waitForURL("**/meetings/m_*", { timeout: 5_000 })
      }
      for (const group of ["Waiting on you", "Today", "Earlier"])
        assert.ok(await page.getByRole("heading", { name: group }).isVisible(), group)
      if (width >= 1024)
        assert.ok(await page.getByRole("link", { name: "Meetings" }).isVisible(), "sidebar row")
      await shot("1-list")
      pass(`${width}: the sample meetings show by when they happened`)

      // New meeting is one sheet with two tabs; the bot's cards switch the bot sitting in.
      await newMeeting("Record")
      await shot("1c-new")
      const cards = page.getByRole("group", { name: "Bot" })
      await cards.getByRole("button", { name: "Second", exact: false }).click()
      await page.getByText(/Kindly start/).waitFor({ timeout: 5_000 })
      await cards.getByRole("button", { name: "Second", pressed: true }).waitFor({ timeout: 5_000 })
      pass(`${width}: a card switches the bot and its line`)
      await page.getByRole("button", { name: "Start recording" }).waitFor()
      await page.keyboard.press("Escape")
      await page.getByRole("button", { name: "Start recording" }).waitFor({ state: "detached" })

      // Search reads the write-ups too, and a project chip narrows the list.
      const search = page.getByRole("searchbox", { name: "Search meetings" })
      await search.fill("tagline")
      await page.getByText("Weekly product sync").waitFor({ state: "detached", timeout: 2_000 })
      assert.ok(await page.getByText("Landing page review").isVisible())
      await shot("1b-search")
      await search.fill("nothing like this")
      await page.getByText("No meetings match.").waitFor()
      await page.getByRole("button", { name: "Show all" }).click()
      await page.getByText("Weekly product sync").waitFor()
      const projects = page.getByRole("group", { name: "Projects" })
      await projects.getByRole("button", { name: "Website" }).click()
      await page.getByText("Weekly product sync").waitFor({ state: "detached", timeout: 2_000 })
      assert.ok(await page.getByText("Design crit: onboarding").isVisible())
      await projects.getByRole("button", { name: "All" }).click()
      await page.getByText("Weekly product sync").waitFor()
      pass(`${width}: search and the project chips narrow the list`)

      // A ready meeting: the bot's recap, the timeline and what to do.
      await page.getByText("Weekly product sync").click()
      await page.getByRole("heading", { name: "To do" }).waitFor({ timeout: 5_000 })
      assert.ok(await page.getByRole("region", { name: "Timeline" }).isVisible())
      await shot("2-recap")
      pass(`${width}: a ready meeting opens on its recap and timeline`)

      // From 1280px the list stays beside the meeting, with the open one marked.
      const listed = page.getByRole("searchbox", { name: "Search meetings" })
      if (width >= 1280) {
        assert.ok(await listed.isVisible(), "list stays beside the meeting")
        assert.equal(
          await page.locator("[aria-current]").filter({ hasText: "Weekly product sync" }).count(),
          1,
        )
        assert.equal(await page.getByRole("button", { name: "Back to Meetings" }).count(), 0)
        const box = await listed.boundingBox()
        assert.ok(box && box.x > 300 && box.x < 400, "list is a pane right of the sidebar")
        await shot("2b-panes")
      } else assert.equal(await listed.count(), 0, "list is replaced below 1280px")
      pass(
        `${width}: ${width >= 1280 ? "the list stays beside the meeting" : "the meeting replaces the list"}`,
      )

      // A time opens its topic with the transcript at that line.
      await page.getByRole("button", { name: "Play from 1:52" }).first().click()
      await page.getByRole("heading", { name: "The beta date" }).waitFor({ timeout: 5_000 })
      const line = page.getByText("Yes, I'll send the tester link today.")
      await line.waitFor({ timeout: 5_000 })
      assert.equal(
        await page.getByRole("tab", { name: "Transcript" }).getAttribute("aria-selected"),
        "true",
      )
      await page.getByRole("button", { name: "Play", exact: true }).click()
      await page.getByRole("button", { name: "Pause", exact: true }).waitFor({ timeout: 2_000 })
      await settled(page)
      assert.ok(await line.isVisible())
      await shot("3-topic")
      await page.getByRole("tab", { name: "Summary" }).click()
      await page.getByText("Firebase push still isn't tested on a real phone.").waitFor()
      pass(`${width}: a time opens its topic, playing from that line`)

      // Start an action, and ask the bot about the meeting.
      await page.getByRole("button", { name: "Back to Weekly product sync" }).click()
      await page
        .getByRole("button", { name: "Start a session: Send the Android tester link" })
        .click()
      await page.getByText("Started", { exact: true }).waitFor({ timeout: 5_000 })
      await page.getByRole("button", { name: "What did we decide?" }).click()
      await page.getByText("You decided:").waitFor({ timeout: 5_000 })
      await shot("4-ask")
      pass(`${width}: an action starts and the bot answers a question`)

      // Record: mark a moment, write a note, end it and follow it to its recap.
      await toList()
      const listUrl = page.url()
      await newMeeting("Record")
      await page.getByRole("button", { name: "Start recording" }).click()
      await page.getByText("Recording", { exact: true }).waitFor({ timeout: 5_000 })
      // A full-screen popup over the list, not a screen of its own.
      assert.equal(page.url(), listUrl, "recording is a popup, not a route")
      const cover = await page.getByRole("dialog").boundingBox()
      assert.ok(cover && cover.width >= width - 1 && cover.height >= (width < 768 ? 843 : 899))
      await page.getByRole("textbox", { name: "Title" }).fill("Plan for the import flow")
      await page.waitForTimeout(1_200)
      await page.getByRole("button", { name: "Decision" }).click()
      await page.getByLabel("1 marked").waitFor()
      await page.getByRole("button", { name: "Notes" }).click()
      await page
        .getByRole("textbox", { name: "Your notes" })
        .fill("import first\nno speaker names yet")
      await page.getByRole("button", { name: "Done" }).click()
      await shot("5-recording")
      await page.getByRole("button", { name: "Pause" }).click()
      await page.getByText("Paused", { exact: true }).waitFor()
      await page.getByRole("button", { name: "End meeting" }).click()
      await page.waitForURL("**/meetings/m_*", { timeout: 5_000 })
      await page
        .getByText(/Uploading|Transcribing/)
        .first()
        .waitFor({ timeout: 5_000 })
      await shot("6-progress")
      await page.getByRole("heading", { name: "To do" }).waitFor({ timeout: 20_000 })
      assert.ok(await page.getByText("You marked").first().isVisible(), "the marked moment")
      pass(`${width}: a recording with a marked moment is written up`)

      // An audio file from the device.
      await toList()
      await newMeeting("Upload")
      await page
        .locator("input[type=file]")
        .first()
        .setInputFiles({ name: "standup.wav", mimeType: "audio/wav", buffer: silence() })
      await page.getByText("standup.wav").waitFor({ timeout: 5_000 })
      assert.equal(await page.getByLabel("Title").count(), 0, "just a file and a project")
      await shot("7-add")
      await page.getByRole("button", { name: "Add", exact: true }).click()
      await page.waitForURL("**/meetings/m_*", { timeout: 5_000 })
      await page.getByRole("heading", { name: "To do" }).waitFor({ timeout: 20_000 })
      pass(`${width}: an added file is written up as notes`)

      // A transcript is told by its extension: one file and a project, no mode to pick.
      await toList()
      await newMeeting("Upload")
      const picker = page.locator("input[type=file]").first()
      await picker.setInputFiles({
        name: "retro.srt",
        mimeType: "application/x-subrip",
        buffer: Buffer.from(SRT),
      })
      await page.getByText("2 lines · 9 s").waitFor({ timeout: 5_000 })
      await picker.setInputFiles({
        name: "pricing-chat.txt",
        mimeType: "text/plain",
        buffer: Buffer.from(PASTED),
      })
      await page.getByText("3 lines · 50 s").waitFor()
      await shot("7b-transcript")
      await page.getByRole("button", { name: "Add", exact: true }).click()
      await page.waitForURL("**/meetings/m_*", { timeout: 5_000 })
      await page.getByText("pricing-chat").first().waitFor()
      // Beside the list, the earlier upload's row says Transcribing, so only look when it's alone.
      if (width < 1280)
        assert.equal(await page.getByText(/Uploading|Transcribing/).count(), 0, "no upload step")
      await page.getByRole("heading", { name: "To do" }).waitFor({ timeout: 10_000 })
      pass(`${width}: a transcript file skips straight to the write-up`)

      // The failed sample, tried again.
      await toList()
      await page.getByText("Call with an early tester").click()
      await page.getByRole("button", { name: "Try again" }).waitFor({ timeout: 5_000 })
      await shot("8-failed")
      await page.getByRole("button", { name: "Try again" }).click()
      await page.getByRole("heading", { name: "To do" }).waitFor({ timeout: 20_000 })
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
