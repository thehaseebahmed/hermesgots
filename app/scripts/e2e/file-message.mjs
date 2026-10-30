// A message carrying a file and a photo, sent through the composer's own pickers: the photo draws
// in the thread's Gallery, the file as a row naming it and its size, and the agent reads what the
// message carried. The same message then opens on a device holding none of its bytes — read back
// from the host's transcript, as a chat synced from another device is — where it draws the same and
// a tap on the file's row fetches it through the plugin's media route and hands it to the browser as
// a download under the file's own name. That download is the claim no lower tier reaches: the
// component test fakes the anchor the browser clicks, and only the browser's own download pipeline
// saves the file under a name the user can find.
import { statSync } from "node:fs"

import { app, assert, flow, pass, runId } from "./lib.mjs"

const FILE = "cleanup-notes.md"
const NOTES = "# Cleanup notes\n\nNothing renamed, nothing lost.\n"
const SIZE = `${Buffer.byteLength(NOTES)} B`
const PHOTO = "chart.png"
const SAID = "here is the plan"

/** A PNG of the page's own making, so the flow carries no binary of its own. */
const png = (page) =>
  page.evaluate(() => {
    const canvas = Object.assign(document.createElement("canvas"), { width: 64, height: 48 })
    const context = canvas.getContext("2d")
    context.fillStyle = "#3b7"
    context.fillRect(0, 0, 64, 48)
    context.fillStyle = "#fff"
    context.fillRect(8, 8, 24, 30)
    return canvas.toDataURL("image/png").split(",")[1]
  })

/**
 * A pick through the composer's `+`: the source's own button, and the chooser the browser opens in
 * answer. Answers whether the button was offered — a host without the plugin's `attachments`
 * feature leaves Files out of reach — so a caller can assert the gate it saw.
 */
async function pick(page, source, file) {
  await page.getByRole("button", { name: "Add context" }).click()
  const button = page.getByRole("button", { name: source, exact: true })
  await button.waitFor({ timeout: 10_000 })
  const offered = await button.isEnabled()
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser", { timeout: 10_000 }),
    button.click(),
  ])
  await chooser.setFiles(file)
  return offered
}

/** The Gallery's cells, and how many of them have painted, in the thread. */
const gallery = (page) =>
  page.evaluate(() => {
    const images = [...document.querySelectorAll('[aria-label="Gallery"] button img')]
    return {
      cells: images.length,
      painted: images.filter(
        (img) => img.naturalWidth > 0 && getComputedStyle(img).visibility !== "hidden",
      ).length,
    }
  })

await flow("file-message", async ({ page, seed, until, shot }) => {
  const chatId = `e2e-files-${runId()}`
  await seed([{ id: chatId, title: "Files" }])
  await page.goto(`${app}/c/${chatId}`)

  // Files reaches Hermes only through the plugin's upload route, so the picker is offered for the
  // bot whose host advertises it.
  assert.equal(
    await pick(page, "Files", { name: FILE, mimeType: "text/markdown", buffer: Buffer.from(NOTES) }),
    true,
    "a host with the plugin offers Files",
  )
  await pick(page, "Photos", {
    name: PHOTO,
    mimeType: "image/png",
    buffer: Buffer.from(await png(page), "base64"),
  })
  // Both are on the message before it goes.
  await page.getByRole("button", { name: `Remove ${FILE}` }).waitFor({ timeout: 10_000 })
  await page.getByRole("button", { name: `Remove ${PHOTO}` }).waitFor({ timeout: 10_000 })

  const composer = page.getByLabel("Message", { exact: true })
  await composer.fill(SAID)
  await composer.press("Enter")

  // The thread: the photo in a cell of the Gallery, the file as a row that names it and its size.
  const row = page.getByRole("button", { name: `Download ${FILE}` })
  await row.waitFor({ timeout: 20_000 })
  const cells = await until(
    async () => {
      const drawn = await gallery(page)
      return drawn.cells === 1 && drawn.painted === 1 ? drawn : null
    },
    20_000,
    "the photo to paint in its Gallery cell",
  )
  const rowText = await row.innerText()
  assert.match(rowText, new RegExp(FILE.replace(".", "\\.")), "the row names the file")
  assert.match(rowText, new RegExp(SIZE), `the row carries the file's size (${SIZE})`)
  assert.equal((await gallery(page)).cells, 1, "the file is a row, not a cell")
  // What the model was told: the mock answers with the markers a message carries — both of them,
  // the file and the photo.
  await page
    .getByText(
      new RegExp(`Got 2 attachments: ${FILE.replace(".", "\\.")}, ${PHOTO.replace(".", "\\.")}`),
    )
    .waitFor({ timeout: 20_000 })
  await shot("sent")
  pass(`a sent file draws as a row and its photo as ${cells.cells} Gallery cell, both marked read`)

  // The same message on a device that holds none of it: the chat list names the session, and the
  // thread is read back from the host's transcript.
  const elsewhere = `e2e-files-away-${runId()}`
  await seed([{ id: elsewhere, title: "Files, elsewhere" }])
  await page.evaluate(
    async ({ from, to }) => {
      const { db } = await import("/src/lib/db.ts")
      const chat = await db.conversations.get(from)
      await db.conversations.update(to, { hermesSessionId: chat.hermesSessionId })
    },
    { from: chatId, to: elsewhere },
  )
  const reads = []
  page.on("request", (request) => {
    const url = new URL(request.url())
    if (url.pathname.endsWith("/plugins/memento/media")) reads.push(url.searchParams.get("path"))
  })
  await page.goto(`${app}/c/${elsewhere}`)
  await row.waitFor({ timeout: 20_000 })
  await until(
    async () => {
      const drawn = await gallery(page)
      return drawn.cells === 1 && drawn.painted === 1 ? drawn : null
    },
    20_000,
    "the photo the host serves to paint",
  )
  const restored = await row.innerText()
  assert.match(restored, new RegExp(FILE.replace(".", "\\.")), "the row names the file here too")
  assert.match(restored, new RegExp(SIZE), "and carries the size the transcript kept")
  assert.equal(
    await page.getByText(SAID).first().innerText(),
    SAID,
    "the restored bubble holds the words that were typed",
  )
  assert.equal(
    await page.getByText(/\[Image attached/).count(),
    0,
    "the host's line naming the copy never reads as the message",
  )
  await shot("elsewhere")

  // A tap saves it: the bytes come through the plugin's route, and the browser writes them under
  // the file's own name.
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 20_000 }),
    row.click(),
  ])
  assert.equal(download.suggestedFilename(), FILE, "the browser saves the file under its own name")
  const path = await download.path()
  assert.ok(path, "the browser wrote the file out")
  assert.ok(statSync(path).size > 0, "and it holds the bytes the host served")
  assert.ok(
    reads.some((read) => read?.endsWith(FILE)),
    `the bytes came through the media route (${reads.join(", ")})`,
  )
  pass(`a tap on the row downloaded ${download.suggestedFilename()} from the host's media route`)
})
