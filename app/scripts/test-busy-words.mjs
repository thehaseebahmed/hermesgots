import assert from "node:assert/strict"
import test from "node:test"

import { BUSY_WORDS, BUSY_WORD_MS, busyWord } from "../src/lib/busy-words.ts"

test("every word is a single word", () => {
  for (const [kind, words] of Object.entries(BUSY_WORDS)) {
    assert.ok(words.length >= 6, kind)
    assert.equal(new Set(words).size, words.length, `${kind} repeats a word`)
    for (const word of words) assert.match(word, /^\p{L}+$/u, word)
  }
})

test("a word is steady within its tick and ends in an ellipsis", () => {
  const a = busyWord("writing", "thread-1", 10 * BUSY_WORD_MS + 5)
  assert.equal(busyWord("writing", "thread-1", 10 * BUSY_WORD_MS + BUSY_WORD_MS - 1), a)
  assert.match(a, /^\p{L}+…$/u)
})

test("the next tick is a different word, through a whole cycle", () => {
  for (const kind of Object.keys(BUSY_WORDS)) {
    const seen = new Set()
    let before = ""
    for (let tick = 0; tick < BUSY_WORDS[kind].length; tick++) {
      const word = busyWord(kind, "s", tick * BUSY_WORD_MS)
      assert.notEqual(word, before)
      seen.add(word)
      before = word
    }
    assert.equal(seen.size, BUSY_WORDS[kind].length)
  }
})

test("different seeds start in different places", () => {
  const starts = new Set(
    ["a", "b", "c", "d", "e", "f", "g", "h"].map((seed) => busyWord("thinking", seed, 0)),
  )
  assert.ok(starts.size > 1)
})
