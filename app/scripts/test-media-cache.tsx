/**
 * What this device keeps of the media a thread has drawn. A URL the host signs is worth ten minutes,
 * a page outlives it, and an app put away on a phone is the everyday case: so a photo a cell has
 * painted is kept as its bytes, and a clip as the one frame a cell paints of it. The next look at
 * either asks the host for nothing — the copy is the answer, with the host away or not — and a cell
 * whose URL has run out is drawn again from it. Over a seeded device database and a faked HTTP
 * boundary, which is what puts these in the component tier.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { act } from "react"

import { clearAllData, db, deleteProfile, type Attachment, type Message } from "@/lib/db"
import { rememberFrame } from "@/lib/media-cache"
import { mediaKey } from "@/lib/media-key"
import { askMediaUrls } from "@/lib/media-url"

import {
  botProfile,
  chatScreen,
  connection,
  findAll,
  mediaHost,
  mediaReads,
  mount,
  seedChat,
  until,
} from "./component-kit.tsx"

const CHAT = "c1"
const HOST = "/home/h/.hermes/memento/attachments/session-1"

const photo: Attachment = {
  id: "photo",
  name: "cat.png",
  type: "image/png",
  size: 9,
  image: true,
  blob: new Blob(["png bytes"], { type: "image/png" }),
  path: `${HOST}/cat.png`,
}

const other: Attachment = {
  id: "other",
  name: "dog.png",
  type: "image/png",
  size: 9,
  image: true,
  blob: new Blob(["png bytes"], { type: "image/png" }),
  path: `${HOST}/dog.png`,
}

const clip: Attachment = {
  id: "clip",
  name: "clip.mp4",
  type: "video/mp4",
  size: 2048,
  image: false,
  path: `${HOST}/clip.mp4`,
}

const message = (attachments: Attachment[]): Message => ({
  id: "m1",
  conversationId: CHAT,
  role: "user",
  content: "here they are",
  status: "done",
  createdAt: 2,
  attachments,
})

const cell = (name: string) =>
  findAll("button").find((button) => button.getAttribute("aria-label") === `Open ${name}`) ?? null
const filled = (button: Element | null) => Boolean(button) && !button!.hasAttribute("aria-busy")
const drawn = (name: string) => cell(name)?.querySelector("img")?.getAttribute("src") ?? ""

/** What the browser says when a picture has landed, which is the moment this device keeps it. */
async function paints(name: string) {
  await act(async () => {
    cell(name)!.querySelector("img")!.dispatchEvent(new Event("load"))
  })
}

/** One row put as a page earlier left it: what a thread drew, kept on this device. */
async function keep(name: string, path: string, blob: Blob, type: string, copy = "image") {
  await db.mediaCache.put({
    key: mediaKey(connection(name).baseUrl, copy, path),
    blob,
    type,
    size: blob.size,
    at: Date.now(),
  })
}

test("a photo this device has painted is kept, and asking again never mints another URL", async () => {
  const profile = botProfile("media-kept")
  await seedChat({ id: CHAT, profile, messages: [message([photo])] })
  const asked = mediaHost({ host: "media-kept" })
  await mount(chatScreen(CHAT), async () => {
    await until(async () => filled(cell("cat.png")), "the photo's cell")
    await paints("cat.png")
    await until(async () => (await db.mediaCache.count()) === 1, "the photo kept on the device")
    const [again] = await askMediaUrls(CHAT, [photo.path!])
    assert.equal(again.state, "ready")
    assert.match(
      again.state === "ready" ? again.read.url : "",
      /^blob:/,
      "the copy this device holds, which carries no signature to run out",
    )
    assert.equal(mediaReads(asked).filter((path) => path.endsWith("cat.png")).length, 1, "one mint")
  })
})

test("a photo nobody has scrolled to is not fetched, and one that is, is", async () => {
  const profile = botProfile("media-painted")
  await seedChat({ id: CHAT, profile, messages: [message([photo, other])] })
  mediaHost({ host: "media-painted" })
  await mount(chatScreen(CHAT), async () => {
    await until(async () => filled(cell("dog.png")), "the second photo's cell")
    await paints("dog.png")
    await until(async () => (await db.mediaCache.count()) === 1, "the photo that was drawn")
    assert.deepEqual(
      (await db.mediaCache.toArray()).map((row) => row.key),
      [mediaKey(connection("media-painted").baseUrl, "image", other.path!)],
      "and the one the browser never asked for costs nothing",
    )
  })
})

