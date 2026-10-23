import assert from "node:assert/strict"
import test from "node:test"

import { keptAudio } from "../src/lib/dictation-kept.ts"

const piece = (text, bytes = "slice") => ({
  blob: new Blob([bytes], { type: "audio/webm" }),
  text,
})

test("a kept take's audio is every piece without text, joined in the order it was made", async () => {
  const audio = keptAudio([piece(null, "one"), piece(null, "two"), piece(null, "three")])
  assert.ok(audio)
  assert.equal(await audio.text(), "onetwothree")
  assert.equal(audio.type, "audio/webm", "the take keeps the type the recorder made it in")
})

test("the pieces already transcribed are not asked for again", async () => {
  const audio = keptAudio([piece("said"), piece(null, "tail")])
  assert.equal(await audio.text(), "tail")
})

test("a take with nothing left to ask for has no audio", () => {
  assert.equal(keptAudio([piece("all of it")]), null)
  assert.equal(keptAudio([]), null)
  assert.equal(keptAudio([piece(null, "")]), null, "an empty slice is not a recording")
})
