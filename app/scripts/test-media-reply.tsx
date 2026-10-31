/**
 * One thread, both halves of the media contract: what the user sent and a reply's `MEDIA:<path>`
 * tags draw through the very same cells — a clip joins the Gallery, a recording takes a row of its
 * own, and any other file a row the platform takes — every one of them from the URL the host signed
 * for it, over one seeded device database with the HTTP boundary faked. Tags sent together are one
 * Gallery, a tag inside a fenced block stays text, and a tag the host can't answer keeps its cell
 * with a retry. A tap on a cell or a row opens the app's Previewer; a file's row opens a new tab.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { act } from "react"

import { db, type Attachment, type Message } from "@/lib/db"

import {
  botProfile,
  chatScreen,
  click,
  findAll,
  mediaHost,
  mediaReads,
  mount,
  seedChat,
  text,
  until,
} from "./component-kit.tsx"

const SENT = "/home/h/.hermes/memento/attachments/session-1"
const LIBRARY = "/home/h/.hermes/library"

const photo: Attachment = {
  id: "photo",
  name: "cat.png",
  type: "image/png",
  size: 1024,
  image: true,
  blob: new Blob(["png bytes"], { type: "image/png" }),
  path: `${SENT}/cat.png`,
}

const voice: Attachment = {
  id: "voice",
  name: "voice.mp3",
  type: "audio/mpeg",
  size: 512,
  image: false,
  path: `${SENT}/voice.mp3`,
}

const notes: Attachment = {
  id: "notes",
  name: "notes.pdf",
  type: "application/pdf",
  size: 4096,
  image: false,
  path: `${SENT}/notes.pdf`,
}

/** A reply naming a clip and an image together, then a recording, a document and one that isn't there. */
const REPLY = [
  `Two of them: MEDIA: ${LIBRARY}/chart.png MEDIA: ${LIBRARY}/render.mp4`,
  "",
  "And the rest:",
  "",
  `MEDIA: ${LIBRARY}/take.mp3`,
  `MEDIA: ${LIBRARY}/report.pdf`,
  "",
  `One that isn't there: MEDIA: ${LIBRARY}/missing.png`,
  "",
  "As an example:",
  "",
  "```",
  `MEDIA: ${LIBRARY}/example.png`,
  "```",
].join("\n")

const thread = (): Message[] => [
  {
    id: "m1",
    conversationId: "c1",
    role: "user",
    content: "here they are",
    status: "done",
    createdAt: 2,
    attachments: [photo, voice, notes],
  },
  {
    id: "m2",
    conversationId: "c1",
    role: "assistant",
    content: REPLY,
    status: "done",
    createdAt: 3,
  },
]

const galleries = () => findAll('[role="group"][aria-label="Gallery"]')
const cell = (name: string) =>
  findAll("button").find((button) => button.getAttribute("aria-label") === `Open ${name}`) ?? null
const row = (name: string) =>
  findAll("button").find((button) => button.getAttribute("aria-label") === `Play ${name}`) ?? null
const download = (name: string) =>
  findAll("button").find((button) => button.getAttribute("aria-label") === `Download ${name}`) ??
  null
/** Whether the cell or row a file draws in is in: its place is kept, busy until its URL answers. */
const filled = (name: string) => (cell(name) ?? row(name))?.hasAttribute("aria-busy") === false

/** jsdom has no tabs of its own, so a tab opening stands in for the browser's effect. */
function stubBrowser() {
  const real = { open: window.open }
  const opened: string[] = []
  window.open = ((url: string | URL) => {
    opened.push(String(url))
    return null
  }) as typeof window.open
  return {
    opened,
    restore: () => {
      window.open = real.open
    },
  }
}

