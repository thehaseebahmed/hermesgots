/**
 * What a message's media draws as, over a seeded device database with the HTTP boundary faked: one
 * Gallery for the photos and clips, a recording in a row of its own, a file as a row the platform
 * takes — every one of them from the URL the host signed, never from bytes fetched into the app.
 * A photo or a clip keeps its cell whatever its read is doing: a skeleton while its URL is out, and
 * the same cell with a retry after a read that failed. A row that downloads is for a file kind and
 * never the fallback for a picture. Nothing is played in the thread: a tap opens the Previewer.
 */
import assert from "node:assert/strict"
import test from "node:test"

import type { Attachment, Message } from "@/lib/db"

import {
  botProfile,
  chatScreen,
  click,
  findAll,
  mediaHost,
  mediaReads,
  mount,
  seedChat,
  until,
} from "./component-kit.tsx"

const HOST = "/home/h/.hermes/memento/attachments/session-1"

const photo: Attachment = {
  id: "photo",
  name: "cat.png",
  type: "image/png",
  size: 1024,
  image: true,
  blob: new Blob(["png bytes"], { type: "image/png" }),
  path: `${HOST}/cat.png`,
}

const clip: Attachment = {
  id: "clip",
  name: "clip.mp4",
  type: "video/mp4",
  size: 2048,
  image: false,
  path: `${HOST}/clip.mp4`,
}

const voice: Attachment = {
  id: "voice",
  name: "voice.mp3",
  type: "audio/mpeg",
  size: 512,
  image: false,
  path: `${HOST}/voice.mp3`,
}

const notes: Attachment = {
  id: "notes",
  name: "notes.pdf",
  type: "application/pdf",
  size: 4096,
  image: false,
  path: `${HOST}/notes.pdf`,
}

const message = (attachments: Attachment[]): Message => ({
  id: "m1",
  conversationId: "c1",
  role: "user",
  content: "here they are",
  status: "done",
  createdAt: 2,
  attachments,
})

const gallery = () => findAll('[role="group"][aria-label="Gallery"]')[0] ?? null
const cell = (name: string) =>
  findAll("button").find((button) => button.getAttribute("aria-label") === `Open ${name}`) ?? null
const row = (name: string) =>
  findAll("button").find((button) => button.getAttribute("aria-label") === `Play ${name}`) ?? null
const download = (name: string) =>
  findAll("button").find((button) => button.getAttribute("aria-label") === `Download ${name}`) ??
  null

/** Whether the cell or row a file draws in has answered: its place is kept, busy until it has. */
const filled = (button: Element | null) => Boolean(button) && !button!.hasAttribute("aria-busy")

test("a message's photo and clip draw in one Gallery, its recording in a row, its note as a file", async () => {
  const profile = botProfile("media-gallery")
  await seedChat({
    id: "c1",
    profile,
    messages: [message([photo, clip, voice, notes])],
  })
  const asked = mediaHost()
  await mount(chatScreen("c1"), async () => {
    await until(async () => filled(cell("clip.mp4")), "the clip's cell")
    await until(async () => filled(row("voice.mp3")), "the recording's row")
    await until(async () => filled(download("notes.pdf")), "the file's row")

    const cells = gallery()!
    assert.ok(cells.contains(cell("cat.png")), "the photo keeps its place in the Gallery")
    assert.ok(cells.contains(cell("clip.mp4")), "and the clip sits beside it")
    assert.equal(cells.contains(row("voice.mp3")), false, "a recording is not a picture")
    assert.equal(cell("notes.pdf"), null, "a PDF is not media")
    assert.equal(
      findAll('[role="group"][aria-label="Gallery"]').length,
      1,
      "two cells are one Gallery",
    )

    // Every file is drawn from the URL the host signed for it, and nothing is played here.
    assert.match(
      cell("cat.png")!.querySelector("img")?.getAttribute("src") ?? "",
      /\/media\?path=[^&]*cat\.png&token=/,
      "the photo draws from its signed URL",
    )
    assert.equal(document.querySelector("video"), null, "nothing is played in the thread")
    assert.equal(document.querySelector("audio"), null)
    assert.deepEqual(
      mediaReads(asked).map((path) => path.replace(`${HOST}/`, "")).sort(),
      ["cat.png", "clip.mp4", "notes.pdf", "voice.mp3"],
      "every file the message carries, asked for once",
    )

    // A tap on a cell opens the app's own Previewer: the clip plays there, paused.
    await click(cell("clip.mp4"))
    await until(async () => document.querySelector("video") !== null, "the clip's player")
    const player = document.querySelector("video")!
    assert.match(player.getAttribute("src") ?? "", /clip\.mp4/, "on the URL it was drawn from")
    assert.equal(player.hasAttribute("autoplay"), false, "paused until it is pressed")
    await click(findAll("button").find((one) => one.getAttribute("aria-label") === "Close"))

    // And the recording opens the same Previewer, on a player of its own.
    await click(row("voice.mp3"))
    await until(async () => document.querySelector("audio") !== null, "the recording's player")
    assert.match(
      document.querySelector("audio")!.getAttribute("src") ?? "",
      /voice\.mp3/,
      "from its own URL",
    )
  })
})

test("a photo whose URL never answers keeps its cell, never a download row", async () => {
  const profile = botProfile("media-missing")
  await seedChat({ id: "c1", profile, messages: [message([photo])] })
  // A host that can't be asked: nothing settles this file, and the cell says so.
  mediaHost({ fail: ["cat.png"], failure: 503 })
  await mount(chatScreen("c1"), async () => {
    await until(async () => cell("cat.png") !== null, "the photo's cell")
    assert.equal(download("cat.png"), null, "a picture is never handed over as a file to save")
    assert.equal(gallery()?.contains(cell("cat.png")), true, "its place is kept in the Gallery")
  })
})

test("a photo whose read failed offers a retry that asks again and draws", async () => {
  const profile = botProfile("media-retry-cell")
  await seedChat({ id: "c1", profile, messages: [message([photo])] })
  mediaHost({ fail: ["cat.png"], failure: 503 })
  const asked = mediaHost({ fail: ["cat.png"], failure: 503 })
  await mount(chatScreen("c1"), async () => {
    await until(async () => !filled(cell("cat.png")), "the cell that couldn't read")
    assert.equal(download("cat.png"), null, "still not a file to save")
    // The host comes back: the retry in the Previewer asks it again, and the picture draws.
    mediaHost({ asked })
    await click(cell("cat.png"))
    await until(
      async () => findAll("button").some((one) => one.textContent === "Try again"),
      "the retry",
    )
    await click(findAll("button").find((one) => one.textContent === "Try again")!)
    await until(
      async () => document.querySelector('img[alt="cat.png"]') !== null,
      "the photo drawn from the host's answer",
    )
    assert.deepEqual(
      mediaReads(asked).filter((path) => path.endsWith("cat.png")).length,
      2,
      "the retry asked the host a second time",
    )
  })
})