test("a photo this device kept draws with the host away, and the host is not asked", async () => {
  const profile = botProfile("media-offline")
  await seedChat({ id: CHAT, profile, messages: [message([photo])] })
  await keep(
    "media-offline",
    photo.path!,
    new Blob(["png bytes"], { type: "image/png" }),
    "image/png",
  )
  const asked = mediaHost({ host: "media-offline", features: "away" })
  await mount(chatScreen(CHAT), async () => {
    await until(async () => filled(cell("cat.png")), "the photo's cell")
    await until(
      async () => drawn("cat.png").startsWith("blob:"),
      "drawn from the device's own copy",
    )
    assert.deepEqual(mediaReads(asked), [], "and no URL was minted for it")
  })
})

test("a clip's first frame is kept, so the next look at it needs no clip at all", async () => {
  const profile = botProfile("media-frame")
  await seedChat({ id: CHAT, profile, messages: [message([clip])] })
  await rememberFrame(
    connection("media-frame").baseUrl,
    clip.path!,
    new Blob(["jpeg bytes"], { type: "image/jpeg" }),
  )
  mediaHost({ host: "media-frame" })
  await mount(chatScreen(CHAT), async () => {
    await until(async () => filled(cell("clip.mp4")), "the clip's cell")
    await until(
      () => Boolean(cell("clip.mp4")?.querySelector('img[alt="First frame of clip.mp4"]')),
      "the frame this device painted of it before",
    )
    assert.match(
      cell("clip.mp4")!.querySelector("img")!.getAttribute("src") ?? "",
      /^blob:/,
      "drawn from the kept frame, not from the clip",
    )
  })
})

test("a cell whose photo failed after its URL ran out draws the copy this device kept", async () => {
  const profile = botProfile("media-cell-stale")
  await seedChat({ id: CHAT, profile, messages: [message([photo])] })
  // A URL with a minute of life, which is a URL this app never draws from: the skew spends it first.
  const asked = mediaHost({ host: "media-cell-stale", life: 30 })
  await mount(chatScreen(CHAT), async () => {
    await until(async () => filled(cell("cat.png")), "the photo's cell")
    await paints("cat.png")
    await until(async () => (await db.mediaCache.count()) === 1, "the photo kept on the device")
    await act(async () => {
      cell("cat.png")!.querySelector("img")!.dispatchEvent(new Event("error"))
    })
    await until(
      async () => drawn("cat.png").startsWith("blob:"),
      "the same photo, from the device's own copy",
    )
    assert.equal(
      mediaReads(asked).filter((path) => path.endsWith("cat.png")).length,
      1,
      "and the copy is why no second URL was needed",
    )
  })
})

test("a page come back to asks again for a URL that has run out", async () => {
  const profile = botProfile("media-wake")
  await seedChat({ id: CHAT, profile, messages: [message([photo])] })
  const asked = mediaHost({ host: "media-wake", life: 30 })
  await mount(chatScreen(CHAT), async () => {
    await until(async () => filled(cell("cat.png")), "the photo's cell")
    // The copy goes the way a phone's storage can, leaving the spent URL as all the cell has.
    await db.mediaCache.clear()
    await act(async () => {
      document.dispatchEvent(new globalThis.Event("visibilitychange"))
    })
    await until(
      async () => mediaReads(asked).filter((path) => path.endsWith("cat.png")).length === 2,
      "a second URL, minted when the page came back",
    )
  })
})

test("clearing what this device holds takes the media it kept with it", async () => {
  const profile = botProfile("media-cleared")
  await seedChat({ id: CHAT, profile, messages: [message([photo])] })
  mediaHost({ host: "media-cleared" })
  await mount(chatScreen(CHAT), async () => {
    await until(async () => filled(cell("cat.png")), "the photo's cell")
    await paints("cat.png")
    await until(async () => (await db.mediaCache.count()) === 1, "the photo kept")
    await clearAllData()
    assert.equal(await db.mediaCache.count(), 0, "and let go of when the device is cleared")
  })
})

test("a host that names no lifetime repairs a failed load itself", async () => {
  const profile = botProfile("media-no-life")
  await seedChat({ id: CHAT, profile, messages: [message([photo])] })
  // An older plugin's mint names no expiry, so no clock can say the URL has died: the load that
  // failed is the only sign of it, and asking again is what that sign is for.
  const asked = mediaHost({ host: "media-no-life", namesLife: false })
  await mount(chatScreen(CHAT), async () => {
    await until(async () => filled(cell("cat.png")), "the photo's cell")
    await act(async () => {
      cell("cat.png")!.querySelector("img")!.dispatchEvent(new Event("error"))
    })
    await until(
      async () => mediaReads(asked).filter((path) => path.endsWith("cat.png")).length === 2,
      "a second URL, asked for by the load that failed",
    )
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    assert.equal(
      mediaReads(asked).filter((path) => path.endsWith("cat.png")).length,
      2,
      "and only one: a file is renewed once, not on every failure",
    )
  })
})

