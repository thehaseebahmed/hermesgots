import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { closes, fenceOf, linesOf, unixLength, unixLine, unixLines } from "../src/lib/fences.ts"

const INDENTED = /^ {0,3}(`{3,}|~{3,})(.*)$/
const MARGIN = /^(`{3,}|~{3,})(.*)$/

test("a text's lines come back with the offset each starts at, and the offsets tile it", () => {
  const text = "One.\n\n```mermaid\ngraph TD\n```"
  const { lines, starts } = linesOf(text)
  assert.deepEqual(lines, ["One.", "", "```mermaid", "graph TD", "```"], "every line, in order")
  for (const [i, at] of starts.entries()) assert.equal(text.slice(at, at + lines[i].length), lines[i])
  assert.equal(starts.at(-1) + lines.at(-1).length, text.length, "the last line ends at the end")
})

test("a line is read with the pattern the caller's own rule gives it", () => {
  assert.deepEqual(
    fenceOf("```mermaid", MARGIN),
    { char: "`", length: 3, rest: "mermaid" },
    "a margin fence, and the info string after it",
  )
  assert.equal(fenceOf("  ```mermaid", MARGIN), null, "no indent is what mermaid's rule says")
  assert.deepEqual(
    fenceOf("  ~~~~openui-lang", INDENTED),
    { char: "~", length: 4, rest: "openui-lang" },
    "an indented one, as the block splitter reads it",
  )
  assert.equal(fenceOf("  ~~~~openui-lang", MARGIN), null, "the same line, by the other rule")
  assert.equal(fenceOf("a ` ``` ` in prose", MARGIN), null, "a fence is a line's own beginning")
})

test("a CRLF line is read as its LF twin, and its length counted without the CR", () => {
  assert.equal(unixLine("```mermaid\r"), "```mermaid", "the CR is no part of the line")
  assert.equal(unixLine("```mermaid"), "```mermaid", "and a line without one is itself")
  assert.equal(unixLength("```\r"), 3, "counted without building the slice")
  assert.equal(unixLength("```"), 3)
  assert.deepEqual(
    fenceOf("```mermaid\r", MARGIN),
    { char: "`", length: 3, rest: "mermaid" },
    "the info string carries no CR into the rule",
  )
  assert.equal(unixLines("a\r\nb\rc\n"), "a\nb\nc\n", "a source is read with one line ending")
})

test("a line closes a fence of its own character and length, and nothing else", () => {
  const fence = { char: "`", length: 3 }
  assert.ok(closes("```", fence, MARGIN), "the same fence, and nothing else on the line")
  assert.ok(closes("`````", fence, MARGIN), "a longer one closes a shorter")
  assert.ok(closes("```  ", fence, MARGIN), "trailing space is no content")
  assert.ok(closes("~~~", { char: "~", length: 3 }, MARGIN), "a tilde fence closes a tilde fence")
  assert.equal(closes("``", fence, MARGIN), false, "a shorter one does not")
  assert.equal(closes("~~~", fence, MARGIN), false, "and neither does the other character")
  assert.equal(closes("```mermaid", fence, MARGIN), false, "an opener is not a closer")
  assert.equal(closes("  ```", fence, MARGIN), false, "the caller's pattern decides the indent")
  assert.ok(closes("  ```", fence, INDENTED), "and this caller allows one")
})

test("the scanner touches nothing but the string", () => {
  const raw = readFileSync(new URL("../src/lib/fences.ts", import.meta.url), "utf8")
  const source = raw.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "")
  assert.doesNotMatch(source, /^[ \t]*(?:import|export)\b.*\bfrom\b/m, "no module is reached")
  assert.doesNotMatch(source, /\bimport\s*\(/, "and nothing is loaded on demand")
  assert.doesNotMatch(source, /^[ \t]*import\b/m, "not even for its side effect")
})
