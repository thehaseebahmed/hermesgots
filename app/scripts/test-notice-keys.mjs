import assert from "node:assert/strict"
import test from "node:test"

import { keyMoves } from "../src/lib/notice-keys.ts"

test("a bot that is on is handed the key until it holds this one", () => {
  assert.deepEqual(keyMoves([{ id: "a" }], new Map(), "k1"), { hand: ["a"], forget: [] })
  assert.deepEqual(keyMoves([{ id: "a" }], new Map([["a", "k1"]]), "k1"), { hand: [], forget: [] })
  assert.deepEqual(keyMoves([{ id: "a" }], new Map([["a", "k0"]]), "k1"), {
    hand: ["a"],
    forget: [],
  })
})

test("a bot turned off is told to forget the key once", () => {
  const off = [{ id: "a", disabled: true }]
  assert.deepEqual(keyMoves(off, new Map([["a", "k1"]]), "k1"), { hand: [], forget: ["a"] })
  assert.deepEqual(keyMoves(off, new Map([["a", ""]]), "k1"), { hand: [], forget: [] })
})

test("two bots on one plugin are one: an enabled one keeps the key", () => {
  const both = [{ id: "a", disabled: true }, { id: "a" }]
  assert.deepEqual(keyMoves(both, new Map(), "k1"), { hand: ["a"], forget: [] })
})
