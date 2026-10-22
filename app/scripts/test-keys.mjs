import assert from "node:assert/strict"
import test from "node:test"

import { botShortcut, isDoubleEscape, isInterrupt } from "../src/lib/keys.ts"

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
