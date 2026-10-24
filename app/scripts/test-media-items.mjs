/**
 * A reply's tags as the thread draws them: what each one draws as — a Gallery cell, a recording's
 * row, a file's row — from the type the host answered, and the ones it answered nothing for, which
 * stay the text they came from. Read it as a rule: the order and the split are what the thread draws.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { mediaItems } from "../src/lib/media-items.ts"

const tag = (name) => ({ key: `0:${name}`, path: `/tmp/${name}`, name })
const ready = (type, size = 12) => ({ status: "ready", read: { url: `blob:${type}`, type, size } })

test("a tag draws as what the host said its file is", () => {
  const tags = [tag("photo.png"), tag("clip.mp4"), tag("voice.mp3"), tag("notes.pdf")]
  const sources = new Map([
    [tags[0].key, ready("image/png")],
    [tags[1].key, ready("video/quicktime")],
    [tags[2].key, ready("audio/mpeg")],
    [tags[3].key, ready("application/pdf")],
  ])
  const { items, unread } = mediaItems(tags, sources)
  assert.deepEqual(
    items.map((item) => [item.name, item.kind, item.cell]),
    [
      ["photo.png", "image", "gallery"],
      ["clip.mp4", "video", "gallery"],
      ["voice.mp3", "audio", "audio"],
      ["notes.pdf", "file", "file"],
    ],
    "in the order the tags were written",
  )
  assert.equal(items[0].src, "blob:image/png")
  assert.equal(items[0].size, 12)
  assert.equal(items[0].type, "image/png")
  assert.deepEqual(unread, [])
})

test("a tag still being read holds the place its extension says", () => {
  const pending = tag("shot.png")
  const { items, unread } = mediaItems([pending], new Map([[pending.key, { status: "reading" }]]))
  assert.deepEqual(unread, [], "a read still out is not a tag the host refused")
  assert.equal(items[0].cell, "gallery")
  assert.equal(items[0].src, undefined)
})

test("a tag the host had nothing for is drawn as its own text, after the rest", () => {
  const tags = [tag("gone.pdf"), tag("photo.png")]
  const sources = new Map([
    [tags[0].key, { status: "empty" }],
    [tags[1].key, ready("image/png")],
  ])
  const { items, unread } = mediaItems(tags, sources)
  assert.deepEqual(
    items.map((item) => item.name),
    ["photo.png"],
  )
  assert.deepEqual(unread, [{ key: tags[0].key, path: tags[0].path }])
})

test("a path naming nothing draws as the file it is", () => {
  const bare = tag("download")
  const type = tag("blob.bin")
  const sources = new Map([
    [bare.key, { status: "reading" }],
    [type.key, ready("application/octet-stream")],
  ])
  const { items } = mediaItems([bare, type], sources)
  assert.equal(items[0].name, "download")
  assert.equal(items[0].cell, "file")
  assert.equal(items[1].cell, "file")
})
