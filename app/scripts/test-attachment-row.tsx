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
  mediaAsks,
  mediaHost,
  mediaReads,
  mount,
  seedChat,
  seedSettings,
  text,
  until,
} from "./component-kit.tsx"

const NAME = "field notes.pdf"
const HOST_PATH = "/home/h/.hermes/memento/attachments/session-1/field notes.pdf"

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
