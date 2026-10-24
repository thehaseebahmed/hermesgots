/**
 * A reply's own text against the media it names: a fenced block is the reply's text, never a tag,
 * and it has to come back out whole — a reply that ends in one used to lose it entirely. The tag's
 * grammar takes the extensions the plugin's media route serves, so a clip, a recording or a document
 * the agent produced is a part like an image.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { mediaImages } from "../src/lib/media-parts.ts"

const text = (parts) => parts.map((part) => (part.kind === "text" ? part.text : "MEDIA")).join("")

const media = (parts) => parts.filter((part) => part.kind === "media").flatMap((part) => part.paths)

/** Each part draws as its own block, so the blank line between two of them is the only thing lost. */
const words = (value) => value.replace(/\s+/g, " ").trim()

/** Every extension the plugin's `media.py` answers with a content type, and a binary tail after it. */
const SERVED = [
  // images, the raster the app has always drawn and the SVG it draws too
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "svg",
  // video
  "mp4",
  "m4v",
  "mov",
  "webm",
  "ogv",
  // audio
  "mp3",
  "m4a",
  "aac",
  "wav",
  "ogg",
  "oga",
  "opus",
  "flac",
  // text, documents and data
  "txt",
  "log",
  "md",
  "markdown",
  "csv",
  "tsv",
  "html",
  "htm",
  "css",
  "xml",
  "json",
  "pdf",
  "yaml",
  "yml",
  "toml",
  "ini",
  // code
  "py",
  "rb",
  "go",
  "rs",
  "c",
  "h",
  "cc",
  "cpp",
  "hpp",
  "cs",
  "java",
  "kt",
  "swift",
  "ts",
  "tsx",
  "jsx",
  "js",
  "mjs",
  "cjs",
  "sh",
  "bash",
  "zsh",
  "sql",
  "php",
  "lua",
  "pl",
  "r",
  "scala",
  "ex",
  "exs",
  "erl",
  "hs",
  "clj",
  "vue",
  "svelte",
  "dart",
  "zig",
  // what the route still hands over as a binary
  "zip",
  "tar",
  "gz",
  "docx",
  "xlsx",
  "pptx",
  "epub",
  "apk",
  "wasm",
  "ics",
  "vcf",
  "srt",
  "vtt",
]

test("the grammar takes every type the media route serves", () => {
  for (const extension of SERVED) {
    const reply = `Here it is: MEDIA: /home/h/.hermes/library/produced.${extension}`
    assert.deepEqual(
      media(mediaImages(reply)),
      [`/home/h/.hermes/library/produced.${extension}`],
      `.${extension} is a tag`,
    )
  }
})

test("a clip, a recording and a document sent together are one part", () => {
  const reply = [
    "Made these:",
    "MEDIA: /tmp/render.mp4",
    "MEDIA: /tmp/take.mp3",
    "MEDIA: /tmp/report.pdf",
  ].join("\n\n")
  const parts = mediaImages(reply)
  assert.deepEqual(
    media(parts),
    ["/tmp/render.mp4", "/tmp/take.mp3", "/tmp/report.pdf"],
    "in order",
  )
  assert.equal(parts.filter((part) => part.kind === "media").length, 1, "one Gallery, not three")
})

test("a fenced block shields a clip and a recording too", () => {
  const reply = [
    "Before.",
    "",
    "```",
    "MEDIA: /tmp/render.mp4",
    "MEDIA: /tmp/take.mp3",
    "```",
  ].join("\n")
  assert.deepEqual(media(mediaImages(reply)), [], "an example is not media")
  assert.match(text(mediaImages(reply)), /MEDIA: \/tmp\/render\.mp4/, "and stays as it was written")
})

test("a path the route can't name stays text", () => {
  for (const tag of ["MEDIA: /tmp/mystery", "MEDIA: /tmp/archive.xyzzy", "MEDIA: no/path.png"])
    assert.deepEqual(media(mediaImages(tag)), [], tag)
})

test("a quoted path keeps its spaces and a full stop isn't part of it", () => {
  const parts = mediaImages('A recording: MEDIA: "/tmp/voice memo.mp3", then done.')
  assert.deepEqual(media(parts), ["/tmp/voice memo.mp3"], "the name reads whole, without the stop")
  assert.match(text(parts), /, then done\./, "and the sentence after it is still the reply's")
})

test("a fenced block in the middle stays in the reply", () => {
  const reply = ["Before.", "", "```ts", "const x = 1", "```", "", "After."].join("\n")
  assert.equal(words(text(mediaImages(reply))), words(reply), "every line, fence and all")
})

test("a reply that ends in a block keeps it", () => {
  const reply = ["Before.", "", "```ts", "const x = 1", "```"].join("\n")
  assert.equal(
    words(text(mediaImages(reply))),
    words(reply),
    "the block is its last text, not lost",
  )
})

test("a tag inside a block is an example, not an image", () => {
  const reply = ["Before.", "", "```ts", 'const a = "MEDIA: /tmp/a.png"', "```"].join("\n")
  const parts = mediaImages(reply)
  assert.deepEqual(
    parts.filter((part) => part.kind === "media"),
    [],
    "nothing in a block is an image",
  )
  assert.match(text(parts), /MEDIA: \/tmp\/a\.png/, "and the block reads as it was written")
})

test("an unclosed block keeps what it holds", () => {
  const reply = ["Before.", "", "```ts", "const x = 1"].join("\n")
  assert.equal(text(mediaImages(reply)), reply, "a stream's open block")
})

test("an image outside a block is still its own part", () => {
  const reply = ['A picture: MEDIA: "/tmp/a.png"', "", "```ts", "const x = 1", "```"].join("\n")
  const parts = mediaImages(reply)
  assert.deepEqual(
    parts.map((part) => part.kind),
    ["text", "media", "text"],
    "the tag between the text and the block",
  )
  assert.match(text(parts), /const x = 1/, "and the block after it is still drawn")
})
