/**
 * A reply's own text against the media it names: a fenced block is the reply's text, never a tag,
 * and it has to come back out whole — a reply that ends in one used to lose it entirely. The tag's
 * shape is the path, whatever the suffix, so a clip, a recording, a document or a phone's photo the
 * agent produced is a part like an image.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { mediaImages } from "../src/lib/media-parts.ts"

const text = (parts) => parts.map((part) => (part.kind === "text" ? part.text : "MEDIA")).join("")

const media = (parts) => parts.filter((part) => part.kind === "media").flatMap((part) => part.paths)

/** Each part draws as its own block, so the blank line between two of them is the only thing lost. */
const words = (value) => value.replace(/\s+/g, " ").trim()

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

test("a bare path keeps the spaces in its name", () => {
  // The path is the shape, so where it ends is the reader's sentence: a name with spaces ends at its
  // own suffix, and the words after it are still the reply's.
  const parts = mediaImages("MEDIA:/opt/data/lib/a report for march.pdf and then some words.")
  assert.deepEqual(media(parts), ["/opt/data/lib/a report for march.pdf"])
  assert.match(text(parts), /and then some words\./, "the sentence after the path is left alone")
})

test("a path is a tag whatever its suffix, and only a path is", () => {
  // The route answers any suffix, so a `.doc`, a `.7z` or no suffix at all is still a file handed
  // over.
  for (const tag of ["MEDIA: /tmp/mystery", "MEDIA: /tmp/archive.xyzzy", "MEDIA: /tmp/report.doc"])
    assert.deepEqual(media(mediaImages(tag)), [tag.replace("MEDIA: ", "")], tag)
  assert.deepEqual(media(mediaImages("MEDIA: no/path.png")), [], "a bare name is not a path")
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
