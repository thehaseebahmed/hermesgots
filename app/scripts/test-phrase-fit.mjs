/**
 * A row says as many of its phrases as fit, with "(+N)" standing in for the rest (ADR 0050), and a
 * row the browser has not laid out yet says nothing rather than letting CSS cut the line.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { fittingPhrases, summary } from "../src/lib/phrase-fit.ts"

const PARTS = ["Ran a command", "read 4 files", "edited 2 files", "checked a pull request"]
/** A row whose every character is 8px wide, so a candidate's length is its width. */
const width = (text) => text.length * 8
const fits = (room) => fittingPhrases(PARTS, room, width)

test("the summary is a sentence, lower-casing what follows the first phrase", () => {
  assert.equal(summary(PARTS), "Ran a command, read 4 files, edited 2 files, checked a pull request")
  assert.equal(summary(PARTS, 2), "Ran a command, read 4 files (+2)")
  assert.equal(summary(PARTS, 1), "Ran a command (+3)")
})

test("as many phrases as fit, and a count for the rest", () => {
  const full = width(summary(PARTS))
  assert.equal(fits(full), 4, "room for all of them: no count")
  const three = width("Ran a command, read 4 files, edited 2 files (+1)")
  assert.equal(fits(three), 3)
  const two = width("Ran a command, read 4 files (+2)")
  assert.equal(fits(two), 2)
  assert.equal(fits(10), 1, "a narrow row still says one phrase and its count")
})

test("the search measures a handful of candidates, not every one", () => {
  const many = Array.from({ length: 20 }, (_, index) => `call ${index}`)
  let probes = 0
  const counted = (text) => {
    probes++
    return text.length * 8
  }
  const shown = fittingPhrases(many, width(summary(many, 6)), counted)
  assert.equal(shown, 6, "the widest count that fits")
  assert.ok(probes <= 5, `a twenty-call group is five measurements, not nineteen (${probes})`)
})

test("a row with no room measured yet says nothing, rather than guessing", () => {
  assert.equal(fits(0), undefined, "the browser hasn't laid the row out")
  assert.equal(fittingPhrases([], 100, width), undefined, "and a row with no calls has nothing to fit")
  assert.equal(
    fittingPhrases(PARTS, 100, () => 0),
    undefined,
    "a ruler that measures nothing is no measurement either",
  )
})
