/**
 * A message's file in the thread, over a seeded device database with the HTTP boundary faked: a
 * file draws as a row naming it and its size, and a tap hands it to the platform — on the web a new
 * tab at the URL the host signed, where the browser shows a PDF and saves an archive under its own
 * name. The thread reads every file through that URL, so the URL is already in hand when the tap
 * comes. A file this device picked before the host was ever given it opens from its own bytes.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { toast } from "sonner"

import type { Attachment, Message } from "@/lib/db"
import {
  botProfile,
  chatScreen,
  click,
  findAll,
  labelled,
  mediaAsks,
  mediaHost,
  mediaReads,
  mount,
  seedChat,
  seedSettings,
  spyOpen,
  text,
  until,
} from "./component-kit.tsx"

const NAME = "field notes.pdf"
const HOST_PATH = "/home/h/.hermes/plugin-data/gots/attachments/session-1/field notes.pdf"

const attachment: Attachment = {
  id: "a1",
  name: NAME,
  type: "application/pdf",
  size: 2048,
  image: false,
  path: HOST_PATH,
}

const message = (attachments: Attachment[]): Message => ({
  id: "m1",
  conversationId: "c1",
  role: "user",
  content: "here it is",
  status: "done",
  createdAt: 2,
  attachments,
})

const row = () =>
  findAll("button").find(
    (button) =>
      button.getAttribute("aria-label") === `Download ${NAME}` ||
      button.getAttribute("aria-label") === `Open ${NAME}`,
  ) ?? null

/** jsdom has no tabs of its own: a tab opening and an object URL both stand in for the browser. */
function stubBrowser() {
  const real = { open: window.open, create: URL.createObjectURL, revoke: URL.revokeObjectURL }
  const opened: string[] = []
  window.open = ((url: string | URL) => {
    opened.push(String(url))
    return null
  }) as typeof window.open
  URL.createObjectURL = (blob: Blob | MediaSource) =>
    `blob:${(blob as Blob).type || "bytes"}-${opened.length + 1}`
  URL.revokeObjectURL = () => {}
  return {
    opened,
    restore: () => {
      window.open = real.open
      URL.createObjectURL = real.create
      URL.revokeObjectURL = real.revoke
    },
  }
}

test("a message's file draws as a row naming it, and a tap opens a tab at the host's URL", async () => {
  const profile = botProfile("attachment-row")
  await seedSettings()
  await seedChat({ id: "c1", profile, messages: [message([attachment])] })
  const asked = mediaHost({ host: "attachment-row" })
  const browser = stubBrowser()
  try {
    await mount(chatScreen("c1"), async () => {
      await until(async () => row() !== null, "the file's row")
      assert.equal(row()!.getAttribute("aria-label"), `Download ${NAME}`, "the row promises a save")
      assert.match(text(), /field notes\.pdf/, "the row names the file")
      assert.match(text(), /2 KB/, "with the size the message stored")
      await click(row())
      await until(async () => browser.opened.length > 0, "the tab")
      assert.equal(browser.opened.length, 1, "one tab for one tap")
      assert.match(
        browser.opened[0],
        /\/media\?path=[^&]*field%20notes\.pdf&token=/,
        "the URL the host signed for the file",
      )
      assert.deepEqual(
        mediaAsks(asked),
        [{ path: HOST_PATH, authorization: "Bearer test-key" }],
        "and it was signed behind the bot's key, which is the app's alone",
      )
    })
  } finally {
    browser.restore()
  }
})