test("a thread's sent media and a reply's tags draw through the same cells", async () => {
  const profile = botProfile("media-reply")
  await seedChat({ id: "c1", profile, messages: thread() })
  // Every file is read from a URL the host signs; one it has no copy of is the text it came from.
  const asked = mediaHost({ fail: ["missing.png"] })
  const browser = stubBrowser()
  try {
    await mount(chatScreen("c1"), async () => {
      await until(async () => filled("render.mp4"), "the reply's clip")
      await until(async () => download("notes.pdf") !== null, "the sent file's row")

      // What the user sent, unchanged: the photo in the Gallery, the recording in its row, the file.
      assert.ok(cell("cat.png"), "the sent photo keeps its cell")
      assert.ok(row("voice.mp3"), "the sent recording keeps its row")
      assert.ok(download("notes.pdf"), "the sent document keeps its download row")

      // The reply's tags draw as the same three kinds of cell, in one thread with the sent media.
      const drawn = galleries()
      assert.equal(drawn.length, 2, "one Gallery for the message, one for the reply")
      const reply = drawn.find((gallery) => gallery.contains(cell("chart.png")))
      assert.ok(reply, "the reply's image is in a Gallery")
      assert.ok(
        reply.contains(cell("render.mp4")),
        "and the clip tags sent beside it are in the same Gallery",
      )
      assert.equal(
        drawn.some((gallery) => gallery.contains(row("take.mp3"))),
        false,
        "a recording is never a Gallery cell",
      )
      assert.ok(row("take.mp3"), "it takes a row of its own")
      assert.ok(download("report.pdf"), "and the document a row the platform takes")

      // A tag is drawn, not left as the path it came from — but the one the host has no file for is.
      assert.equal(text().includes(`${LIBRARY}/render.mp4`), false, "a drawn tag isn't text")
      assert.equal(text().includes(`${LIBRARY}/take.mp3`), false, "a drawn recording isn't text")
      assert.match(
        text(),
        new RegExp(`MEDIA:${LIBRARY}/missing.png`),
        "a tag whose file the host has no copy of falls back to its text",
      )
      assert.match(
        text(),
        new RegExp(`MEDIA: ${LIBRARY}/example.png`),
        "and a tag inside a fenced block stays text",
      )
      assert.equal(cell("example.png"), null, "a fenced example draws no cell")

      // One URL per file, however many times the thread is drawn — the sent photo included, since
      // the thread reads every file from the host.
      assert.deepEqual(
        mediaReads(asked)
          .map((path) => path.split("/").pop())
          .sort(),
        [
          "cat.png",
          "chart.png",
          "missing.png",
          "notes.pdf",
          "render.mp4",
          "report.pdf",
          "take.mp3",
          "voice.mp3",
        ],
        "each file the thread needed, asked for once",
      )
      assert.ok(
        mediaReads(asked).includes(`${SENT}/cat.png`),
        "a sent photo is read from the host's URL too",
      )

      // Nothing is played in the thread: a tap opens the app's own Previewer instead.
      assert.equal(document.querySelector("video"), null, "no clip is played in the thread")
      assert.equal(document.querySelector("audio"), null)
      await click(cell("render.mp4"))
      await until(async () => document.querySelector("video") !== null, "the clip's player")
      const player = document.querySelector("video")!
      assert.equal(player.getAttribute("src")?.includes("render.mp4"), true, "from its own URL")
      assert.equal(player.hasAttribute("autoplay"), false, "paused until it is pressed")
      assert.equal(browser.opened.length, 0, "and nothing left the app")
      // Stepping stays in the app and follows the media drawn beside it, named as it goes.
      await click(findAll("button").find((one) => one.getAttribute("aria-label") === "Previous"))
      await until(
        async () =>
          !document.querySelector("video") &&
          document.querySelector('img[alt="chart.png"]') !== null,
        "the image beside it",
      )
      assert.match(
        document.querySelector('[role="dialog"]')?.textContent ?? "",
        /chart\.png/,
        "and the one on screen is named",
      )
      assert.equal(browser.opened.length, 0, "stepping never leaves the app")
      await click(findAll("button").find((one) => one.getAttribute("aria-label") === "Close"))

      // A recording's row opens the same Previewer, on a player of its own.
      await click(row("take.mp3"))
      await until(async () => document.querySelector("audio") !== null, "the recording's player")
      assert.equal(document.querySelector("video"), null, "the clip is not on screen")
      assert.equal(browser.opened.length, 0, "and nothing left the app for it")
      await click(findAll("button").find((one) => one.getAttribute("aria-label") === "Close"))

      // A file's row hands the file to the platform: a new tab at the URL the host signed.
      await click(download("report.pdf"))
      await until(async () => browser.opened.length > 0, "the new tab")
      assert.equal(browser.opened.length, 1, "one tab for one tap")
      assert.match(browser.opened[0], /\/media\?path=[^&]*report\.pdf&token=/, "at the signed URL")
    })
  } finally {
    browser.restore()
  }
})

test("a tag the host couldn't serve keeps its cell, and is asked again when the reply carries more", async () => {
  // A host that was out isn't a route that has no such file: the cell keeps its place with a retry
  // rather than turning the file into text, and the next read of the reply's media asks again.
  const profile = botProfile("media-retry")
  await seedChat({
    id: "c1",
    profile,
    messages: [
      {
        id: "m1",
        conversationId: "c1",
        role: "assistant",
        content: `Made this: MEDIA: ${LIBRARY}/chart.png`,
        status: "done",
        createdAt: 1,
      },
    ],
  })
  // The host is out for the first read, then answers: a 503 said nothing about the file.
  const asked = mediaHost({ fail: ["chart.png"], failure: 503 })
  await mount(chatScreen("c1"), async () => {
    await until(async () => cell("chart.png") !== null, "the cell it keeps")
    assert.equal(
      text().includes(`MEDIA:${LIBRARY}/chart.png`),
      false,
      "the tag is not left as text",
    )
    assert.equal(download("chart.png"), null, "and the file is never a download row")
    mediaHost({ asked })
    // The reply carries on and names another file, so its tags are read again.
    await act(async () => {
      await db.messages.update("m1", {
        content: `Made this: MEDIA: ${LIBRARY}/chart.png MEDIA: ${LIBRARY}/second.png`,
      })
    })
    await until(
      async () => (cell("chart.png")?.querySelector("img")?.getAttribute("src") ?? "").length > 0,
      "the cell drawn once the host answers",
    )
    assert.ok(cell("second.png"), "the file it named next draws too")
  })
})
