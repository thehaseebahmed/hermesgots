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

const words = (text) => text.split(/\s+/).filter(Boolean)

/** What the bar showed after each of the take's answers, the first moment before any of them. */
function moments(answers) {
  let take = settled(openingTranscript())
  const seen = [transcriptText(take)]
  for (const answer of answers) {
    take = hear(take, answer)
    seen.push(transcriptText(take))
  }
  return seen
}

/** The bar's promise: what it showed earlier is the start of what it shows later, word for word. */
function assertOnlyAdds(seen) {
  for (const [at, earlier] of seen.slice(0, -1).entries()) {
    const later = seen[at + 1]
    assert.ok(later.startsWith(earlier), `"${later}" starts with "${earlier}"`)
    assert.deepEqual(
      words(later).slice(0, words(earlier).length),
      words(earlier),
      `"${later}" keeps every word of "${earlier}" in place`,
    )
  }
}

test("the bar shows a word once and never takes it back", () => {
  // Answers a host holding the commit rule sends: it holds the newest word until a later window
  // still has it, an empty answer is a window whose frontier was revised (nothing to add), and a
  // phrase's close commits the tail whole. Nothing the bar showed before is replaced or removed.
  const seen = moments([
    { words: "let us" },
    { words: " ship" },
    { words: "" },
    { words: "", phrases: [phrase(1, "let us ship the dictation")] },
    { words: " today" },
    { words: "", phrases: [phrase(2, "today and then some")] },
  ])
  assertOnlyAdds(seen)
  assert.equal(
    seen.at(-1),
    "let us ship the dictation today and then some",
    "the take is what was said, either side of both pauses",
  )
})

test("a word the windows are still arguing about is never shown and then corrected", () => {
  // The host sends nothing while its two windows disagree, so the bar goes quiet rather than
  // showing a guess it would have to take back — and it picks up again when they agree.
  const seen = moments([
    { words: "we ship" },
    { words: "" },
    { words: " the boat" },
    { words: "" },
    { words: " today" },
  ])
  assert.deepEqual(seen, [
    "",
    "we ship",
    "we ship",
    "we ship the boat",
    "we ship the boat",
    "we ship the boat today",
  ])
  assertOnlyAdds(seen)
})

test("a phrase said twice is shown twice", () => {
  const seen = moments([
    { words: "no no" },
    { words: "", phrases: [phrase(1, "no no")] },
    { words: "", phrases: [phrase(2, "no no")] },
  ])
  assert.equal(seen.at(-1), "no no no no")
  assertOnlyAdds(seen)
})
