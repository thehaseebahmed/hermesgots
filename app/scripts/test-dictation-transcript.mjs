// The take's transcript as a pure rule: what a slice's answer does to the words and phrases a take
// has heard, and what the take's text is. No DOM, no host — `dictation-transcript.ts` imports nothing.
import assert from "node:assert/strict"
import test from "node:test"

import {
  EMPTY_TRANSCRIPT,
  hear,
  hearing,
  openingTranscript,
  settled,
  transcriptText,
} from "../src/lib/dictation-transcript.ts"

const phrase = (id, text) => ({ id, text })

test("a take that has just started is preparing", () => {
  const opening = openingTranscript()
  assert.equal(opening.preparing, true)
  assert.equal(transcriptText(opening), "")
  assert.equal(hearing(opening), true)
})

test("the host answering ends preparing, and so does the first word", () => {
  assert.equal(settled(openingTranscript()).preparing, false)
  assert.equal(hear(openingTranscript(), { words: "hello" }).preparing, false)
})

test("words arrive one after another, with one space between them", () => {
  let take = settled(openingTranscript())
  take = hear(take, { words: "hello" })
  take = hear(take, { words: " there " })
  take = hear(take, { words: "" })
  assert.equal(take.words, "hello there")
  assert.equal(transcriptText(take), "hello there")
})

test("a closed phrase takes the words that were open in front of it", () => {
  let take = settled(openingTranscript())
  take = hear(take, { words: "hello there" })
  take = hear(take, { words: "", phrases: [phrase(1, "hello there my friend")] })
  assert.deepEqual(take.phrases, [phrase(1, "hello there my friend")])
  assert.equal(take.words, "")
  assert.equal(transcriptText(take), "hello there my friend")
})

test("the words after a phrase are the next phrase's", () => {
  let take = hear(settled(openingTranscript()), { phrases: [phrase(1, "One.")] })
  take = hear(take, { words: "and then" })
  take = hear(take, { words: "", phrases: [phrase(2, "and then two.")] })
  assert.equal(transcriptText(take), "One. and then two.")
})

test("a phrase that arrives again replaces its text rather than appearing twice", () => {
  let take = hear(settled(openingTranscript()), { phrases: [phrase(1, "hello there my freind")] })
  take = hear(take, { phrases: [phrase(1, "Hello there, my friend.")] })
  assert.deepEqual(take.phrases, [phrase(1, "Hello there, my friend.")])
})

test("behind is said once and kept", () => {
  let take = hear(settled(openingTranscript()), { behind: true })
  assert.equal(take.behind, true)
  take = hear(take, { words: "hello", behind: false })
  assert.equal(take.behind, true)
})

test("an empty take has nothing to show in the bar", () => {
  assert.equal(hearing(EMPTY_TRANSCRIPT), false)
  assert.equal(hearing(null), false)
  assert.equal(transcriptText(EMPTY_TRANSCRIPT), "")
})

test("an answer of an unknown shape changes nothing", () => {
  const take = hear(settled(openingTranscript()), {})
  assert.deepEqual(take, settled(openingTranscript()))
  const odd = hear(settled(openingTranscript()), { phrases: [{ id: "nope", text: 3 }] })
  assert.deepEqual(odd.phrases, [])
})
