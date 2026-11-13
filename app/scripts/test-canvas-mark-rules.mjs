/**
 * What a stored mark means (issue #1065): one lucide icon's name or one emoji, and the words a search
 * reads. The rule is the host's too (`plugin/canvases.py`'s `_mark`), so it is checked here rather
 * than through a screen.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { markMatches, markWords, readMark } from "../src/lib/canvas-marks.ts"

test("a mark reads as the icon it names, or as the emoji it is", () => {
  assert.deepEqual(readMark("heart"), { kind: "icon", name: "heart" })
  assert.deepEqual(readMark("alarm-clock-minus"), { kind: "icon", name: "alarm-clock-minus" })
  assert.deepEqual(readMark("🎉"), { kind: "emoji", glyph: "🎉" })
  assert.deepEqual(readMark("❤️"), { kind: "emoji", glyph: "❤️" })
  // A canvas with no mark, and one whose mark was cleared, draw the app's own frame either way.
  assert.equal(readMark(""), undefined)
  assert.equal(readMark(undefined), undefined)
  // A word is no mark: the host refuses one, so a record holding one draws the frame rather than
  // spelling it out in the row's 20px slot.
  assert.equal(readMark("Heart"), undefined)
  assert.equal(readMark("two words"), undefined)
  assert.equal(readMark("漢"), undefined, "a letter in another script is a word too")
})

test("an icon's name reads as words a search and a label can use", () => {
  assert.equal(markWords("heart"), "Heart")
  assert.equal(markWords("alarm-clock-minus"), "Alarm clock minus")
  assert.equal(markMatches("Heart", ""), true, "an empty field narrows nothing")
  assert.equal(markMatches("Heart", "  art "), true)
  assert.equal(markMatches("Alarm clock minus", "CLOCK"), true)
  assert.equal(markMatches("Heart", "star"), false)
})
