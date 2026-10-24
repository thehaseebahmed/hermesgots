/**
 * What a message's media draws as, over a seeded device database with the HTTP boundary faked: one
 * Gallery for the photos and clips, a recording in a row of its own, a file as a row that downloads
 * — and the bytes from this device's own copy where it has one, else from the host's media route
 * behind the bot's key. Nothing is played in the thread: a tap hands the media to the platform.
 */
import assert from "node:assert/strict"
import test from "node:test"

import type { Attachment, Message } from "@/lib/db"

import {
  botProfile,
  chatScreen,
  click,
  find,
  findAll,
  json,
  mount,
  seedChat,
  text,
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

const diagram: Attachment = {
  id: "diagram",
  name: "diagram.svg",
  type: "image/svg+xml",
  size: 640,
  // SVG travels to the model as a file marker, and still draws as the image it is.
  image: false,
  path: `${HOST}/diagram.svg`,
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

/** The host's plugin: its features, and its media route — failing the paths it was told to. */
function host({ fail = [] }: { fail?: string[] } = {}) {
  const reads: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    const root = url.pathname
    if (root.endsWith("/plugins/memento/info"))
      return json({ name: "memento", features: ["attachments", "media"] })
    if (root.endsWith("/plugins/memento/media")) {
      const path = url.searchParams.get("path") ?? ""
      reads.push(path)
      if (fail.some((name) => path.endsWith(name))) return json({ error: "No such file." }, 404)
      const type = path.endsWith(".mp4")
        ? "video/mp4"
        : path.endsWith(".mp3")
          ? "audio/mpeg"
          : "image/png"
      return new Response(new Blob(["bytes"], { type }), { headers: { "content-type": type } })
    }
    return json({})
  }) as typeof fetch
  return reads
}

const gallery = () => find('[role="group"][aria-label="Gallery"]')
const cell = (name: string) =>
  findAll("button").find((button) => button.getAttribute("aria-label") === `Open ${name}`) ?? null
const row = (name: string) =>
  findAll("button").find((button) => button.getAttribute("aria-label") === `Play ${name}`) ?? null
const download = (name: string) =>
  findAll("button").find((button) => button.getAttribute("aria-label") === `Download ${name}`) ??
  null

const ready = (button: Element | null) => Boolean(button) && !button!.hasAttribute("disabled")

/** jsdom has no object URLs, so the browser's own handle on a blob is stood in for. */
function stubUrls() {
  const real = { create: URL.createObjectURL, revoke: URL.revokeObjectURL }
  let made = 0
  URL.createObjectURL = (blob: Blob | MediaSource) =>
    `blob:${(blob as Blob).type || "bytes"}-${++made}`
  URL.revokeObjectURL = () => {}
  return () => {
    URL.createObjectURL = real.create
    URL.revokeObjectURL = real.revoke
  }
}

test("a message's photo and clip draw in one Gallery, its recording in a row of its own", async () => {
  const profile = botProfile("media-gallery")
  await seedChat({
    id: "c1",
    profile,
    messages: [message([photo, clip, diagram, voice, notes])],
  })
  // The host can't serve the photo: this device's own copy is what draws it.
  const reads = host({ fail: ["cat.png"] })
  const restore = stubUrls()
  const opened: string[] = []
  const realOpen = window.open
  window.open = ((url: string | URL) => {
    opened.push(String(url))
    return null
  }) as typeof window.open
  try {
    await mount(chatScreen("c1"), async () => {
      await until(async () => gallery() !== null, "the Gallery")
      await until(async () => ready(cell("clip.mp4")), "the clip's cell")

      const cells = gallery()!
      assert.ok(cells.contains(cell("cat.png")), "the photo keeps its place in the Gallery")
      assert.ok(cells.contains(cell("clip.mp4")), "and the clip sits beside it")
      assert.ok(cells.contains(cell("diagram.svg")), "an SVG draws as the image it is")
      assert.equal(
        cells.contains(row("voice.mp3")),
        false,
        "a recording is not a picture, so it isn't in the Gallery",
      )
      assert.ok(ready(row("voice.mp3")), "the recording has a row of its own")
      assert.match(text(), /voice\.mp3/, "the row names it")
      assert.equal(cell("notes.pdf"), null, "a PDF is not media")
      assert.ok(ready(download("notes.pdf")), "a file still draws as a row that downloads it")

      assert.equal(document.querySelector("video"), null, "nothing is played in the thread")
      assert.equal(document.querySelector("audio"), null)

      const picture = cell("cat.png")!.querySelector("img")
      assert.ok(picture, "the photo is drawn")
      assert.match(picture!.getAttribute("src") ?? "", /^blob:/, "from this device's own copy")
      assert.deepEqual(
        reads.filter((path) => path.endsWith("cat.png")),
        [],
        "a photo this device holds is never asked of a host that can't serve it",
      )
      assert.deepEqual(
        reads.map((path) => path.replace(`${HOST}/`, "")).sort(),
        ["clip.mp4", "diagram.svg", "voice.mp3"],
        "what this device doesn't hold comes from the media route",
      )

      await click(cell("clip.mp4"))
      await click(row("voice.mp3"))
      assert.deepEqual(opened.length, 2, "each tap opens the platform's own player")
      for (const url of opened) assert.match(url, /^blob:/)
    })
  } finally {
    window.open = realOpen
    restore()
  }
})

test("a message restored on another device draws its media from the host", async () => {
  const profile = botProfile("media-restored")
  // What a restored message keeps: the name, the type, the size and where the host has it.
  const restored: Attachment[] = [{ ...photo, blob: undefined }, clip, voice]
  await seedChat({ id: "c1", profile, messages: [message(restored)] })
  const reads = host()
  const restore = stubUrls()
  try {
    await mount(chatScreen("c1"), async () => {
      await until(async () => ready(cell("cat.png")), "the photo's cell")
      assert.ok(ready(cell("clip.mp4")), "the clip's cell")
      assert.ok(ready(row("voice.mp3")), "the recording's row")
      assert.deepEqual(
        reads.map((path) => path.replace(`${HOST}/`, "")).sort(),
        ["cat.png", "clip.mp4", "voice.mp3"],
        "every one of them read from the host, which is where the bytes are",
      )
      assert.match(
        cell("cat.png")!.querySelector("img")?.getAttribute("src") ?? "",
        /^blob:/,
        "and drawn from what the host answered",
      )
    })
  } finally {
    restore()
  }
})

test("media whose bytes can't be read falls back to the row that downloads it", async () => {
  const profile = botProfile("media-missing")
  await seedChat({ id: "c1", profile, messages: [message([clip])] })
  host({ fail: ["clip.mp4"] })
  const restore = stubUrls()
  try {
    await mount(chatScreen("c1"), async () => {
      await until(async () => download("clip.mp4") !== null, "the download row")
      assert.equal(cell("clip.mp4"), null, "a cell it can't fill is not promised")
    })
  } finally {
    restore()
  }
})
