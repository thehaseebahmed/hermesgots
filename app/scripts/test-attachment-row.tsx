/**
 * A message's file in the thread, over a seeded device database with the HTTP boundary faked: a
 * file draws as a row naming it and its size, and a tap saves it under its own name — from this
 * device's own bytes where it holds them, else from the bot's plugin media route, with the key a
 * plain link can't carry (spec #478, story 10).
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
  mediaHost,
  mount,
  seedChat,
  seedSettings,
  text,
  until,
} from "./component-kit.tsx"
import type { HostAsk } from "./component-kit.tsx"

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

/** What the media route was asked for, and the key it was asked with. */
const reads = (asked: HostAsk[]) =>
  asked
    .filter((one) => one.path.endsWith("/plugins/memento/media"))
    .map((one) => ({
      path: new URLSearchParams(one.search).get("path") ?? "",
      authorization: one.authorization,
    }))

const row = () =>
  findAll("button").find(
    (button) =>
      button.getAttribute("aria-label") === `Download ${NAME}` ||
      button.getAttribute("aria-label") === `Open ${NAME}`,
  ) ?? null

test("a message's file draws as a row naming it, and a tap saves it under its own name", async () => {
  const profile = botProfile("attachment-row")
  await seedSettings()
  await seedChat({ id: "c1", profile, messages: [message([attachment])] })
  const asked = mediaHost({ host: "attachment-row" })

  // jsdom has no object URLs and no download of its own, so both stand in for the browser's effect.
  const saved: string[] = []
  const anchor = window.HTMLAnchorElement.prototype
  const real = {
    create: URL.createObjectURL,
    revoke: URL.revokeObjectURL,
    click: anchor.click,
  }
  URL.createObjectURL = () => "blob:field-notes"
  URL.revokeObjectURL = () => {}
  anchor.click = function (this: HTMLAnchorElement) {
    saved.push(this.download)
  }
  try {
    await mount(chatScreen("c1"), async () => {
      await until(async () => row() !== null, "the file's row")
      assert.match(text(), /field notes\.pdf/, "the row names the file")
      assert.match(text(), /2 KB/, "with the size the message stored")
      await click(row())
      await until(async () => saved.length > 0, "the download")
      assert.deepEqual(saved, [NAME], "the browser is told the file's own name")
      assert.deepEqual(
        reads(asked),
        [{ path: HOST_PATH, authorization: "Bearer test-key" }],
        "the bytes come from the media route, behind the bot's key",
      )
    })
  } finally {
    URL.createObjectURL = real.create
    URL.revokeObjectURL = real.revoke
    anchor.click = real.click
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

test("a file this device holds is saved from its own bytes, without asking the host", async () => {
  // The row a message holds the bytes of still saves them: it drew `Download` and its tap saves,
  // rather than opening the viewer a file this device happens to hold.
  const profile = botProfile("attachment-row")
  await seedSettings()
  await seedChat({
    id: "c1",
    profile,
    messages: [
      message([
        {
          ...attachment,
          blob: new Blob(["pdf bytes"], { type: "application/pdf" }),
        },
      ]),
    ],
  })
  const asked = mediaHost({ host: "attachment-row" })
  const saved: string[] = []
  const anchor = window.HTMLAnchorElement.prototype
  const real = {
    create: URL.createObjectURL,
    revoke: URL.revokeObjectURL,
    click: anchor.click,
  }
  URL.createObjectURL = () => "blob:local-notes"
  URL.revokeObjectURL = () => {}
  anchor.click = function (this: HTMLAnchorElement) {
    saved.push(this.download)
  }
  try {
    await mount(chatScreen("c1"), async () => {
      await until(async () => row() !== null, "the file's row")
      assert.equal(row()!.getAttribute("aria-label"), `Download ${NAME}`, "the row promises a save")
      await click(row())
      await until(async () => saved.length > 0, "the download")
      assert.deepEqual(saved, [NAME], "saved under the file's own name")
      assert.deepEqual(reads(asked), [], "the bytes this device holds are never asked of the host")
    })
  } finally {
    URL.createObjectURL = real.create
    URL.revokeObjectURL = real.revoke
    anchor.click = real.click
  }
})
