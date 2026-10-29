import assert from "node:assert/strict"
import test from "node:test"

import { dictationHint } from "../src/lib/dictation-hint.ts"

test("the hint names the chat, its project and its repositories by their last segment", () => {
  assert.equal(
    dictationHint({
      title: "Fix the sync",
      project: "Gots",
      repos: [{ name: "thehaseebahmed/hermesgots" }, { name: "docs" }],
    }),
    "Fix the sync, Gots, hermesgots, docs",
  )
})

test("what the chat lacks is left out", () => {
  assert.equal(dictationHint({ title: "Sky colours" }), "Sky colours")
  assert.equal(dictationHint({}), "")
})
