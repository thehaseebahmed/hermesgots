/**
 * What the LLM Providers page will send, as a rule: a key form's Save is dead until the field holds
 * something a key could be. An empty field has nothing to write, and a mask — the `***` a short key
 * masks as, a first-four/last-four elision, or a `«redacted…»` sentinel — is what the page was handed
 * rather than a key, so it is never submitted back. The host refuses a mask on its own rule too; this
 * is the screen's half of the same fact, so no tap can even ask.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { submittableKey } from "../src/lib/llm-providers.ts"

test("an empty field, or one holding only spaces, has nothing to send", () => {
  assert.equal(submittableKey(""), false)
  assert.equal(submittableKey("   "), false)
  assert.equal(submittableKey("\n\t "), false)
})

test("a mask is never a key to send", () => {
  assert.equal(submittableKey("***"), false, "what `mask_secret` makes of a short key")
  assert.equal(submittableKey("sk-o...c123"), false, "a first-four, last-four elision")
  assert.equal(
    submittableKey("«redacted:sk-o...c123»"),
    false,
    "the sentinel a Dashboard copy carries",
  )
})

test("something typed is a key, whatever surrounds it", () => {
  assert.equal(submittableKey("new-key-0000-zyxw"), true)
  assert.equal(
    submittableKey("  new-key-0000-zyxw  "),
    true,
    "the field's own spaces are not part of the key",
  )
})
