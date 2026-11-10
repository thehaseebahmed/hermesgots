/**
 * The one rule from a file's type to the way the app draws it: what it is (`mediaKind`), where it
 * draws (`drawnCell` — the Gallery for what a browser paints or plays, a row of its own for a
 * recording, the download row for everything else, and the same answer for a file whose host hasn't
 * been asked yet). A reply's tags, a message's sent files, the composer's staged ones and a library
 * row all read it, so the app reads the same whoever wrote the media, and a cell that can never fill
 * is never the answer.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { drawnCell, mediaKind, playableVideo, renderableImage } from "../src/lib/media-kind.ts"

test("an image is a Gallery cell, and so is a clip", () => {
  for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"])
    assert.equal(mediaKind(type), "image", type)
  for (const type of ["video/mp4", "video/webm"])
    assert.equal(mediaKind(type), "video", type)
  assert.equal(drawnCell("image/png", "photo.png"), "gallery")
  assert.equal(drawnCell("application/octet-stream", "clip.mp4"), "gallery")
})

test("an SVG draws as the image it is", () => {
  assert.equal(mediaKind("image/svg+xml", "diagram.svg"), "image")
  assert.equal(drawnCell("image/svg+xml", "diagram.svg"), "gallery")
  // A host that serves it as a generic binary still draws it: the extension says what it is.
  assert.equal(mediaKind("application/octet-stream", "diagram.svg"), "image")
  assert.equal(drawnCell("application/octet-stream", "diagram.svg"), "gallery")
})

test("audio sits in its own row, never in the Gallery", () => {
  for (const type of ["audio/mpeg", "audio/mp4", "audio/wav", "audio/webm", "audio/ogg"])
    assert.equal(drawnCell(type, "take.mp3"), "audio", type)
})

test("everything else is a file to download", () => {
  for (const [type, name] of [
    ["application/pdf", "notes.pdf"],
    ["text/plain", "notes.txt"],
    ["application/zip", "bundle.zip"],
    ["application/octet-stream", "blob.bin"],
    ["", "no-type"],
  ])
    assert.equal(drawnCell(type, name), "file", name)
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

test("a photo or a clip only where a browser draws or plays that type", () => {
  // A phone's photo and a camera's clip are files this app can hand over, not cells it can paint:
  // the Gallery would sit on "Couldn't load" for ever.
  assert.equal(drawnCell("image/heic", "photo.heic"), "file")
  assert.equal(drawnCell("image/tiff", "scan.tiff"), "file")
  assert.equal(drawnCell("video/quicktime", "take.mov"), "file", "Chromium refuses quicktime")
  assert.equal(drawnCell("video/x-matroska", "show.mkv"), "file")
  // The same files named by their extension alone, where the type names no family.
  assert.equal(drawnCell(undefined, "photo.heic"), "file")
  assert.equal(drawnCell("application/octet-stream", "scan.tiff"), "file")
  // And one whose extension a browser does paint keeps its cell.
  assert.equal(drawnCell(undefined, "photo.png"), "gallery")
  assert.equal(drawnCell("application/octet-stream", "clip.webm"), "gallery")
})

test("a browser plays four containers, and not the rest", () => {
  for (const type of ["video/mp4", "video/webm", "video/ogg", "video/x-m4v"])
    assert.equal(playableVideo(type), true, type)
  for (const type of ["video/quicktime", "video/x-matroska", "video/avi", ""])
    assert.equal(playableVideo(type), false, type)
})

test("a file the host hasn't answered for draws where its name says it will", () => {
  // No type yet: the name answers, and the answer is the one the type can't overturn — a HEIC holds
  // the row it will keep rather than a Gallery cell it would have to leave.
  assert.equal(drawnCell(undefined, "/opt/data/out/photo.png"), "gallery")
  assert.equal(drawnCell(undefined, "/opt/data/out/take.mp4"), "gallery")
  assert.equal(drawnCell(undefined, "/opt/data/out/voice.mp3"), "audio")
  assert.equal(drawnCell(undefined, "/opt/data/out/photo.heic"), "file")
  assert.equal(drawnCell(undefined, "/opt/data/out/report"), "file")
})

test("an HTML file is a page, with a row of its own", () => {
  assert.equal(mediaKind("text/html", "report.html"), "page")
  assert.equal(mediaKind("text/html; charset=utf-8", "report"), "page")
  assert.equal(drawnCell("text/html", "report.html"), "page")
  assert.equal(mediaKind("application/octet-stream", "report.htm"), "page")
  assert.equal(drawnCell("application/octet-stream", "report.htm"), "page")
  assert.equal(mediaKind(undefined, "/opt/data/out/report.HTML"), "page")
  assert.equal(drawnCell("", "report.html"), "page")
  assert.equal(drawnCell("text/plain", "notes.txt"), "file", "other text stays a file")
  assert.equal(drawnCell("text/plain", "report.html"), "file", "a type that says text is believed")
})
