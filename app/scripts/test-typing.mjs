import assert from "node:assert/strict"
import test from "node:test"

import { DOTS_STEPS, dotsAt, heldLabel, lineText, nextText, typedLabel } from "../src/lib/typing.ts"

/** Every text a line passes through on its way from `from` to `label`, a step at a time. */
function walk(from, label) {
  const steps = []
  let shown = from
  for (let guard = 0; guard < 200 && shown !== typedLabel(label); guard += 1) {
    shown = nextText(shown, label)
    steps.push(shown)
  }
  return steps
}

test("a label is typed as its words, the ellipsis left to the dots", () => {
  assert.equal(typedLabel("Writing…"), "Writing")
  assert.equal(typedLabel("Running bash…"), "Running bash")
  assert.equal(typedLabel("Waiting for your approval…"), "Waiting for your approval")
})

test("a label carrying no ellipsis is typed whole", () => {
  assert.equal(typedLabel("Waiting for your answer"), "Waiting for your answer")
  assert.equal(typedLabel("Compacting"), "Compacting")
})

test("an empty line stays empty", () => {
  assert.equal(typedLabel(""), "")
  assert.equal(nextText("", ""), "")
  assert.equal(nextText("", "…"), "", "an ellipsis alone has no words to type")
})

test("a line types one character at a time toward its label", () => {
  assert.equal(nextText("", "Writing…"), "W")
  assert.equal(nextText("W", "Writing…"), "Wr")
  assert.equal(nextText("Writin", "Writing…"), "Writing")
  assert.equal(nextText("Writing", "Writing…"), "Writing", "a line already at its label stays there")
})

test("a label change rubs out what the two do not share, keeping what they do", () => {
  const steps = walk("Thinking", "Thought for 12s")
  const turn = steps.indexOf("Th")
  assert.ok(turn > 0, "the shared start is where the rubbing out turns into typing")
  assert.deepEqual(
    steps.slice(0, turn),
    ["Thinkin", "Thinki", "Think", "Thin", "Thi"],
    "everything past the shared start comes off, a character at a time",
  )
  assert.deepEqual(
    steps.slice(turn, turn + 3),
    ["Th", "Tho", "Thou"],
    "and the new label types from there, keeping the two characters they share",
  )
  assert.equal(steps.at(-1), "Thought for 12s", "until the label is whole")
  for (const step of steps.slice(turn))
    assert.ok(step.startsWith("Th") && "Thought for 12s".startsWith(step), "each is a prefix of it")
})

test("two labels with nothing in common empty the line before the new one types", () => {
  const steps = walk("Writing", "Running bash…")
  assert.equal(steps[0], "Writin", "the first step rubs a character out")
  assert.ok(steps.includes(""), "the line reaches nothing before the new label begins")
  assert.equal(steps.at(-1), "Running bash", "and then says the whole of it")
})

test("the dots grow a step at a time and wrap back to none", () => {
  assert.equal(dotsAt(0), "")
  assert.equal(dotsAt(1), ".")
  assert.equal(dotsAt(2), "..")
  assert.equal(dotsAt(3), "...")
  assert.equal(dotsAt(DOTS_STEPS), "", "three is the most, then none again")
  assert.equal(dotsAt(DOTS_STEPS + 1), ".")
})

test("a line reads what has arrived, then its dots once its words are in", () => {
  assert.equal(lineText("", "Writing…", 0), "", "nothing has arrived yet")
  assert.equal(lineText("Writ", "Writing…", 2), "Writ", "the dots wait for the whole word")
  assert.equal(lineText("Writing", "Writing…", 0), "Writing", "the words are in, and no dot yet")
  assert.equal(lineText("Writing", "Writing…", 2), "Writing..", "then the step's dots")
  assert.equal(lineText("Compacting", "Compacting", 1), "Compacting.", "a label with no ellipsis grows them too")
})

test("the box a line holds is the widest it can read, dots and all", () => {
  assert.equal(heldLabel("Writing…"), "Writing...", "the words, with the most dots they can carry")
  assert.equal(
    heldLabel("Waiting for your answer"),
    "Waiting for your answer",
    "a label with no ellipsis reads whole, and holds no more",
  )
  assert.ok(
    heldLabel("Writing…").length > typedLabel("Writing…").length,
    "so the box never grows as the dots land",
  )
})
