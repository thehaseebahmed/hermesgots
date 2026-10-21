/**
 * A reply's own text against the images it names: a fenced block is the reply's text, never a tag,
 * and it has to come back out whole — a reply that ends in one used to lose it entirely.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { mediaImages } from "../src/lib/media-parts.ts"

const text = (parts) =>
  parts.map((part) => (part.kind === "text" ? part.text : "MEDIA")).join("")

/** Each part draws as its own block, so the blank line between two of them is the only thing lost. */
const words = (value) => value.replace(/\s+/g, " ").trim()

test("a fenced block in the middle stays in the reply", () => {
  const reply = ["Before.", "", "```ts", "const x = 1", "```", "", "After."].join("\n")
  assert.equal(words(text(mediaImages(reply))), words(reply), "every line, fence and all")
})

test("a reply that ends in a block keeps it", () => {
  const reply = ["Before.", "", "```ts", "const x = 1", "```"].join("\n")
  assert.equal(words(text(mediaImages(reply))), words(reply), "the block is its last text, not lost")
})

test("a tag inside a block is an example, not an image", () => {
  const reply = ["Before.", "", "```ts", 'const a = "MEDIA: /tmp/a.png"', "```"].join("\n")
  const parts = mediaImages(reply)
  assert.deepEqual(parts.filter((part) => part.kind === "media"), [], "nothing in a block is an image")
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
