import assert from "node:assert/strict"
import test from "node:test"

import { failureLine, NotLoaded, NOT_DRAWN, NOT_LOADED } from "../src/lib/mermaid-failure.ts"

test("mermaid's own refusal is the line, whatever it refused for", () => {
  const parse = new Error(
    "Parse error on line 3:\n...-->\n------^\nExpecting 'SEMI', 'NEWLINE', got 'EOF'",
  )
  assert.equal(
    failureLine(parse),
    "Parse error on line 3:",
    "a parse error is said in mermaid's words, its first line alone",
  )

  const unknown = new Error(
    "No diagram type detected matching given configuration for text: graph TD\n  A --> B",
  )
  assert.equal(
    failureLine(unknown),
    "No diagram type detected matching given configuration for text: graph TD",
    "and so is a fence mermaid holds no diagram type for",
  )
})

test("a failure that isn't the source's says so, and never blames it", () => {
  const line = failureLine(new NotLoaded(new TypeError("Failed to fetch dynamically imported module")))
  assert.equal(line, NOT_LOADED, "the chunk not arriving is said plainly")
  assert.doesNotMatch(line, /parse|invalid|on line/i, `and blames no source (${line})`)
})

test("anything else falls back to the one fixed sentence", () => {
  assert.equal(failureLine(new TypeError("drawing is not a function")), NOT_DRAWN)
  assert.equal(failureLine(undefined), NOT_DRAWN, "an error with no words at all")
  assert.equal(failureLine(new Error("")), NOT_DRAWN)
})
