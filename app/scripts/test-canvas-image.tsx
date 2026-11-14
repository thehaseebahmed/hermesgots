/**
 * The picture a canvas's tile draws, from the file a reader chooses: `inlinePicture` hands the host
 * what its `_image` takes — one data URL, at most `IMAGE_CHARS` — and refuses what it can't, in
 * words the sheet says as they are.
 *
 * A file that already fits goes as the bytes it is: a small picture the reader picked is never
 * re-encoded for nothing. A larger one is decoded, cut to a square-ish JPEG and read again, and the
 * two edges are tried in turn because what a JPEG weighs off a photograph is not a number anything
 * else knows.
 *
 * The browser's decoder is what a DOM without a canvas cannot give, so `createImageBitmap`, the 2d
 * context and `toBlob` are stood in for here — what this holds is the rule around them: which files
 * are read whole, how many times a picture is cut down, what it does with each answer, and the words
 * each refusal is said in.
 */
import assert from "node:assert/strict"
import test from "node:test"

import {
  IMAGE_CHARS,
  NOT_A_PICTURE,
  PICTURE_TOO_BIG,
  UNREADABLE_PICTURE,
  inlinePicture,
} from "@/lib/canvas-image"

/** A 1×1 PNG, the smallest picture a test can hand over and the one a reader's screenshot isn't. */
const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ),
  (one) => one.charCodeAt(0),
)

/** A picture no bigger than the host's cap, as a file the reader chose. */
const small = () => new File([PNG], "tiny.png", { type: "image/png" })

/**
 * A photograph's worth of bytes: its data URL is over the host's cap, which is what sends a picture
 * through the decoder rather than up as it is.
 */
const overCap = () => new File([new Uint8Array(IMAGE_CHARS)], "photo.png", { type: "image/png" })

/** What the browser's own reader answers for a blob, which is what a file read whole comes back as. */
const dataUrlOf = (bytes: Uint8Array, type = "image/png") =>
  `data:${type};base64,${Buffer.from(bytes).toString("base64")}`

/**
 * The browser's decoder, stood in for: a bitmap of the size a photograph would be, a context that
 * counts its draws, and a `toBlob` that answers whatever the case says a JPEG of it weighs.
 * `edges` records each long edge the app asked for, so a case can read how many times it was cut.
 */
function standInFor(weigh: (edge: number) => number | null) {
  const edges: number[] = []
  // The canvas class the document makes, reached through an element: a DOM handed to this tier has
  // no layout and no 2d context, and this is the one object both it and the browser share.
  const prototype = Object.getPrototypeOf(document.createElement("canvas")) as HTMLCanvasElement
  const realBitmap = globalThis.createImageBitmap
  const realContext = prototype.getContext
  const realBlob = prototype.toBlob
  let drawn = 0

  globalThis.createImageBitmap = (async () => ({
    width: 4000,
    height: 3000,
    close() {
      // The app lets a decoded picture go; there is nothing here holding memory.
    },
  })) as unknown as typeof createImageBitmap
  prototype.getContext = (() => ({
    drawImage() {
      drawn += 1
    },
  })) as unknown as typeof prototype.getContext
  prototype.toBlob = function (this: HTMLCanvasElement, callback: BlobCallback) {
    const edge = Math.max(this.width, this.height)
    edges.push(edge)
    const bytes = weigh(edge)
    if (bytes === null) return callback(null)
    // The bytes are the weight the case chose, at the long edge it was asked for: a JPEG of a
    // photograph, in the shape the reader's own browser would hand one back.
    callback(new File([new Uint8Array(bytes).fill(7)], "picture.jpg", { type: "image/jpeg" }))
  } as unknown as typeof prototype.toBlob

  return {
    edges,
    drawn: () => drawn,
    undo() {
      globalThis.createImageBitmap = realBitmap
      prototype.getContext = realContext
      prototype.toBlob = realBlob
    },
  }
}

test("a picture that already fits goes up as the bytes it is", async () => {
  const bytes = small()
  assert.equal(
    await inlinePicture(bytes),
    dataUrlOf(PNG),
    "the file's own data URL, never a re-encoded copy",
  )
})

test("a picture over the host's cap is cut down to one that fits", async () => {
  const standing = standInFor(() => 4096)
  try {
    const picture = await inlinePicture(overCap())
    assert.ok(
      picture.startsWith("data:image/jpeg;base64,"),
      "a picture cut down is a JPEG, which is what a browser's canvas writes",
    )
    assert.ok(picture.length <= IMAGE_CHARS, "inside the host's cap, which is on the whole URL")
    assert.deepEqual(standing.edges, [512], "cut once, to the largest edge the app draws at")
    assert.equal(standing.drawn(), 1, "and drawn onto a canvas that one time")
  } finally {
    standing.undo()
  }
})

test("a picture the first edge can't save is tried again at the second", async () => {
  // The first JPEG still lands over the cap; the second is small enough.
  const standing = standInFor((edge) => (edge > 320 ? IMAGE_CHARS : 2048))
  try {
    const picture = await inlinePicture(overCap())
    assert.ok(picture.length <= IMAGE_CHARS, "the second edge's picture is the one that goes")
    assert.deepEqual(standing.edges, [512, 320], "both edges tried, largest first")
  } finally {
    standing.undo()
  }
})

test("a picture no edge can fit is refused over the host's own number", async () => {
  const standing = standInFor(() => IMAGE_CHARS)
  try {
    await assert.rejects(inlinePicture(overCap()), { message: PICTURE_TOO_BIG })
    assert.deepEqual(standing.edges, [512, 320], "and it stopped trying after the second")
  } finally {
    standing.undo()
  }
})

test("a file that isn't a picture is refused before it is read", async () => {
  await assert.rejects(
    inlinePicture(new File(["really not a picture"], "notes.txt", { type: "text/plain" })),
    { message: NOT_A_PICTURE },
  )
})

test("a picture the browser can't decode is refused in the same plain words", async () => {
  const real = globalThis.createImageBitmap
  globalThis.createImageBitmap = (async () => {
    throw new Error("The source image could not be decoded.")
  }) as unknown as typeof createImageBitmap
  const big = new File([new Uint8Array(IMAGE_CHARS)], "photo.heic", { type: "image/heic" })
  try {
    await assert.rejects(inlinePicture(big), { message: UNREADABLE_PICTURE })
  } finally {
    globalThis.createImageBitmap = real
  }
})

test("a canvas no bytes come back for is refused, never a blank picture", async () => {
  const standing = standInFor(() => null)
  try {
    await assert.rejects(inlinePicture(overCap()), { message: UNREADABLE_PICTURE })
  } finally {
    standing.undo()
  }
})
