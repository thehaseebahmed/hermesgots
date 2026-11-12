/**
 * The write wrapper that answers instead of announcing: its answer is what a surface draws, and it
 * reaches no toast at all — which is what makes "draw the failure where it happened" the only way a
 * caller can report one.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { attempt } from "../src/lib/attempt.ts"

test("a write that lands answers ok", async () => {
  assert.deepEqual(await attempt("save that", async () => {}), { ok: true })
})

test("the host's answer is returned, not announced", async () => {
  const answer = await attempt("save that", async () => {
    throw new Error("That bot is running a turn.")
  })
  assert.deepEqual(answer, {
    ok: false,
    said: "That bot is running a turn.",
    alone: "Couldn't save that.",
  })
})

test("a refusal with no words of its own answers alone", async () => {
  const answer = await attempt("save that", async () => {
    throw new Error("   ")
  })
  assert.deepEqual(answer, { ok: false, alone: "Couldn't save that." })
})

test("a refusal that isn't an Error answers alone", async () => {
  const answer = await attempt("remove that", () => Promise.reject("no"))
  assert.deepEqual(answer, { ok: false, alone: "Couldn't remove that." })
})

test("the seam reaches no toast at all", () => {
  const source = readFileSync(new URL("../src/lib/attempt.ts", import.meta.url), "utf8")
  assert.ok(
    !/\btell\b/.test(source),
    "attempt names the toast seam: a failure a surface can draw is not one the app says in passing",
  )
})
