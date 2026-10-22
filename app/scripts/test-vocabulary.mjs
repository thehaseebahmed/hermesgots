// A bot's vocabulary as a pure rule: a word added, removed, kept once and kept short — and the
// bot record it rides in, which syncs last-write-wins like the bot's title. No DOM, no host.
import assert from "node:assert/strict"
import test from "node:test"

import { mergeDocs } from "../src/lib/merge.ts"
import {
  MAX_WORDS,
  MAX_WORD,
  addWord,
  cleanWord,
  readVocabulary,
  removeWord,
} from "../src/lib/vocabulary.ts"

const list = (...words) => words.reduce(addWord, [])

test("a word is added at the end, spelled as the user typed it", () => {
  assert.deepEqual(addWord(["Gots"], "  Haseeb  "), ["Gots", "Haseeb"])
  assert.deepEqual(addWord([], "DeepSeek"), ["DeepSeek"])
})

test("a word is one line, and no longer than a name", () => {
  assert.equal(cleanWord("  Foo \n  bar "), "Foo bar")
  assert.equal(cleanWord("x".repeat(MAX_WORD + 20)).length, MAX_WORD)
  assert.equal(cleanWord("   "), "")
})

test("a word the list already holds is not added again, however it is cased", () => {
  assert.deepEqual(addWord(["Gots"], "gots"), ["Gots"])
  assert.deepEqual(addWord(["Gots"], "GOTS"), ["Gots"])
  assert.deepEqual(list("Gots", "gots", "Gots"), ["Gots"])
})

test("an empty word is not a word", () => {
  assert.deepEqual(addWord(["Gots"], "  "), ["Gots"])
})

test("the list is capped, and the words just typed are the ones kept", () => {
  const full = Array.from({ length: MAX_WORDS }, (_, index) => `word${index}`)
  assert.deepEqual(addWord(full, "another"), [...full.slice(1), "another"])
  assert.equal(addWord(full, "another").length, MAX_WORDS)
})

test("a word is removed however it is cased, and the rest stay in order", () => {
  assert.deepEqual(removeWord(["Gots", "Haseeb", "DeepSeek"], "haseeb"), ["Gots", "DeepSeek"])
  assert.deepEqual(removeWord(["Gots"], "absent"), ["Gots"])
})

test("a record's words are read back through the rules", () => {
  assert.deepEqual(readVocabulary(["Gots", " gots ", "", 7, null, "DeepSeek"]), [
    "Gots",
    "DeepSeek",
  ])
  assert.deepEqual(readVocabulary(undefined), [])
  assert.deepEqual(readVocabulary("Gots"), [])
})

// The bot record: the words travel in it, and two devices agree on them the way they agree on a
// title — the record with the later change clock wins whole.
test("two devices agree on a bot's words after a sync", () => {
  const thisDevice = { "bot-1": { at: 20, value: { name: "Gots", vocabulary: ["Haseeb"] } } }
  const otherDevice = { "bot-1": { at: 10, value: { name: "Gots", vocabulary: [] } } }
  const here = mergeDocs(otherDevice, thisDevice)
  const there = mergeDocs(thisDevice, otherDevice)
  assert.deepEqual(here.merged, thisDevice)
  assert.equal(here.changed, true)
  assert.deepEqual(there.pull, [["bot-1", thisDevice["bot-1"]]])
})

test("a word added on one device is not undone by an older record", () => {
  const older = { "bot-1": { at: 5, value: { name: "Gots", vocabulary: ["Gots"] } } }
  const newer = { "bot-1": { at: 6, value: { name: "Gots", vocabulary: ["Gots", "Haseeb"] } } }
  assert.deepEqual(mergeDocs(older, newer).merged, newer)
})

test("a word removed on one device is gone on the other", () => {
  const withWord = { "bot-1": { at: 5, value: { vocabulary: ["Gots", "Haseeb"] } } }
  const without = { "bot-1": { at: 7, value: { vocabulary: ["Gots"] } } }
  assert.deepEqual(mergeDocs(withWord, without).merged, without)
})
