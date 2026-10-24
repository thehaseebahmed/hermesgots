/**
 * The rule behind a Prompt row's `Update` badge: a pick is a copy, so the row tells a copy from
 * an original by comparing the project's words with the entry they name. Nothing is stored to know
 * that an entry moved on, which is why every way there is nothing to compare — no source, or an entry
 * this device doesn't hold — reads as no badge at all rather than as a change.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { promptSourceState } from "../src/lib/prompt-source.ts"

const entry = (body) => ({ body })

test("a Prompt nobody copied from is never marked", () => {
  assert.equal(
    promptSourceState(null, "# Mine", entry("# Mine")),
    "none",
    "words the user typed are their own, whatever an entry happens to say",
  )
  assert.equal(promptSourceState(null, "# Mine", undefined), "none", "and with no entry at all")
})

test("a copy that still matches its entry is the original", () => {
  assert.equal(
    promptSourceState(
      "e-one",
      "# Review\n\nRead the diff first.",
      entry("# Review\n\nRead the diff first."),
    ),
    "original",
    "the same words in both is nothing to pull",
  )
})

test("a copy whose entry now reads otherwise has changed in the library", () => {
  assert.equal(
    promptSourceState(
      "e-one",
      "# Review\n\nRead the diff first.",
      entry("# Review\n\nRead the issue first."),
    ),
    "changed",
    "the entry moved on, so the row offers its new words",
  )
  assert.equal(
    promptSourceState("e-one", "", entry("# Review")),
    "changed",
    "an emptied Prompt is not the entry's copy either",
  )
  assert.equal(
    promptSourceState(
      "e-one",
      "# Review\n\nRead the diff first.",
      entry("# Review\n\nRead the dif first."),
    ),
    "changed",
    "a difference inside the words is a difference",
  )
})

test("the ends a write trims are not a change", () => {
  assert.equal(
    promptSourceState(
      "e-one",
      "# Review\n\nRead the diff first.",
      entry("# Review\n\nRead the diff first.\n"),
    ),
    "original",
    "the host trims a Prompt when it stores one, so a fresh pick of an entry with a trailing newline is still its copy",
  )
  assert.equal(
    promptSourceState("e-one", "# Review", entry("\n  # Review  \n\n")),
    "original",
    "the same holds for whitespace at either end",
  )
})

test("an entry this device no longer holds leaves the copy standing", () => {
  assert.equal(
    promptSourceState("e-one", "# Review", undefined),
    "none",
    "a deleted entry has nothing to pull, and its copy is not called stale",
  )
  assert.equal(
    promptSourceState("e-one", "# Review", null),
    "none",
    "nor one a signed-out library hides",
  )
})
