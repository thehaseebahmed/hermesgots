/**
 * One thread, both halves of the media contract: what the user sent draws from this device and the
 * host, and a reply's `MEDIA:<path>` tags draw through the very same cells — a clip joins the
 * Gallery, a recording takes a row of its own, and any other file a row that downloads — from one
 * seeded device database with the HTTP boundary faked. Tags sent together are one Gallery, a tag
 * inside a fenced block stays text, and a tag the host can't answer falls back to its own text.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { act } from "react"

import { db, type Attachment, type Message } from "@/lib/db"

import {
  askedFor,
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

const ready = (button: Element | null) => Boolean(button) && !button!.hasAttribute("disabled")

/** jsdom has no object URLs, and a download is the browser's own effect: both stand in. */
function stubBrowser() {
  const real = {
    create: URL.createObjectURL,
    revoke: URL.revokeObjectURL,
    click: window.HTMLAnchorElement.prototype.click,
    open: window.open,
  }
  let made = 0
  const saved: string[] = []
  const opened: string[] = []
  URL.createObjectURL = (blob: Blob | MediaSource) => `blob:${(blob as Blob).type}-${++made}`
  URL.revokeObjectURL = () => {}
  window.HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    saved.push(this.download)
  }
  window.open = ((url: string | URL) => {
    opened.push(String(url))
    return null
  }) as typeof window.open
  return {
    saved,
    opened,
    restore: () => {
      URL.createObjectURL = real.create
      URL.revokeObjectURL = real.revoke
      window.HTMLAnchorElement.prototype.click = real.click
      window.open = real.open
    },
  }
}

test("a thread's sent media and a reply's tags draw through the same cells", async () => {
  const profile = botProfile("media-reply")
  await seedChat({ id: "c1", profile, messages: thread() })
  // The photo this device holds draws from its own copy; every other file comes from the route.
  const asked = mediaHost({ fail: ["missing.png"] })
  const browser = stubBrowser()
  try {
    await mount(chatScreen("c1"), async () => {
      await until(async () => ready(cell("render.mp4")), "the reply's clip")
      await until(async () => download("notes.pdf") !== null, "the sent file's row")

      // What the user sent, unchanged: the photo in the Gallery, the recording in its row, the file.
      assert.ok(ready(cell("cat.png")), "the sent photo keeps its cell")
      assert.ok(ready(row("voice.mp3")), "the sent recording keeps its row")
      assert.ok(ready(download("notes.pdf")), "the sent document keeps its download row")

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
      assert.ok(ready(row("take.mp3")), "it takes a row of its own")
      assert.ok(ready(download("report.pdf")), "and the document a row that downloads it")

      // A tag is drawn, not left as the path it came from — but the one that can't be read is.
      assert.equal(text().includes(`${LIBRARY}/render.mp4`), false, "a drawn tag isn't text")
      assert.equal(text().includes(`${LIBRARY}/take.mp3`), false, "a drawn recording isn't text")
      assert.match(
        text(),
        new RegExp(`MEDIA:${LIBRARY}/missing.png`),
        "a tag whose file can't be fetched falls back to its text",
      )
      assert.match(
        text(),
        new RegExp(`MEDIA: ${LIBRARY}/example.png`),
        "and a tag inside a fenced block stays text",
      )
      assert.equal(cell("example.png"), null, "a fenced example draws no cell")

      // One read per file, however many times the thread is drawn — and the sent photo this device
      // already holds is never asked of the host.
      assert.deepEqual(
        mediaReads(asked).map((path) => path.split("/").pop()).sort(),
        ["chart.png", "missing.png", "render.mp4", "report.pdf", "take.mp3", "voice.mp3"],
        "each file the thread needed, read once",
      )
      assert.equal(mediaReads(asked).length, 6, "no file read twice")
      assert.equal(
        mediaReads(asked).includes(`${SENT}/cat.png`),
        false,
        "the sent photo draws from this device",
      )

      // A tap hands the media to the platform, and a download saves under the file's own name.
      await click(cell("render.mp4"))
      await click(row("take.mp3"))
      assert.equal(browser.opened.length, 2, "both taps opened the platform's own player")
      for (const url of browser.opened) assert.match(url, /^blob:/)
      await click(download("report.pdf"))
      await until(async () => browser.saved.length > 0, "the download")
      assert.deepEqual(browser.saved, ["report.pdf"], "saved under the name the tag named")
    })
  } finally {
    browser.restore()
  }
})

test("a tag the host couldn't serve is asked again when the reply carries more", async () => {
  // A host that was out isn't a route that has no such file: the tag is left as text rather than
  // settled, and the next read of the reply's media asks for it again.
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
  const browser = stubBrowser()
  try {
    await mount(chatScreen("c1"), async () => {
      await until(async () => text().includes(`MEDIA:${LIBRARY}/chart.png`), "the tag kept as text")
      assert.equal(cell("chart.png"), null, "a host that couldn't answer draws nothing")
      mediaHost({ asked })
      // The reply carries on and names another file, so its tags are read again.
      await act(async () => {
        await db.messages.update("m1", {
          content: `Made this: MEDIA: ${LIBRARY}/chart.png MEDIA: ${LIBRARY}/second.png`,
        })
      })
      await until(async () => ready(cell("chart.png")), "the tag drawn once the host answers")
      assert.equal(
        text().includes(`MEDIA:${LIBRARY}/chart.png`),
        false,
        "and the tag is no longer left as text",
      )
      assert.ok(ready(cell("second.png")), "the file it named next draws too")
    })
  } finally {
    browser.restore()
  }
})

test("a reply's tag on a plugin without the media route stays its own text", async () => {
  const profile = botProfile("media-reply-old")
  await seedChat({
    id: "c1",
    profile,
    messages: [
      {
        id: "m1",
        conversationId: "c1",
        role: "assistant",
        content: `Made this: MEDIA: ${LIBRARY}/render.mp4`,
        status: "done",
        createdAt: 1,
      },
    ],
  })
  const asked = mediaHost({ features: ["attachments"] })
  await mount(chatScreen("c1"), async () => {
    await until(async () => text().includes(`${LIBRARY}/render.mp4`), "the tag's text")
    assert.equal(cell("render.mp4"), null, "a plugin from before the route draws no cell")
    assert.equal(askedFor(asked, "/plugins/memento/media"), 0, "and its media route is never asked")
  })
})
