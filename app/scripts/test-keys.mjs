import assert from "node:assert/strict"
import test from "node:test"

import {
  botShortcut,
  enterSends,
  isDoubleEscape,
  isInterrupt,
  isSendChord,
} from "../src/lib/keys.ts"

const press = (over) => ({
  key: "",
  code: "",
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...over,
})

test("Ctrl+C interrupts a running reply only when nothing is selected", () => {
  const c = press({ key: "c", ctrlKey: true })
  assert.equal(isInterrupt(c, true, false), true)
  assert.equal(isInterrupt(c, true, true), false, "a selection is copied")
  assert.equal(isInterrupt(c, false, false), false, "nothing is running")
  assert.equal(isInterrupt(press({ key: "c", ctrlKey: true, shiftKey: true }), true, false), false)
  assert.equal(isInterrupt(press({ key: "c", metaKey: true }), true, false), false)
})

test("two Escapes within the window are a double", () => {
  assert.equal(isDoubleEscape(null, 1000), false)
  assert.equal(isDoubleEscape(1000, 1400), true)
  assert.equal(isDoubleEscape(1000, 1600), false)
})

test("Alt+digit reaches a bot by the physical key, with no other modifier", () => {
  assert.equal(botShortcut(press({ altKey: true, code: "Digit1" })), 0)
  assert.equal(botShortcut(press({ altKey: true, code: "Numpad9" })), 8)
  assert.equal(botShortcut(press({ altKey: true, code: "Digit0" })), null)
  assert.equal(botShortcut(press({ code: "Digit1" })), null)
  assert.equal(botShortcut(press({ altKey: true, ctrlKey: true, code: "Digit1" })), null)
})

test("Enter starts a new line until the switch is on, and the chord always sends", () => {
  const enter = press({ key: "Enter", code: "Enter" })
  assert.equal(enterSends(enter, false), false, "the switch ships off")
  assert.equal(enterSends(enter, true), true)
})

test("the chord is one predicate, and it sends whichever way the switch is set", () => {
  for (const sendOnEnter of [false, true]) {
    for (const chord of [{ ctrlKey: true }, { metaKey: true }]) {
      const pressWithChord = press({ key: "Enter", ...chord })
      assert.equal(isSendChord(pressWithChord), true, "the menu asks this to keep its hands off")
      assert.equal(enterSends(pressWithChord, sendOnEnter), true)
    }
  }
  assert.equal(isSendChord(press({ key: "Enter" })), false, "a bare Enter is not the chord")
})

test("Shift never sends, so a new line is always one key away", () => {
  for (const sendOnEnter of [false, true]) {
    assert.equal(enterSends(press({ key: "Enter", shiftKey: true }), sendOnEnter), false)
    assert.equal(
      enterSends(press({ key: "Enter", shiftKey: true, ctrlKey: true }), sendOnEnter),
      false,
      "Shift outranks the chord",
    )
  }
})
