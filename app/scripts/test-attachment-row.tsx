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
import { attachmentsText } from "@/lib/attachment-text"
import { AttachmentTile } from "@/components/chat/attachments"
import { fakeHost } from "./chat-next-host.ts"
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
  seedChats,
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

test("a file the host never took is drawn, and a tap says there is no copy of it", async () => {
  const profile = botProfile("attachment-row", { apiKey: undefined })
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

test("a photo the browser can't draw is still drawn as a picture", async () => {
  const heic: Attachment = {
    id: "heic-1",
    name: "IMG_0001.heic",
    type: "image/heic",
    size: 4096,
    image: true,
    blob: new Blob(["heic"], { type: "image/heic" }),
  }
  const png: Attachment = {
    id: "png-1",
    name: "cat.png",
    type: "image/png",
    size: 512,
    image: true,
    blob: new Blob(["png"], { type: "image/png" }),
  }
  const browser = stubBrowser()
  try {
    await mount(
      <>
        <AttachmentTile attachment={heic} />
        <AttachmentTile attachment={png} />
      </>,
      async () => {
        assert.deepEqual(
          findAll("img").map((image) => image.getAttribute("alt")),
          ["cat.png"],
          "only the bytes this device can decode are drawn",
        )
        assert.match(text(), /IMG_0001\.heic/, "the HEIC is named")
        assert.match(text(), /4 KB/, "with its size")
        assert.equal(findAll("svg.lucide-image").length, 1, "as the picture it is")
        assert.equal(findAll("svg.lucide-file").length, 0, "never as a plain file")
      },
    )
  } finally {
    browser.restore()
  }
})

test("a staged file, which the host has never been given, opens from its own bytes", async () => {
  // The composer's own tile before the message goes: no path, so these bytes are all there is.
  const profile = botProfile("attachment-row", { apiKey: undefined })
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
  // A bot that can be called draws its chat on chat-next, which folds the rows the host has: the
  // message is the host's, carrying the marker its row was written with.
  const bot = botProfile("attachment-heic")
  await seedChats([{ id: "c1", title: "A chat" }], { bots: [bot] })
  const host = fakeHost("gots-c1", { plugin: true })
  host.seed([{ user: attachmentsText("Look at this", [heic]), reply: "A lovely photo." }])
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
    })
  } finally {
    browser.restore()
  }
})

test("a tap the host refused over a size says its own sentence, not that the file is missing", async () => {
  // The mint answers 413 with the cap it met: that is the one refusal the reader can act on, so the
  // row says it — "there is no copy" of a file the host holds is the drift ADR 0111 is about.
  const sentence = "field notes.pdf is 31 MB; the limit is 25 MB."
  const bot = botProfile("attachment-cap")
  await seedChats([{ id: "c1", title: "A chat" }], { bots: [bot] })
  const host = fakeHost("gots-c1", { plugin: true })
  host.seed([{ user: attachmentsText("Here it is", [attachment]), reply: "Got it." }])
  // The transcript is the host's; the mint is a host that refuses this file for its size.
  const transcript = globalThis.fetch
  mediaHost({ host: "attachment-cap", fail: [NAME], failure: 413, refusal: sentence })
  const mint = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    String(input instanceof Request ? input.url : input).includes("/plugins/gots/media")
      ? mint(input, init)
      : transcript(input, init)) as typeof fetch
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
