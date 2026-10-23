import assert from "node:assert/strict"
import test from "node:test"

import { keptAudio, keeper } from "../src/lib/dictation-kept.ts"

const piece = (text, bytes = "slice") => ({
  blob: new Blob([bytes], { type: "audio/webm" }),
  text,
})
const pause = (ms) => new Promise((done) => setTimeout(done, ms))

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

test("a slice every 250 ms is not a write every 250 ms", async () => {
  const writes = []
  const kept = keeper(
    "c:1",
    async (take) => {
      writes.push(take)
    },
    { ms: 40 },
  )
  for (let slice = 0; slice < 60; slice += 1) {
    kept.keep({ pieces: [piece(null, String(slice))] })
    await pause(2)
  }
  await kept.flush()
  assert.ok(writes.length >= 1, "the take was written")
  assert.ok(writes.length <= 5, `${writes.length} writes for 60 slices in 120 ms`)
})

test("what is held is written at once when the take ends, with where it began", async () => {
  const writes = []
  const kept = keeper(
    "c:1",
    async (take) => {
      writes.push(take)
    },
    { ms: 10_000 },
  )
  kept.keep({ pieces: [piece(null, "one")] })
  assert.equal(writes.length, 0, "nothing is written before the take ends")
  await kept.keep({ pieces: [piece(null, "one"), piece(null, "two")], caret: 3 }, true)
  assert.equal(writes.length, 1)
  assert.equal(writes[0].pieces.length, 2)
  assert.equal(writes[0].caret, 3)
})

test("discarding deletes what was kept, and nothing brings it back", async () => {
  const seen = []
  const kept = keeper(
    "c:1",
    async (take) => {
      seen.push(take ? "take" : "gone")
    },
    { ms: 10_000 },
  )
  kept.keep({ pieces: [piece(null, "one")] })
  await kept.flush()
  await kept.drop()
  assert.deepEqual(seen, ["take", "gone"])
  await kept.flush()
  assert.deepEqual(seen, ["take", "gone"], "a take discarded stays discarded")
})

test("a composer with no key keeps nothing on the device", async () => {
  let writes = 0
  const kept = keeper(undefined, async () => {
    writes += 1
  })
  await kept.keep({ pieces: [piece(null, "one")] }, true)
  await kept.drop()
  assert.equal(writes, 0)
})

test("a dropped take is not written back by a slice its recorder sends as it stops", async () => {
  const writes = []
  const kept = keeper(
    "c:1",
    async (take) => {
      writes.push(take)
    },
    { ms: 20 },
  )
  kept.keep({ pieces: [piece(null, "held")] })
  await kept.drop()
  kept.keep({ pieces: [piece(null, "late")] })
  await kept.flush()
  assert.ok(
    writes.every((take) => !take || !JSON.stringify(take).includes("late")),
    "a late slice writes nothing",
  )
  assert.equal(writes.at(-1), null, "the write that ends it is the drop")
})
