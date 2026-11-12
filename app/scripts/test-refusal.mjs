/**
 * Whose words a failed write shows, decided once: the host's, held for the surface that caused the
 * write to draw, or the app's own sentence, said in passing where the host sent none.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { failed, refuse } from "../src/lib/refusal.ts"

const ALONE = "Couldn't save that."

test("the host's words are held for the surface, and nothing is said in passing", () => {
  assert.deepEqual(refuse(failed(new Error("That bot is running a turn."), ALONE)), {
    hold: "That bot is running a turn.",
  })
})

test("the room around the host's words is not drawn", () => {
  assert.deepEqual(refuse(failed(new Error("  That bot is running a turn.  "), ALONE)), {
    hold: "That bot is running a turn.",
  })
})

test("the app's own sentence is toasted when the host said nothing", () => {
  assert.deepEqual(refuse(failed("no", ALONE)), { alone: ALONE })
})

test("a host that sent only blanks said nothing", () => {
  assert.deepEqual(refuse(failed(new Error("   "), ALONE)), { alone: ALONE })
})

test("a browser's own sentence is not the host's words", () => {
  assert.deepEqual(refuse(failed(new TypeError("Failed to fetch"), ALONE)), { alone: ALONE })
})

test("a write that landed holds nothing and says nothing", () => {
  assert.deepEqual(refuse({ ok: true }), {})
})
