// A message carrying a note, an archive and a photo, sent through the composer's own pickers: the
// photo draws in the thread's Gallery, the note and the archive as rows naming them and their
// sizes, and the agent reads what the message carried. The same message then opens on a device
// holding none of its bytes — read back from the host's transcript, as a chat synced from another
// device is — where it still draws its cells, every one of them from a URL the host signed.
//
// A tap on a cell opens the app's own Previewer on the photo, in the thread it was reading. A tap
// on a file's row hands the file to the browser: a note is shown in a new tab, and an archive —
// which the browser has no viewer for — is saved under its own name, with its bytes in it. That
// second part is the claim no lower tier reaches: the component test fakes the tab, and only the
// browser's own download pipeline saves the file under a name the user can find.
import { statSync } from "node:fs"

import { app, assert, flow, pass, runId } from "./lib.mjs"

const NOTE = "cleanup-notes.md"
const NOTES = "# Cleanup notes\n\nNothing renamed, nothing lost.\n"
const NOTE_SIZE = `${Buffer.byteLength(NOTES)} B`
const ARCHIVE = "logs.zip"
const ARCHIVES = "PK\u0003\u0004 a zip the browser has no viewer for"
const ARCHIVE_SIZE = `${Buffer.byteLength(ARCHIVES)} B`
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

/** The Gallery's cells, how many of them have painted, and the URL each one draws from. */
const gallery = (page) =>
  page.evaluate(() => {
    const images = [...document.querySelectorAll('[aria-label="Gallery"] button img')]
    return {
      cells: images.length,
      painted: images.filter(
        (img) => img.naturalWidth > 0 && getComputedStyle(img).visibility !== "hidden",
      ).length,
      sources: images.map((img) => img.getAttribute("src") ?? ""),
    }
  })

await flow("file-message", async ({ page, seed, until, shot }) => {
  const chatId = `e2e-files-${runId()}`
  await seed([{ id: chatId, title: "Files" }])
  await page.goto(`${app}/c/${chatId}`)

  // Files reach Hermes only through the plugin's upload route, so the picker is offered for the
  // bot whose host advertises it.
  assert.equal(
    await pick(page, "Files", {
      name: NOTE,
      mimeType: "text/markdown",
      buffer: Buffer.from(NOTES),
    }),
    true,
    "a host with the plugin offers Files",
  )
  await pick(page, "Files", {
    name: ARCHIVE,
    mimeType: "application/zip",
    buffer: Buffer.from(ARCHIVES),
  })
  await pick(page, "Photos", {
    name: PHOTO,
    mimeType: "image/png",
    buffer: Buffer.from(await png(page), "base64"),
  })
  for (const name of [NOTE, ARCHIVE, PHOTO])
    await page.getByRole("button", { name: `Remove ${name}` }).waitFor({ timeout: 10_000 })

  const composer = page.getByLabel("Message", { exact: true })
  await composer.fill(SAID)
  await composer.press("Enter")

  const note = page.getByRole("button", { name: `Download ${NOTE}` })
  const archive = page.getByRole("button", { name: `Download ${ARCHIVE}` })
  await note.waitFor({ timeout: 20_000 })
  await archive.waitFor({ timeout: 20_000 })
  const cells = await until(
    async () => {
      const drawn = await gallery(page)
      return drawn.cells === 1 && drawn.painted === 1 ? drawn : null
    },
    20_000,
    "the photo to paint in its Gallery cell",
  )
  assert.match(
    cells.sources[0],
    /\/plugins\/memento\/media\?path=[^&]*&token=/,
    "the cell draws from a URL the host signed",
  )
  const rowText = await note.innerText()
  assert.match(rowText, new RegExp(NOTE.replace(".", "\\.")), "the row names the note")
  assert.match(rowText, new RegExp(NOTE_SIZE), `the row carries the note's size (${NOTE_SIZE})`)
  assert.match(await archive.innerText(), new RegExp(ARCHIVE_SIZE), "and the archive's")
  assert.equal((await gallery(page)).cells, 1, "a file is a row, not a cell")
  // What the model was told: the mock answers with the markers a message carries — all three.
  await page
    .getByText(
      new RegExp(
        `Got 3 attachments: ${NOTE.replace(".", "\\.")}, ${ARCHIVE.replace(".", "\\.")}, ${PHOTO.replace(".", "\\.")}`,
      ),
    )
    .waitFor({ timeout: 20_000 })
  await shot("sent")
  pass(`a sent message draws its photo as ${cells.cells} Gallery cell and its files as rows`)

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
    if (url.pathname.endsWith("/plugins/memento/media/url")) reads.push(url.pathname)
  })
  await page.goto(`${app}/c/${elsewhere}`)
  await note.waitFor({ timeout: 20_000 })
  await until(
    async () => {
      const drawn = await gallery(page)
      return drawn.cells === 1 && drawn.painted === 1 ? drawn : null
    },
    20_000,
    "the photo the host serves to paint",
  )
  const restored = await note.innerText()
  assert.match(restored, new RegExp(NOTE.replace(".", "\\.")), "the row names the note here too")
  assert.match(restored, new RegExp(NOTE_SIZE), "and carries the size the transcript kept")
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

  // A tap on the photo opens the app's own Previewer, in the thread it was reading: no tab, no
  // pop-up of the platform's.
  const opened = []
  page.context().on("page", (tab) => opened.push(tab))
  await page.getByRole("button", { name: `Open ${PHOTO}` }).click()
  const preview = page.getByRole("dialog")
  await preview.waitFor({ timeout: 10_000 })
  await page.getByRole("button", { name: "Close" }).waitFor({ timeout: 10_000 })
  assert.equal(await preview.getByRole("img", { name: PHOTO }).count(), 1, "the photo is drawn")
  assert.equal(
    await preview.getByRole("button", { name: "Remove" }).count(),
    0,
    "a sent message has no Remove in it",
  )
  await shot("previewer")
  pass("a tap on the photo opened the app's Previewer, with no tab and no platform viewer")
  await page.getByRole("button", { name: "Close" }).click()
  assert.equal(opened.length, 0, "nothing opened outside the app")

  // A tap on a note's row opens it in a new tab, where the browser shows it in place.
  const [tab] = await Promise.all([
    page.context().waitForEvent("page", { timeout: 20_000 }),
    note.click(),
  ])
  await tab.waitForLoadState("domcontentloaded").catch(() => {})
  assert.match(tab.url(), /\/plugins\/memento\/media\?path=.*token=/, "at the file's signed URL")
  const shown = await tab.evaluate(() => document.body.innerText)
  assert.match(shown, /Cleanup notes/, "where the browser shows the note in place")
  pass(`a tap on the note opened a tab at ${tab.url().split("?")[0]}`)
  await tab.close()

  // And a tap on an archive's row hands it to the browser, which saves it under its own name.
  const [download] = await Promise.all([
    page.context().waitForEvent("download", { timeout: 20_000 }),
    archive.click(),
  ])
  assert.equal(
    download.suggestedFilename(),
    ARCHIVE,
    "the browser saves the file under its own name",
  )
  const path = await download.path()
  assert.ok(path, "the browser wrote the file out")
  assert.ok(statSync(path).size > 0, "and it holds the bytes the host served")
  assert.ok(reads.length > 0, "every file was read from a URL the host signed")
  pass(
    `a tap on the archive downloaded ${download.suggestedFilename()} from the host's media route`,
  )
})
