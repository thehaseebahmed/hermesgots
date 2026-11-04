/**
 * The one line rule: a message's words flattened, and cut where the host cuts them. The plugin writes
 * the same rule (`_line` in `plugin/triage.py`), so a value both tiers carry reads the same way on
 * each side — a card's bubble, a sidebar preview, a session's title, an opener.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { oneLine } from "../src/lib/words.ts"

test("runs of whitespace become one space, and nothing typed is lost", () => {
  assert.equal(oneLine("  plan my   trip \n\n today "), "plan my trip today")
  assert.equal(oneLine("one\ttwo"), "one two")
})

test("words that are only whitespace are no line at all", () => {
  assert.equal(oneLine("   \n\t "), undefined)
  assert.equal(oneLine(""), undefined)
})

test("a cut line ends in an ellipsis, and the cut line is the length asked for", () => {
  const cut = oneLine("a".repeat(5000), 2000)
  assert.equal(cut?.length, 2000, "the limit includes the ellipsis, as the host's does")
  assert.ok(cut?.endsWith("…"))
  assert.equal(oneLine("short", 2000), "short", "and a line inside the limit keeps its end")
})
