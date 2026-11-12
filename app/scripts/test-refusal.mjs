/**
 * Whose words a failed write shows, decided once: the host's, held for the surface that caused the
 * write to draw, or the app's own sentence, said in passing where the host sent none.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { refuse } from "../src/lib/refusal.ts"

const failure = (over = {}) => ({ ok: false, alone: "Couldn't save that.", ...over })

test("the host's words are held for the surface, and nothing is said in passing", () => {
  assert.deepEqual(refuse(failure({ said: "That bot is running a turn." })), {
    hold: "That bot is running a turn.",
  })
})

test("the app's own sentence is toasted when the host said nothing", () => {
  assert.deepEqual(refuse(failure()), { alone: "Couldn't save that." })
})

test("a host that sent only blanks said nothing", () => {
  assert.deepEqual(refuse(failure({ said: "   " })), { alone: "Couldn't save that." })
})

test("a write that landed holds nothing and says nothing", () => {
  assert.deepEqual(refuse({ ok: true }), {})
})
