/**
 * What a stored mark means (issue #1065): one lucide icon's name or one emoji, the palette name an
 * icon's colour comes from, and the words a search reads. The rules are the host's too
 * (`plugin/canvases.py`'s `_mark` and `_tint`), so they are checked here rather than through a screen.
 */
import assert from "node:assert/strict"
import test from "node:test"

import {
  MARK_TINTS,
  TINT_FILL,
  TINT_INK,
  markMatches,
  markWords,
  readMark,
  readTint,
} from "../src/lib/canvas-marks.ts"

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
})

test("a tint is one of the palette's names, and nothing else is a colour", () => {
  assert.deepEqual([...MARK_TINTS], ["blue", "cyan", "green", "yellow", "coral", "pink", "purple"])
  assert.equal(readTint("coral"), "coral")
  assert.equal(readTint("chartreuse"), undefined)
  assert.equal(readTint(""), undefined)
  assert.equal(readTint(undefined), undefined)
  // Every name the palette carries is drawn: an ink for the icon and a fill for the picker's swatch.
  for (const tint of MARK_TINTS) {
    assert.equal(typeof TINT_INK[tint], "string")
    assert.equal(typeof TINT_FILL[tint], "string")
  }
})

test("an icon's name reads as words a search and a label can use", () => {
  assert.equal(markWords("heart"), "Heart")
  assert.equal(markWords("alarm-clock-minus"), "Alarm clock minus")
  assert.equal(markMatches("Heart", ""), true, "an empty field narrows nothing")
  assert.equal(markMatches("Heart", "  art "), true)
  assert.equal(markMatches("Alarm clock minus", "CLOCK"), true)
  assert.equal(markMatches("Heart", "star"), false)
})
