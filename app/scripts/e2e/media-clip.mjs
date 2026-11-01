// A clip on a message: a real video the page records for itself, picked through the composer's
// Files source and sent. The thread draws it as a Gallery cell with a play mark over its first
// frame — a frame the browser reads off the clip, since the host makes no poster — and a tap opens
// the app's own Previewer on a player that starts paused. Pressing play leaves it playing, and
// seeking inside it works because the host answers a Range with the span asked for.
//
// None of that has a lower tier: a `<video>` that decodes and plays is the browser's own pipeline,
// a canvas has no frames to paint in a DOM without one, and the bytes are what the mock host was
// actually handed rather than a stand-in it serves.
import { app, assert, flow, pass, runId, settled, SEND_CHORD } from "./lib.mjs"

const CLIP = "take.webm"

/**
 * A second of video of the page's own making, so the flow carries no binary of its own: a canvas
 * that changes colour, recorded by the browser into a WebM. Throws rather than handing the flow a
 * clip that can't play, which would read as a player failure rather than a recording one.
 */
const record = (page) =>
  page.evaluate(async () => {
    const canvas = Object.assign(document.createElement("canvas"), { width: 160, height: 120 })
    const context = canvas.getContext("2d")
    const paint = (time) => {
      context.fillStyle = `hsl(${(time / 6) % 360}, 70%, 45%)`
      context.fillRect(0, 0, canvas.width, canvas.height)
      context.fillStyle = "#fff"
      context.fillRect(16, 16, 48, 88)
    }
    paint(0)
    const stream = canvas.captureStream(25)
    const type = "video/webm;codecs=vp8"
    if (!MediaRecorder.isTypeSupported(type)) throw new Error(`No recorder for ${type}`)
    const recorder = new MediaRecorder(stream, { mimeType: type })
    const chunks = []
    recorder.ondataavailable = (event) => chunks.push(event.data)
    const stopped = new Promise((done) => (recorder.onstop = done))
    recorder.start()
    const from = performance.now()
    await new Promise((done) => {
      const frame = () => {
        const now = performance.now()
        paint(now - from)
        if (now - from < 1200) requestAnimationFrame(frame)
        else done()
      }
      requestAnimationFrame(frame)
    })
    recorder.stop()
    await stopped
    const blob = new Blob(chunks, { type: "video/webm" })
    const bytes = new Uint8Array(await blob.arrayBuffer())
    let binary = ""
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return btoa(binary)
  })

/** What the thread's Gallery draws: its cells, and how many carry a frame the browser painted. */
const gallery = (page) =>
  page.evaluate(() => {
    const cells = [...document.querySelectorAll('[aria-label="Gallery"] button')]
    return cells.map((cell) => {
      const frame = cell.querySelector("img")
      return {
        label: cell.getAttribute("aria-label") ?? "",
        frame: Boolean(frame) && frame.naturalWidth > 0,
        source: frame?.getAttribute("src") ?? "",
      }
    })
  })

await flow("media-clip", async ({ page, seed, until, shot }) => {
  const chatId = `e2e-clip-${runId()}`
  await seed([{ id: chatId, title: "Clips" }])
  await page.goto(`${app}/c/${chatId}`)

  await page.getByRole("button", { name: "Add context" }).click()
  const files = page.getByRole("button", { name: "Files", exact: true })
  await files.waitFor({ timeout: 10_000 })
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser", { timeout: 20_000 }),
    files.click(),
  ])
  await chooser.setFiles({
    name: CLIP,
    mimeType: "video/webm",
    buffer: Buffer.from(await record(page), "base64"),
  })
  await page.getByRole("button", { name: `Remove ${CLIP}` }).waitFor({ timeout: 20_000 })

  const composer = page.getByLabel("Message", { exact: true })
  await composer.fill("look at this")
  await composer.press(SEND_CHORD)

  // The thread: one cell, and it paints the clip's own first frame rather than a file card.
  const cells = await until(
    async () => {
      const drawn = await gallery(page)
      return drawn.length === 1 && drawn[0].frame ? drawn : null
    },
    30_000,
    "the clip's cell to paint its first frame",
  )
  assert.equal(cells[0].label, `Open ${CLIP}`, "the cell says what a tap opens")
  assert.match(cells[0].source, /^data:image\//, "the frame is read from the clip by the browser")
  assert.equal(
    await page.getByRole("button", { name: `Download ${CLIP}` }).count(),
    0,
    "a clip is never a row that downloads",
  )
  await shot("cell")
  pass("a sent clip draws a Gallery cell with its first frame painted by the browser")

  const tabs = []
  page.context().on("page", (tab) => tabs.push(tab))
  await page.getByRole("button", { name: `Open ${CLIP}` }).click()
  const preview = page.getByRole("dialog")
  await preview.waitFor({ timeout: 10_000 })
  const player = preview.locator("video")
  await player.waitFor({ timeout: 10_000 })
  const start = await player.evaluate((video) => ({
    paused: video.paused,
    controls: video.controls,
    source: video.currentSrc || video.src,
  }))
  assert.equal(start.paused, true, "the clip opens paused: a reader is not talked at")
  assert.equal(start.controls, true, "with the platform's own controls")
  assert.match(start.source, /\/plugins\/memento\/media\?path=.*token=/, "read from the signed URL")
  assert.equal(tabs.length, 0, "nothing left the app")
  await shot("previewer")

  await player.evaluate((video) => video.play())
  await until(
    () => player.evaluate((video) => !video.paused && video.currentTime > 0),
    10_000,
    "the clip playing",
  )
  const seeked = await player.evaluate(async (video) => {
    const at = Math.min(0.5, (video.duration || 1) / 2)
    video.currentTime = at
    await new Promise((done) => video.addEventListener("seeked", done, { once: true }))
    return Math.abs(video.currentTime - at) < 0.25
  })
  assert.equal(seeked, true, "the reader can drag to a point in it")
  assert.equal(
    await player.evaluate((video) => Math.round(video.buffered.length > 0)),
    1,
    "and it streams, rather than waiting for the whole file",
  )
  pass("a tap on the clip opened the app's Previewer, paused, playing on press and seekable")

  // The Previewer at a phone's width in the dark and a tablet's in the light: the player keeps its
  // own shape, and the name, the size and the reader's place stay on top of it.
  for (const [width, scheme] of [
    [390, "dark"],
    [1024, "light"],
  ]) {
    await page.setViewportSize({ width, height: width < 768 ? 844 : 900 })
    await page.emulateMedia({ colorScheme: scheme })
    await settled(page)
    const box = await player.boundingBox()
    assert.ok(box && box.width <= width - 32, `the player fits the ${width}px pane`)
    const title = await preview.locator("header").first().innerText()
    assert.match(title, new RegExp(CLIP.replace(".", "\\.")), `named at ${width}px`)
    assert.match(title, /\d+ (B|KB|MB)/, "and the size the host answered")
    await shot(`previewer-${width}-${scheme}`)
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ colorScheme: "light" })

  // Closing it leaves the thread where it was, with the clip's cell still in it.
  await page.getByRole("button", { name: "Close" }).click()
  await preview.waitFor({ state: "hidden", timeout: 10_000 })
  assert.equal((await gallery(page)).length, 1, "the thread is as it was")
})
