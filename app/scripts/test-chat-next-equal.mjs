import assert from "node:assert/strict"
import test from "node:test"

import { equal } from "../src/chat-next/equal.ts"

test("values that say the same are equal, whatever order their keys came in", () => {
  assert.ok(equal({ a: 1, b: [1, { c: "x" }] }, { b: [1, { c: "x" }], a: 1 }))
  assert.ok(equal([], []))
  assert.ok(equal("x", "x"))
})

test("a key holding undefined is no key, as JSON would have it", () => {
  assert.ok(equal({ a: 1, b: undefined }, { a: 1 }))
  assert.equal(equal({ a: 1, b: undefined }, { a: 1, c: 2 }), false)
})

test("a different word, length or shape is different", () => {
  assert.equal(equal({ a: "x" }, { a: "y" }), false)
  assert.equal(equal([1, 2], [1, 2, 3]), false)
  assert.equal(equal([1], { 0: 1 }), false)
  assert.equal(equal(null, {}), false)
  assert.equal(equal({ a: null }, { a: {} }), false)
})
