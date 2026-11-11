/**
 * The one rule from a transcript row's `content` to the words the thread draws: a string as itself,
 * a parts list joined the way the host joins it, one structured dict by the kind it names, and
 * nothing for a row holding no words. The rule is the host's own (`_coerce_message_text`), so each
 * shape it names is pinned here.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { rowText } from "../src/lib/row-text.ts"

test("a string is its own words, and a row with none is empty", () => {
  assert.equal(rowText("hello"), "hello")
  assert.equal(rowText(""), "")
  assert.equal(rowText(null), "")
  assert.equal(rowText(undefined), "")
})

test("a parts list joins its text, and a photo stands where the host puts one", () => {
  const parts = [
    { type: "text", text: "look at this" },
    { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
  ]
  assert.equal(rowText(parts), "look at this\n[image]")
})

test("a parts list reads a bare string part and skips what is neither", () => {
  assert.equal(rowText(["one, ", "two"]), "one, two")
  assert.equal(rowText(["said: ", 7, null, ["nested"]]), "said: ")
})

test("an audio part and any other kind stand as the placeholder the host draws", () => {
  assert.equal(rowText([{ type: "input_audio", input_audio: { data: "…" } }]), "\n[audio]")
  assert.equal(rowText([{ type: "thinking" }]), "\n[thinking]")
  // A text kind's words are joined where they stand, with no line of their own.
  assert.equal(rowText([{ type: "input_text", text: "told" }]), "told")
})

test("one structured dict reads by the kind it names", () => {
  assert.equal(rowText({ type: "text", text: "the words" }), "the words")
  assert.equal(rowText({ type: "output_text", content: "the words" }), "the words")
  assert.equal(rowText({ type: "image_url", image_url: { url: "data:…" } }), "[image]")
  assert.equal(rowText({ type: "audio" }), "[audio]")
  assert.equal(rowText({ type: "video" }), "[video]")
})

test("a dict that names no kind is its text, else structured content", () => {
  assert.equal(rowText({ text: "the words" }), "the words")
  assert.equal(rowText({ text: null }), "")
  assert.equal(rowText({ output: "hi", exit_code: 0 }), "[structured content]")
})

test("a value that is no shape the host stores is its own string", () => {
  assert.equal(rowText(7), "7")
  assert.equal(rowText(false), "false")
})
