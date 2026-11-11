import assert from "node:assert/strict"
import test from "node:test"

import { rowText, rowWords } from "../src/lib/row-text.ts"

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

test("a text or a kind that is not a string reads the way the host reads it", () => {
  assert.equal(rowText([{ type: "text", text: 7 }]), "7")
  assert.equal(rowText({ text: 7 }), "7")
  assert.equal(rowText([{ type: 7 }]), "\n[7]")
  assert.equal(rowText({ type: 7 }), "[7]")
  assert.equal(rowText([{ type: "text", text: true }]), "true", "not the host's `True`")
})

test("a value that is no shape the host stores is its own string", () => {
  assert.equal(rowText(7), "7")
  assert.equal(rowText(false), "false")
})

test("a result's words are only the parts that carry words, wherever they stand", () => {
  const imageFirst = [
    { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    { type: "text", text: '{"exit_code": 1}' },
  ]
  assert.equal(rowWords(imageFirst), '{"exit_code": 1}')
  assert.equal(rowWords([...imageFirst].reverse()), '{"exit_code": 1}')
  assert.equal(rowWords([{ type: "input_audio", input_audio: { data: "…" } }]), "")
  assert.equal(rowWords(["said: ", 7, null, { type: "thinking" }]), "said: ")
})

test("a result that is one dict reads its words, and a placeholder is no words at all", () => {
  assert.equal(rowWords({ text: "the words" }), "the words")
  assert.equal(rowWords({ type: "output_text", content: "the words" }), "the words")
  assert.equal(rowWords({ type: "image_url", image_url: { url: "data:…" } }), "")
  assert.equal(rowWords({ output: "hi", exit_code: 0 }), "")
  assert.equal(rowWords(null), "")
  assert.equal(rowWords(7), "7")
})
