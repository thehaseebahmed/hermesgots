// Meetings on the mock plugin, behind the Developer switch: a transcript file written up as notes, a
// recording sent in chunks and followed through its stages to the notes (a bullet with no source
// marked, an owner the transcript never names said so), a cited time opening the transcript at that
// line, a recording that fails once and is tried again, an upload nothing finished, search, and
// Delete. At phone, tablet (dark) and laptop widths (the meeting beside the list from 1280px), with
// no errors in the console.
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

const SRT = `1
00:00:01,000 --> 00:00:04,000
Welcome to the retro.

2
00:00:05,500 --> 00:00:09,000
What went well this sprint?
`

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
      const addFile = async (file) => {
        await page.getByRole("button", { name: "New meeting" }).click()
        await page.getByRole("tab", { name: "Upload" }).click()
        await page.locator("input[type=file]").first().setInputFiles(file)
      }
      // Adding goes to the new meeting; beside the list another one may already be open.
      const add = async () => {
        const before = page.url()
        await page.getByRole("button", { name: "Add", exact: true }).click()
        await page.waitForURL((url) => /\/meetings\/m_/.test(url.pathname) && url.href !== before, {
          timeout: 5_000,
        })
      }
      // A meeting's row in the list (beside the list its title is also the open meeting's heading).
      const row = (title) => page.locator("li").filter({ hasText: title })
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
      await page.getByRole("button", { name: "New meeting" }).first().waitFor({ timeout: 15_000 })
      if (width >= 1024)
        assert.ok(await page.getByRole("link", { name: "Meetings" }).isVisible(), "sidebar row")
      await shot("1-list")

      // A transcript file skips the upload and the transcription: one file, no mode to pick.
      const retro = `retro-${width}`
      await addFile({
        name: `${retro}.srt`,
        mimeType: "application/x-subrip",
        buffer: Buffer.from(SRT),
      })
      await page.getByText("2 lines · 9 s").waitFor({ timeout: 5_000 })
      await shot("2-add")
      await add()
      // Wait on this meeting's own words: the one that was open is still on screen while the pane slides.
      await page.getByText("2 lines were said").waitFor({ timeout: 15_000 })
      // Beside the list the other meetings' rows are on screen, so look only when it's alone.
      if (width < 1280)
        assert.equal(await page.getByText(/Uploading|Transcribing/).count(), 0, "no upload step")
      for (const section of ["Decisions", "Action items", "Open questions"])
        assert.ok(await page.getByRole("heading", { name: section }).isVisible(), section)
      assert.equal(await page.getByText("None recorded").count(), 3, "empty sections say so")
      pass(`${width}: a transcript file is written up as notes`)

      // A cited time opens the transcript at that line.
      await page.getByRole("button", { name: "Show 0:05 in the transcript" }).click()
      assert.equal(
        await page.getByRole("tab", { name: "Transcript" }).getAttribute("aria-selected"),
        "true",
      )
      await page.getByText("What went well this sprint?").waitFor({ timeout: 5_000 })
      pass(`${width}: a cited time opens the transcript`)

      // A recording goes up in chunks and moves through the host's stages to its notes.
      await toList()
      const standup = `standup-${width}`
      await addFile({ name: `${standup}.wav`, mimeType: "audio/wav", buffer: silence() })
      await page.getByText(`${standup}.wav`).waitFor({ timeout: 5_000 })
      await add()
      await page
        .getByText(/Uploading|Transcribing/)
        .first()
        .waitFor({ timeout: 5_000 })
      await shot("3-progress")
      await page.getByText("Beta date").first().waitFor({ timeout: 20_000 })
      assert.ok(await page.getByRole("region", { name: "Timeline" }).isVisible(), "the timeline")
      assert.ok(await page.getByRole("heading", { name: "Topics" }).isVisible(), "the topics")
      assert.ok(await page.getByText("3 decisions, 3 to do and 1 left open.").isVisible(), "the tally")
      assert.ok(await page.getByText("Unsourced").first().isVisible(), "a bullet with no source")
      assert.ok(await page.getByText("(Owner not stated)").first().isVisible(), "no invented owner")
      await shot("4-notes")
      pass(`${width}: a recording is sent, transcribed and written up`)

      // The room recorded in the app: a stand-in microphone, pause, end, and the file goes up.
      await toList()
      await page.evaluate(() => {
        navigator.mediaDevices.getUserMedia = async () => {
          const context = new AudioContext()
          const tone = context.createOscillator()
          const out = context.createMediaStreamDestination()
          tone.connect(out)
          tone.start()
          return out.stream
        }
      })
      await page.getByRole("button", { name: "New meeting" }).click()
      await page.getByRole("button", { name: "Start recording" }).click()
      await page.getByRole("timer").waitFor({ timeout: 5_000 })
      await page.waitForFunction(
        () => /^0:0[1-9]$/.test(document.querySelector("[role=timer]")?.textContent ?? ""),
        undefined,
        { timeout: 10_000 },
      )
      await shot("6-recording")
      await page.getByRole("button", { name: "Pause" }).click()
      const paused = await page.getByRole("timer").textContent()
      await page.waitForTimeout(1200)
      assert.equal(
        await page.getByRole("timer").textContent(),
        paused,
        "the clock holds while paused",
      )
      await page.getByRole("button", { name: "Resume" }).click()
      const before = page.url()
      await page.getByRole("button", { name: "End meeting" }).click()
      await page.waitForURL((url) => /\/meetings\/m_/.test(url.pathname) && url.href !== before, {
        timeout: 10_000,
      })
      // The meeting it replaces stays on screen while the pane slides: wait until only one is left.
      await page.waitForFunction(() => document.body.innerText.split("Beta date").length === 2, undefined, {
        timeout: 20_000,
      })
      pass(`${width}: a meeting recorded in the app is sent and written up`)

      // From 1280px the list stays beside the meeting, with the open one marked.
      const search = page.getByRole("searchbox", { name: "Search meetings" })
      if (width >= 1280) {
        assert.ok(await search.isVisible(), "list stays beside the meeting")
        assert.equal(await page.getByRole("button", { name: "Back to Meetings" }).count(), 0)
        const box = await search.boundingBox()
        assert.ok(box && box.x > 300 && box.x < 400, "list is a pane right of the sidebar")
        await shot("5b-panes")
      } else assert.equal(await search.count(), 0, "list is replaced below 1280px")
      pass(
        `${width}: ${width >= 1280 ? "the list stays beside the meeting" : "the meeting replaces the list"}`,
      )

      // A cited time opens its topic's transcript at that line, and a topic row opens the topic.
      await page.getByRole("button", { name: "Show 0:21 in the transcript" }).first().click()
      await page.getByText("On the beta, I think Thursday still works").waitFor({ timeout: 5_000 })
      assert.ok(await page.getByText("Topic 1 of 3").isVisible(), "the topic's place in the meeting")
      assert.equal(
        await page.getByText("Right, the sidebar").count(),
        0,
        "only the topic's own lines",
      )
      await shot("5-transcript")
      await page.getByRole("button", { name: /^Next: Sidebar/ }).click()
      await page.getByText("Topic 2 of 3").waitFor({ timeout: 5_000 })
      await page.getByRole("tab", { name: "Transcript" }).click()
      await page.getByText("Then let's keep it").waitFor({ timeout: 5_000 })
      await shot("5c-topic")
      await page.getByRole("button", { name: /^Back to / }).click()

      // A step that fails says why, and Try again carries on from it.
      await toList()
      const flaky = `flaky-${width}`
      await addFile({ name: `${flaky}.wav`, mimeType: "audio/wav", buffer: silence() })
      await add()
      await page
        .getByText("The host couldn't transcribe part 2 of 3.")
        .first()
        .waitFor({ timeout: 20_000 })
      await shot("6-failed")
      await page.getByRole("button", { name: "Try again" }).click()
      await page.getByText("Beta date").first().waitFor({ timeout: 20_000 })
      pass(`${width}: a failed meeting runs again`)

      // An upload nothing is finishing: the page that was sending it is gone.
      await toList()
      const stuck = `stuck-${width}`
      await page.evaluate(
        async ({ title }) => {
          const { db } = await import("/src/lib/db.ts")
          const { pluginRoot } = await import("/src/lib/hermes.ts")
          const [bot] = await db.profiles.toArray()
          await fetch(`${pluginRoot(bot.baseUrl)}/meetings`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${bot.apiKey}` },
            body: JSON.stringify({ title, parts: 2 }),
          })
        },
        { title: stuck },
      )
      // A page that comes back reads the list again.
      await page.reload()
      await page.getByText(stuck).first().click({ timeout: 15_000 })
      await page
        .getByText(/The upload didn't finish/)
        .first()
        .waitFor({ timeout: 5_000 })
      assert.equal(await page.getByRole("button", { name: "Try again" }).count(), 0)
      await shot("7-stalled")
      pass(`${width}: an upload nothing finished says so and can only be deleted`)

      // Search narrows the list by title.
      await toList()
      await search.fill(retro)
      await row(stuck).waitFor({ state: "detached", timeout: 2_000 })
      assert.ok(await row(retro).first().isVisible())
      await search.fill("nothing like this")
      await page.getByText("No meetings match.").waitFor()
      await page.getByRole("button", { name: "Show all" }).click()
      await row(stuck).first().waitFor()
      pass(`${width}: search narrows the list`)

      await row(stuck).first().click()
      await page.getByRole("button", { name: "Meeting options" }).click()
      await page.getByRole("menuitem", { name: "Delete" }).click()
      await page.getByRole("button", { name: "Delete" }).click()
      await page.waitForURL(
        (url) => url.pathname === "/meetings" || /\/meetings\/m_/.test(url.pathname),
        { timeout: 5_000 },
      )
      await row(stuck).waitFor({ state: "detached", timeout: 10_000 })
      pass(`${width}: Delete removes a meeting`)
    },
    { viewport: { width, height: width < 768 ? 844 : 900 }, dark },
  )
}

// Resources the sandbox can't reach (models.dev, rankings) aren't the screen's errors.
const real = errors.filter((e) => !/Failed to load resource|CORS policy/.test(e))
assert.deepEqual(real, [], "no console errors")
pass("no console errors")
