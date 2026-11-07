/**
 * A reply's tags as the thread draws them: what each one draws as — a Gallery cell, a recording's
 * row, a file's row — from the type the host answered, and the one it answered nothing for, which
 * draws nothing at all rather than the path it was written as. Read it as a rule: the order and the
 * split are what the thread draws.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { mediaItems } from "../src/lib/media-items.ts"

const tag = (name) => ({ key: `0:${name}`, path: `/tmp/${name}`, name })
const ready = (type, size = 12) => ({
  status: "ready",
  read: { url: `https://host/media?path=${type}`, type, size },
})

test("a tag draws as what the host said its file is", () => {
  const tags = [tag("photo.png"), tag("clip.mp4"), tag("voice.mp3"), tag("notes.pdf")]
  const sources = new Map([
    [tags[0].key, ready("image/png")],
    [tags[1].key, ready("video/mp4")],
    [tags[2].key, ready("audio/mpeg")],
    [tags[3].key, ready("application/pdf")],
  ])
  const items = mediaItems(tags, sources)
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
  assert.equal(items[0].src, "https://host/media?path=image/png", "the URL the host signed")
  assert.equal(items[0].size, 12)
  assert.equal(items[0].type, "image/png")
})

test("a tag still being read holds the place its extension says", () => {
  const pending = tag("shot.png")
  const items = mediaItems([pending], new Map([[pending.key, { status: "reading" }]]))
  assert.equal(items.length, 1, "a read still out is not a tag the host refused")
  assert.equal(items[0].cell, "gallery")
  assert.equal(items[0].src, undefined)
})

test("a tag the host had nothing for draws nothing, and leaves nothing behind", () => {
  const tags = [tag("gone.pdf"), tag("photo.png")]
  const sources = new Map([
    [tags[0].key, { status: "undrawable" }],
    [tags[1].key, ready("image/png")],
  ])
  const items = mediaItems(tags, sources)
  assert.deepEqual(
    items.map((item) => item.name),
    ["photo.png"],
    "the file that is there draws; the one the host has no copy of is not drawn as its path",
  )
  assert.equal(
    mediaItems([tags[0]], new Map([[tags[0].key, { status: "undrawable" }]])).length,
    0,
    "a part whose every tag is gone has no item at all, so no cell and no text",
  )
})

test("a type nothing here draws takes the row that downloads it, not a cell that can't fill", () => {
  const tags = [tag("photo.heic"), tag("clip.mkv"), tag("chart.png")]
  const sources = new Map([
    // The route hands a phone's photo and a camera's clip over as a plain binary, and no browser
    // paints or plays those.
    [tags[0].key, ready("application/octet-stream")],
    [tags[1].key, ready("application/octet-stream")],
    [tags[2].key, ready("image/png")],
  ])
  const items = mediaItems(tags, sources)
  assert.deepEqual(
    items.map((item) => [item.name, item.cell]),
    [
      ["photo.heic", "file"],
      ["clip.mkv", "file"],
      ["chart.png", "gallery"],
    ],
    "the two the host answered nothing drawable for are rows; the photo a browser paints is a cell",
  )
})

test("a path naming nothing draws as the file it is", () => {
  const bare = tag("download")
  const type = tag("blob.bin")
  const sources = new Map([
    [bare.key, { status: "reading" }],
    [type.key, ready("application/octet-stream")],
  ])
  const items = mediaItems([bare, type], sources)
  assert.equal(items[0].name, "download")
  assert.equal(items[0].cell, "file")
  assert.equal(items[1].cell, "file")
})