test("a bot deleted from the app lets go of the URLs its copies were drawn by", async () => {
  const profile = botProfile("media-forgotten")
  await seedChat({ id: CHAT, profile, messages: [message([clip])] })
  await keep(
    "media-forgotten",
    clip.path!,
    new Blob(["jpeg bytes"], { type: "image/jpeg" }),
    "image/jpeg",
    "frame",
  )
  mediaHost({ host: "media-forgotten" })
  await mount(chatScreen(CHAT), async () => {
    await until(
      () => Boolean(cell("clip.mp4")?.querySelector('img[alt="First frame of clip.mp4"]')),
      "the frame this device kept",
    )
    const drawn = cell("clip.mp4")!.querySelector("img")!.getAttribute("src")!
    assert.match(drawn, /^blob:/)
    // A bot leaving the app deletes these rows itself, without asking the cache: what it must not
    // leave behind is the URL each row was drawn by, whose bytes stay alive for the page's life.
    const revoked: string[] = []
    const revoke = URL.revokeObjectURL.bind(URL)
    URL.revokeObjectURL = (url: string) => {
      revoked.push(url)
      revoke(url)
    }
    try {
      await deleteProfile(profile.id, { last: true })
    } finally {
      URL.revokeObjectURL = revoke
    }
    assert.equal(await db.mediaCache.count(), 0, "the rows go with the bot")
    assert.ok(revoked.includes(drawn), "and so does the URL that drew them")
  })
})

test("a clip's kept frame is drawn even where the clip's own URL never came", async () => {
  const profile = botProfile("media-clip-away")
  await seedChat({ id: CHAT, profile, messages: [message([clip])] })
  await keep(
    "media-clip-away",
    clip.path!,
    new Blob(["jpeg bytes"], { type: "image/jpeg" }),
    "image/jpeg",
    "frame",
  )
  const asked = mediaHost({ host: "media-clip-away", features: "away" })
  await mount(chatScreen(CHAT), async () => {
    await until(
      () => Boolean(cell("clip.mp4")?.querySelector('img[alt="First frame of clip.mp4"]')),
      "the frame this device kept, with no URL to draw it by",
    )
    assert.match(
      cell("clip.mp4")!.querySelector("img")!.getAttribute("src") ?? "",
      /^blob:/,
      "from the copy, not from the host",
    )
    assert.deepEqual(mediaReads(asked), [], "and no URL was minted")
  })
})

test("a clip whose URL has run out asks the host again, once", async () => {
  const profile = botProfile("media-clip-stale")
  await seedChat({ id: CHAT, profile, messages: [message([clip])] })
  // A clip has no picture of its own to fail, so the frame coming to nothing is the only signal:
  // jsdom plays nothing, which is a paint that came to nothing, and the URL is spent every time.
  const asked = mediaHost({ host: "media-clip-stale", life: -1 })
  await mount(chatScreen(CHAT), async () => {
    await until(
      async () => mediaReads(asked).filter((path) => path.endsWith("clip.mp4")).length === 2,
      "a second URL, asked for by the cell whose frame never came",
    )
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    assert.equal(
      mediaReads(asked).filter((path) => path.endsWith("clip.mp4")).length,
      2,
      "and only one: a host minting spent URLs is not minted at forever",
    )
  })
})

test("a clip's first paint is kept, so its cell has a frame to draw next time", async () => {
  const profile = botProfile("media-clip-paint")
  await seedChat({ id: CHAT, profile, messages: [message([clip])] })
  mediaHost({ host: "media-clip-paint" })
  // jsdom neither plays a clip nor paints a canvas: these two stand in for the browser at the one
  // seam a frame is read through, and come back out again below.
  const create = document.createElement.bind(document)
  const video = () => ({
    canPlayType: () => "probably",
    addEventListener: (event: string, done: () => void) => setTimeout(done, 0),
    requestVideoFrameCallback: undefined,
    removeAttribute() {},
    load() {},
    muted: false,
    playsInline: false,
    preload: "",
    crossOrigin: "",
    src: "",
    currentTime: 0,
    duration: 1,
    videoWidth: 640,
    videoHeight: 360,
  })
  const canvas = () => ({
    width: 0,
    height: 0,
    getContext: () => ({ drawImage() {} }),
    toBlob: (done: (blob: Blob) => void) => done(new Blob(["jpeg"], { type: "image/jpeg" })),
  })
  document.createElement = ((tag: string) =>
    tag === "video" ? video() : tag === "canvas" ? canvas() : create(tag as never)) as never
  try {
    await mount(chatScreen(CHAT), async () => {
      await until(async () => (await db.mediaCache.count()) === 1, "the frame kept on the device")
      assert.deepEqual(
        (await db.mediaCache.toArray()).map((row) => row.key),
        [mediaKey(connection("media-clip-paint").baseUrl, "frame", clip.path!)],
        "filed as the clip's frame, not as a photo",
      )
    })
  } finally {
    document.createElement = create
  }
})
