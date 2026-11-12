/**
 * The write wrapper that answers instead of announcing: its answer is what a surface draws, and it
 * reaches no toast at all — which is what makes "draw the failure where it happened" the only way a
 * caller can report one. Whose words a failure carries is `refusal.ts`'s decision, so the two a
 * person cannot read — the browser's own `TypeError` from `fetch`, and a throw that isn't an error
 * at all — are answered with the app's sentence alone.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { attempt } from "../src/lib/attempt.ts"

test("a write that lands answers ok", async () => {
  assert.deepEqual(await attempt("save that", async () => {}), { ok: true })
})

test("the host's answer is returned, not announced", async () => {
  const refused = new Error("That bot is running a turn.")
  const answer = await attempt("save that", async () => {
    throw refused
  })
  assert.equal(answer.ok, false)
  assert.equal(answer.said, "That bot is running a turn.")
  assert.equal("alone" in answer, false, "a sentence the host gave is not one the app says for it")
  assert.equal(answer.caught, refused, "and the error itself comes back with it")
})

test("a refusal with no words of its own answers alone", async () => {
  const answer = await attempt("save that", async () => {
    throw new Error("   ")
  })
  assert.equal(answer.ok, false)
  assert.equal("said" in answer, false)
  assert.equal(answer.alone, "Couldn't save that.")
})

test("a refusal that isn't an Error answers alone", async () => {
  const answer = await attempt("remove that", () => Promise.reject("no"))
  assert.equal(answer.ok, false)
  assert.equal("said" in answer, false)
  assert.equal(answer.alone, "Couldn't remove that.")
})

test("a browser's own sentence is not the host's words", async () => {
  // What a host that is simply down raises: `fetch` rejects before any answer exists.
  const down = new TypeError("Failed to fetch")
  const answer = await attempt("save that", () => Promise.reject(down))
  assert.equal(answer.ok, false)
  assert.equal("said" in answer, false, "'Failed to fetch' is the network's sentence, not the host's")
  assert.equal(answer.alone, "Couldn't save that.")
  assert.equal(answer.caught, down)
})
