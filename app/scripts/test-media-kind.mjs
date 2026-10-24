/**
 * The one rule from a file's kind to the way a thread draws it: images (an SVG included) and video
 * take a cell in the Gallery, audio a row of its own, and anything else a download row. Both what
 * the user sends and the tags an agent returns are read through it, so a thread reads the same
 * whoever wrote the media.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { mediaCell, mediaKind, renderableImage } from "../src/lib/media-kind.ts"

test("an image is a Gallery cell, and so is a clip", () => {
  for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"])
    assert.equal(mediaKind(type), "image", type)
  for (const type of ["video/mp4", "video/quicktime", "video/webm"])
    assert.equal(mediaKind(type), "video", type)
  assert.equal(mediaCell("image/png"), "gallery")
  assert.equal(mediaCell("application/octet-stream", "clip.mp4"), "gallery")
})

test("an SVG draws as the image it is", () => {
  assert.equal(mediaKind("image/svg+xml", "diagram.svg"), "image")
  assert.equal(mediaCell("image/svg+xml", "diagram.svg"), "gallery")
  // A host that serves it as a generic binary still draws it: the extension says what it is.
  assert.equal(mediaKind("application/octet-stream", "diagram.svg"), "image")
})

test("audio sits in its own row, never in the Gallery", () => {
  for (const type of ["audio/mpeg", "audio/mp4", "audio/wav", "audio/webm", "audio/ogg"])
    assert.equal(mediaCell(type), "audio", type)
})

test("everything else is a file to download", () => {
  for (const [type, name] of [
    ["application/pdf", "notes.pdf"],
    ["text/plain", "notes.txt"],
    ["application/zip", "bundle.zip"],
    ["application/octet-stream", "blob.bin"],
    ["", "no-type"],
  ])
    assert.equal(mediaCell(type, name), "file", name)
})

test("a type that names no family is read from the extension", () => {
  assert.equal(mediaKind("", "clip.MOV"), "video")
  assert.equal(mediaKind("application/octet-stream", "voice.mp3"), "audio")
  assert.equal(mediaKind("application/octet-stream", "photo.JPEG"), "image", "however it's cased")
  assert.equal(mediaKind(undefined, "song.m4a"), "audio")
})

test("a type that names a family is not overruled by a misleading name", () => {
  assert.equal(mediaKind("text/markdown", "notes.md"), "file")
  assert.equal(mediaKind("audio/webm", "take.webm"), "audio", "an audio-only recording")
})

test("what a browser draws itself is not everything the thread shows", () => {
  assert.equal(renderableImage("image/png"), true)
  assert.equal(renderableImage("image/svg+xml"), true)
  assert.equal(renderableImage("image/heic"), false, "the inline JPEG is what a browser can draw")
  assert.equal(renderableImage("video/mp4"), false)
})
