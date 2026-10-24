import assert from "node:assert/strict"
import test from "node:test"

import {
  countRefusal,
  filesReason,
  fitsInline,
  fresh,
  inlineRefusal,
  intake,
  keptImage,
  MAX_ATTACHMENTS,
  MAX_FILE_BYTES,
  MAX_INLINE_BYTES,
  sizeRefusal,
  unreadableRefusal,
} from "../src/lib/attachment-caps.ts"

const file = (name, size, type = "application/octet-stream") => ({ name, size, type })

test("a pick stops at ten attachments and says how many were left out", () => {
  const many = Array.from({ length: 12 }, (_, index) =>
    file(`photo-${index}.jpg`, 1000, "image/jpeg"),
  )
  const picked = intake(many)
  assert.equal(picked.take.length, MAX_ATTACHMENTS)
  assert.deepEqual(
    picked.refusals.map((refusal) => refusal.message),
    ["A message can carry 10 attachments, so 2 were left out."],
    "the leftovers are one line, naming the limit",
  )

  const almostFull = intake(many, 8)
  assert.equal(almostFull.take.length, 2, "what the message already holds comes off the room")
  assert.match(almostFull.refusals[0].message, /so 10 were left out\./)

  assert.equal(intake(many, 10).take.length, 0, "a full message takes nothing")
  assert.match(intake(many, 10).refusals[0].message, /so 12 were left out\./)
})

test("a file over nine megabytes is refused in its own name", () => {
  const picked = intake([file("clip.mov", MAX_FILE_BYTES + 1, "video/quicktime")])
  assert.deepEqual(picked.take, [], "it never lands")
  assert.deepEqual(
    picked.refusals.map((refusal) => refusal.message),
    ["clip.mov is over the 9 MB limit."],
  )
  assert.equal(picked.refusals[0].limit, "file")

  assert.equal(intake([file("clip.mov", MAX_FILE_BYTES, "video/quicktime")]).take.length, 1)
})

test("a photo that will be scaled is taken however big it arrives", () => {
  const shot = file("shot.heic", 12 * 1024 * 1024, "image/heic")
  assert.equal(intake([shot]).take.length, 1, "scaling it is what makes it fit the request")
  assert.equal(
    intake([shot], 0, { inline: false }).take.length,
    0,
    "a model that takes no images is sent the file itself, so the cap applies",
  )
  assert.deepEqual(
    intake([file("draw.svg", 10 * 1024 * 1024, "image/svg+xml")]).take,
    [],
    "SVG goes as a file",
  )
})

test("a photo over the inline budget is refused, in the budget's own words", () => {
  const megabyte = 1024 * 1024
  assert.equal(fitsInline(1 * megabyte, MAX_INLINE_BYTES - megabyte), true)
  assert.equal(fitsInline(1 * megabyte, MAX_INLINE_BYTES - megabyte + 1), false)
  assert.equal(fitsInline(0, MAX_INLINE_BYTES), true)
  assert.equal(fitsInline(1, MAX_INLINE_BYTES), false)

  const refusal = inlineRefusal("big.png")
  assert.equal(
    refusal.message,
    "big.png doesn't fit: a message's photos can add up to 6.5 MB. Send it in the next one.",
  )
  assert.equal(refusal.limit, "inline")
})

test("a paste and the drop it also fires add one copy, and a later pick adds another", () => {
  const seen = new Map()
  const photo = { ...file("cat.png", 10, "image/png"), lastModified: 5 }
  const other = { ...file("dog.png", 10, "image/png"), lastModified: 6 }

  assert.deepEqual(fresh([photo, other], seen, 1000), [photo, other])
  assert.deepEqual(
    fresh([photo, other], seen, 1100),
    [],
    "the same files arriving again moments later",
  )
  assert.deepEqual(fresh([photo], seen, 5000), [photo], "the user picking one again on purpose")
})

test("a share's refusals name the limits in the same words", () => {
  assert.equal(sizeRefusal("report.pdf").message, "report.pdf is over the 9 MB limit.")
  assert.equal(countRefusal(1).message, "A message can carry 10 attachments, so 1 was left out.")
  assert.equal(
    unreadableRefusal("clip.mp4").message,
    "Gots couldn't read clip.mp4 from that share.",
  )
})

test("Files is refused in one sentence wherever a file can arrive", () => {
  assert.equal(filesReason("yes"), null, "a host that has the route explains nothing")
  assert.equal(filesReason("no"), "File uploads need a newer Gots plugin.")
  assert.equal(filesReason("unknown"), "File uploads need the Gots plugin.")
})

test("the host keeps the file the user chose, with the scaled copy as the model's part", () => {
  const original = { size: 4 * 1024 * 1024, type: "image/png" }
  const smaller = { size: 900 * 1024, type: "image/jpeg" }
  const kept = keptImage(original, smaller)
  assert.equal(kept.kept, original, "the copy kept is the file itself, bytes and all")
  assert.equal(kept.inline, smaller, "the scaled copy is only the part the model reads")
})

test("an original too big to keep is what the scaled copy stands in for", () => {
  const huge = { size: MAX_FILE_BYTES + 1, type: "image/heic" }
  const smaller = { size: 2 * 1024 * 1024, type: "image/jpeg" }
  assert.deepEqual(keptImage(huge, smaller), { kept: smaller })
  assert.equal(
    keptImage({ size: MAX_FILE_BYTES }, smaller).kept.size,
    MAX_FILE_BYTES,
    "nine megabytes itself still fits",
  )
})

test("a photo that needed no scaling is one copy, not two", () => {
  const photo = { size: 400 * 1024, type: "image/png" }
  assert.deepEqual(keptImage(photo, photo), { kept: photo })
  assert.deepEqual(keptImage(photo, null), { kept: photo })
})
