import assert from "node:assert/strict"
import test from "node:test"

import {
  botShortcut,
  closesThread,
  enterSends,
  isDoubleEscape,
  isInterrupt,
  isSendChord,
  reopensThread,
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

test("Escape puts the thread beside Main away, and no chord does", () => {
  assert.equal(closesThread(press({ key: "Escape", code: "Escape" })), true, "the bare key")
  for (const chord of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }])
    assert.equal(
      closesThread(press({ key: "Escape", ...chord })),
      false,
      "a chord is another key's",
    )
  assert.equal(closesThread(press({ key: "Enter", code: "Enter" })), false)
})

test("⌘\\ asks for the thread just closed: Cmd on a Mac, Ctrl elsewhere, and nothing else", () => {
  const slash = { key: "\\", code: "Backslash" }
  assert.equal(reopensThread(press({ ...slash, metaKey: true }), true), true, "⌘\\ on a Mac")
  assert.equal(reopensThread(press({ ...slash, ctrlKey: true }), false), true, "Ctrl+\\ elsewhere")
  // The other platform's modifier is some other command's key on this one.
  assert.equal(
    reopensThread(press({ ...slash, ctrlKey: true }), true),
    false,
    "Ctrl+\\ is not the Mac's chord",
  )
  assert.equal(
    reopensThread(press({ ...slash, metaKey: true }), false),
    false,
    "⌘\\ is not a PC's chord",
  )
  // Option turns the key into another character on a Mac, so the physical key is what is read —
  // and the modifier still stands the chord down.
  assert.equal(
    reopensThread(press({ key: "«", code: "Backslash", altKey: true, metaKey: true }), true),
    false,
    "Option+\\ is not the chord",
  )
  assert.equal(
    reopensThread(press({ key: "|", code: "Backslash", shiftKey: true, ctrlKey: true }), false),
    false,
    "Shift+\\ types a pipe",
  )
  assert.equal(
    reopensThread(press({ key: "/", code: "Slash", metaKey: true }), true),
    false,
    "another key",
  )
  assert.equal(reopensThread(press(slash), true), false, "a bare \\ is typing")
  assert.equal(reopensThread(press(slash), false), false)
})