test("a file the host never took is drawn, and a tap says there is no copy of it", async () => {
  const profile = botProfile("attachment-row")
  await seedSettings()
  await seedChat({
    id: "c1",
    profile,
    messages: [message([{ ...attachment, path: undefined }])],
  })
  mediaHost({ host: "attachment-row" })
  const said: string[] = []
  const original = toast.error
  toast.error = ((message: unknown) => {
    said.push(String(message))
  }) as typeof toast.error
  try {
    await mount(chatScreen("c1"), async () => {
      await until(async () => row() !== null, "the file's row")
      assert.match(text(), /field notes\.pdf/, "the row still names the file")
      await click(row())
      await until(async () => said.length > 0, "the refusal")
      assert.deepEqual(said, [`There is no copy of ${NAME}.`], "the tap is honest about it")
    })
  } finally {
    toast.error = original
  }
})

test("a staged file, which the host has never been given, opens from its own bytes", async () => {
  // The composer's own tile before the message goes: no path, so these bytes are all there is.
  const profile = botProfile("attachment-row")
  await seedSettings()
  await seedChat({
    id: "c1",
    profile,
    messages: [
      message([
        {
          ...attachment,
          path: undefined,
          blob: new Blob(["pdf bytes"], { type: "application/pdf" }),
        },
      ]),
    ],
  })
  const asked = mediaHost({ host: "attachment-row" })
  const browser = stubBrowser()
  try {
    await mount(chatScreen("c1"), async () => {
      await until(async () => row() !== null, "the file's row")
      await click(row())
      await until(async () => browser.opened.length > 0, "the tab")
      assert.match(browser.opened[0], /^blob:/, "the bytes this device holds")
      assert.deepEqual(mediaReads(asked), [], "and nothing was asked of the host")
    })
  } finally {
    browser.restore()
  }
})

test("a photo no browser draws is a row that hands it over, not a cell that can never fill", async () => {
  // A phone's HEIC: the route serves it as a binary and no browser paints it, so the message draws a
  // row the platform opens rather than a Gallery cell that would read "Couldn't load" for ever.
  const heic: Attachment = {
    id: "a2",
    name: "photo.heic",
    type: "image/heic",
    size: 4096,
    image: true,
    path: "/home/h/.hermes/plugin-data/gots/attachments/session-1/photo.heic",
  }
  const profile = botProfile("attachment-heic")
  await seedSettings()
  await seedChat({ id: "c1", profile, messages: [message([heic])] })
  const asked = mediaHost({ host: "attachment-heic" })
  const browser = spyOpen()
  try {
    await mount(chatScreen("c1"), async () => {
      await until(
        async () => labelled("button", "Download photo.heic") !== null,
        "the photo's download row",
      )
      assert.equal(
        labelled("button", "Open photo.heic"),
        null,
        "no Gallery cell for a type the browser can't paint",
      )
      await click(labelled("button", "Download photo.heic"))
      await until(async () => browser.opened.length > 0, "the tab")
      assert.match(browser.opened[0], /photo\.heic&token=/, "at the URL the host signed")
      assert.deepEqual(
        mediaAsks(asked).map((one) => one.path),
        [heic.path],
        "and the host was asked for that one file",
      )
    })
  } finally {
    browser.restore()
  }
})

test("a tap the host refused over a size says its own sentence, not that the file is missing", async () => {
  // The mint answers 413 with the cap it met: that is the one refusal the reader can act on, so the
  // row says it — "there is no copy" of a file the host holds is the drift ADR 0111 is about.
  const profile = botProfile("attachment-cap")
  await seedSettings()
  await seedChat({ id: "c1", profile, messages: [message([attachment])] })
  const sentence = "field notes.pdf is 31 MB; the limit is 25 MB."
  mediaHost({ host: "attachment-cap", fail: [NAME], failure: 413, refusal: sentence })
  const said: string[] = []
  const original = toast.error
  toast.error = ((message: unknown) => {
    said.push(String(message))
  }) as typeof toast.error
  try {
    await mount(chatScreen("c1"), async () => {
      await until(async () => row() !== null, "the file's row")
      await click(row())
      await until(async () => said.length > 0, "the refusal")
      assert.deepEqual(said, [sentence], "the host's own words, which name the limit it met")
    })
  } finally {
    toast.error = original
  }
})
