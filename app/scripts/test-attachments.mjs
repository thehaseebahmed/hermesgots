/**
 * A message's attachments as the model reads them and as the thread reads them back: one marker
 * line per file naming it, its type and its size, the sentence about files once, and a round trip
 * that gives the thread the same names, types and sizes without the bytes.
 */
import assert from "node:assert/strict"
import test from "node:test"

import {
  attachmentsText,
  attachmentParts,
  formatBytes,
  marker,
  NOT_INLINED,
  splitAttachments,
} from "../src/lib/attachment-text.ts"

const HOST = "/home/h/.hermes/memento/attachments/session-1"

const file = (patch = {}) => ({
  id: "f1",
  name: "field notes.pdf",
  type: "application/pdf",
  size: 2048,
  image: false,
  path: `${HOST}/field notes.pdf`,
  ...patch,
})

const photo = (patch = {}) => ({
  id: "p1",
  name: "shot.png",
  type: "image/png",
  size: 4096,
  image: true,
  path: `${HOST}/shot.png`,
  ...patch,
})

test("a file's marker names it, its type, its size and where it lies on the host", () => {
  assert.equal(
    marker(file()),
    `<attachment name="field notes.pdf" type="application/pdf" size="2048" path="${HOST}/field notes.pdf" />`,
  )
})

test("a file the host never took has no path to give", () => {
  assert.equal(
    marker(file({ path: undefined })),
    '<attachment name="field notes.pdf" type="application/pdf" size="2048" />',
  )
})

test("a message carrying a file says once that its content is not inlined", () => {
  const lines = attachmentsText("here they are", [
    file(),
    file({ id: "f2", name: "usage.json", type: "application/json", size: 12 }),
  ]).split("\n")
  assert.equal(lines.length, 4)
  assert.equal(lines[0], "here they are")
  assert.ok(lines[1].startsWith("<attachment"), "a marker per file")
  assert.ok(lines[2].startsWith("<attachment"))
  assert.equal(lines[3], NOT_INLINED, "the sentence comes after the last marker")
})

test("the sentence is said once, however many files the message carries", () => {
  const text = attachmentsText("", [file(), file({ id: "f2" }), file({ id: "f3" })])
  assert.equal(text.split(NOT_INLINED).length - 1, 1)
})

test("a message of photos alone needs no sentence: the model sees them", () => {
  assert.equal(
    attachmentsText("look", [photo()]),
    ["look", marker(photo()), "[screenshot]"].join("\n"),
  )
})

test("a photo sent beside a file still says the file's content is not inlined", () => {
  assert.ok(attachmentsText("", [photo(), file()]).endsWith(NOT_INLINED))
})

test("the wire carries a marker part per file, then the sentence", () => {
  const parts = attachmentParts("hi", [file()])
  assert.deepEqual(
    parts.map((part) => part.type),
    ["text", "text", "text"],
  )
  assert.equal(parts[0].text, "hi")
  assert.equal(parts[1].text, marker(file()))
  assert.equal(parts[2].text, NOT_INLINED)
})

test("a message with no words of its own starts at its markers", () => {
  const parts = attachmentParts("", [file()])
  assert.equal(parts.length, 2)
  assert.ok(!parts.some((part) => part.text === ""), "no empty text part goes to the model")
})

test("a marker's attributes come back out of the text they went into", () => {
  const odd = file({ name: 'a "b" & <c>.txt', path: undefined })
  assert.match(marker(odd), /name="a &quot;b&quot; &amp; &lt;c&gt;.txt"/)
  assert.equal(splitAttachments(attachmentsText("", [odd])).attachments[0].name, 'a "b" & <c>.txt')
})

test("the stored form gives back the text and every file's name, type and size", () => {
  const attachments = [
    file(),
    photo(),
    file({
      id: "f3",
      name: "clip.mp4",
      type: "video/mp4",
      size: 5_000_000,
      path: `${HOST}/clip.mp4`,
    }),
  ]
  const back = splitAttachments(attachmentsText("here it all is", attachments))
  const shape = ({ name, type, size, image, path }) => ({ name, type, size, image, path })
  assert.equal(back.text, "here it all is", "the sentence never reads back as the user's words")
  assert.deepEqual(back.attachments.map(shape), attachments.map(shape))
})

test("a message restored on another device draws the same rows", () => {
  const back = splitAttachments(
    'Sent from my phone\n<attachment name="scan.pdf" type="application/pdf" size="9999" path="/host/scan.pdf" />',
  )
  assert.deepEqual(
    back.attachments.map(({ name, type, size }) => ({ name, type, size })),
    [{ name: "scan.pdf", type: "application/pdf", size: 9999 }],
  )
})

test("a marker from an app older than size reads back with none", () => {
  const back = splitAttachments(
    'An old message\n<attachment name="notes.txt" type="text/plain" path="/host/notes.txt" />',
  )
  assert.equal(back.attachments.length, 1)
  assert.equal(back.attachments[0].size, 0)
})

test("a placeholder with no marker above it is the user's own text", () => {
  const back = splitAttachments("what is [screenshot]?")
  assert.deepEqual(back, { text: "what is [screenshot]?", attachments: [] })
})

test("a size reads in the units a person says", () => {
  assert.equal(formatBytes(512), "512 B")
  assert.equal(formatBytes(2048), "2 KB")
  assert.equal(formatBytes(1.5 * 1024 * 1024), "1.5 MB")
  assert.equal(formatBytes(9 * 1024 * 1024), "9 MB")
})
